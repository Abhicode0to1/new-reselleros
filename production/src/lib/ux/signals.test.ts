import { describe, it, expect } from "vitest";
import { maskPII, normalisePath, surfaceFor, sanitizeEvent, isRageClick, aggregate, findings, sanitizeInsights, basicInsight, type RowIn } from "./signals";

describe("privacy — nothing personal leaves the browser", () => {
  it("masks emails, phones, GSTIN, PAN and long numbers", () => {
    expect(maskPII("Mail ramesh@sharma.in or call +91 98765 43210")).toBe("Mail [email] or call [number]");
    expect(maskPII("GSTIN 27AAPFU0939F1ZV PAN ABCDE1234F")).toBe("GSTIN [gstin] PAN [pan]");
    expect(maskPII("Invoice 123456")).toBe("Invoice [number]");
    expect(maskPII("Save draft")).toBe("Save draft");
  });
  it("server re-sanitises: bad kinds dropped, ids collapsed, PII masked again", () => {
    expect(sanitizeEvent({ kind: "keystroke", path: "/x" })).toBeNull();
    expect(sanitizeEvent({ kind: "dead_click", path: "/quotes/Q-FBB9-27-0006?x=1", target: "Call 9876543210" }))
      .toEqual({ kind: "dead_click", path: "/quotes/[id]", target: "Call [number]", detail: null, ms: null });
  });
});

describe("paths and surfaces", () => {
  it("groups ids into one page", () => {
    expect(normalisePath("/leads/L-MUM1MSBTAK")).toBe("/leads/[id]");
    expect(normalisePath("/customers/0b5c3c1e-2f7a-4f8e-9a51-3b1f6b7d9e10/edit")).toBe("/customers/[id]/edit");
    expect(normalisePath("/settings")).toBe("/settings");
  });
  it("tells the website from the app", () => {
    expect(surfaceFor("/")).toBe("site");
    expect(surfaceFor("/buy/workspace")).toBe("site");
    expect(surfaceFor("/quotes/new")).toBe("app");
  });
});

describe("rage clicks", () => {
  it("3 clicks inside 1.2 s", () => {
    expect(isRageClick([0, 300, 700])).toBe(true);
    expect(isRageClick([0, 900, 2000])).toBe(false);
    expect(isRageClick([0, 300])).toBe(false);
  });
});

const row = (over: Partial<RowIn>): RowIn => ({ kind: "view", path: "/quotes/new", target: null, detail: null, ms: null, session_id: "s1", surface: "app", ...over });

describe("aggregate → findings: no problem without a number behind it", () => {
  const rows: RowIn[] = [
    ...["a", "b", "c", "d", "e"].map((s) => row({ session_id: s })),
    row({ kind: "rage_click", target: "Save draft", session_id: "a" }),
    row({ kind: "rage_click", target: "Save draft", session_id: "b" }),
    ...[1, 2, 3].map((i) => row({ kind: "dead_click", target: "Lead ID: L-…", session_id: `d${i}` })),
    row({ kind: "error", detail: "Pick the customer's state first", session_id: "c" }),
    row({ kind: "form_abandon", target: "Prospect Details", session_id: "a" }),
    row({ kind: "slow", ms: 4200 }), row({ kind: "slow", ms: 3800 }), row({ kind: "slow", ms: 5000 }),
  ];
  it("counts per page", () => {
    const [s] = aggregate(rows);
    expect(s).toMatchObject({ path: "/quotes/new", views: 5, rage: [{ target: "Save draft", n: 2 }], slowMsP50: 4200 });
    expect(s.sessions).toBe(9); // a–e, d1–d3, and s1 (the slow rows)
  });
  it("turns counts into findings, and skips one-offs below threshold", () => {
    const f = findings(aggregate(rows));
    const sig = f.map((x) => x.signal);
    expect(sig).toContain("rage:Save draft");
    expect(sig).toContain("dead:Lead ID: L-…");
    expect(sig).toContain("error:Pick the customer's state first");
    expect(sig).toContain("slow");
    expect(sig.some((s) => s.startsWith("abandon:"))).toBe(false); // 1 abandon < threshold 2
  });
  it("the AI may only speak to real findings", () => {
    const f = findings(aggregate(rows));
    const out = sanitizeInsights({ insights: [
      { path: "/quotes/new", surface: "app", signal: "rage:Save draft", severity: "high", category: "confusing", problem: "They expect a saved message", fix: "Show Saved ✓ next to the button" },
      { path: "/made-up", surface: "app", signal: "rage:Ghost", severity: "high", category: "broken", problem: "x", fix: "y" },
      { path: "/quotes/new", surface: "app", signal: "slow", severity: "extreme", category: "weird", problem: "Slow", fix: "Lazy-load the catalog" },
    ] }, f);
    expect(out.map((i) => i.signal)).toEqual(["rage:Save draft", "slow"]);
    expect(out[0].evidence).toMatch(/2 rage-click bursts/);
    expect(out[1]).toMatchObject({ severity: "medium", category: "confusing" });
  });
  it("without AI there is still a readable insight", () => {
    const [first] = findings(aggregate(rows));
    expect(basicInsight(first).fix.length).toBeGreaterThan(10);
  });
});
