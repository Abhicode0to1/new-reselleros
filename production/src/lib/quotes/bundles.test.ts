import { describe, it, expect } from "vitest";
import { SOLUTION_BUNDLES, resolveBundle, bundleGapMessage, type SolutionBundle } from "./bundles";
import type { Item } from "@/lib/supabase/database.types";

const it_ = (over: Partial<Item> & Pick<Item, "name" | "vendor">): Item => ({
  id: over.name, tenant_id: "t1", kind: "main", item_type: "subscription", hsn: null,
  msrp: 100, wholesale: 50, prices: {}, margin_pct: 0, is_active: true,
  is_partner_visible: false, partner_price: null, synced_from_partner_id: null,
  created_at: "2026-01-01T00:00:00Z",
  ...over,
} as Item);

const SECURE = SOLUTION_BUNDLES.find((b) => b.id === "secure-workspace")!;

const FULL_CATALOG: Item[] = [
  it_({ name: "Google Workspace Business Starter", vendor: "google",  msrp: 270 }),
  it_({ name: "Acronis Cyber Backup",              vendor: "other",   msrp: 150 }),
  it_({ name: "SSL Certificate (DV, 1 year)",      vendor: "other",   msrp: 900 }),
];

describe("resolveBundle — the happy path", () => {
  it("finds all three components and sizes them", () => {
    const r = resolveBundle(SECURE, FULL_CATALOG, 25);
    expect(r.complete).toBe(true);
    expect(r.unresolved).toEqual([]);
    expect(r.resolved.map((x) => [x.component.label, x.qty])).toEqual([
      ["Google Workspace", 25],
      ["Backup", 25],
      ["SSL certificate", 1],   // fixedQty — a site needs one cert, not one per seat
    ]);
  });

  it("never invents a product — every line comes from the catalogue", () => {
    const r = resolveBundle(SECURE, FULL_CATALOG, 10);
    for (const x of r.resolved) expect(FULL_CATALOG).toContain(x.item);
  });
});

describe("what it MISSED is reported, never silently dropped", () => {
  it("names a component the tenant does not stock", () => {
    /* A bundle that quietly drops SSL produces a quote that looks complete and
       under-sells by one product. */
    const noSsl = FULL_CATALOG.filter((i) => !i.name.includes("SSL"));
    const r = resolveBundle(SECURE, noSsl, 10);
    expect(r.resolved).toHaveLength(2);
    expect(r.unresolved).toHaveLength(1);
    expect(r.unresolved[0]).toMatchObject({ reason: "not_in_catalog" });
    expect(r.unresolved[0].component.label).toBe("SSL certificate");
  });

  it("stays COMPLETE when only an optional component is missing", () => {
    const noSsl = FULL_CATALOG.filter((i) => !i.name.includes("SSL"));
    expect(resolveBundle(SECURE, noSsl, 10).complete).toBe(true);
  });

  it("is INCOMPLETE when a required component is missing", () => {
    const noBackup = FULL_CATALOG.filter((i) => !i.name.includes("Backup"));
    expect(resolveBundle(SECURE, noBackup, 10).complete).toBe(false);
  });

  it("returns zero lines rather than presenting an empty quote as a filled one", () => {
    const r = resolveBundle(SECURE, [], 10);
    expect(r.resolved).toEqual([]);
    expect(r.complete).toBe(false);
    expect(r.unresolved).toHaveLength(3);
  });

  it("ignores inactive catalogue rows", () => {
    const archived = FULL_CATALOG.map((i) => i.name.includes("Backup") ? { ...i, is_active: false } : i);
    expect(resolveBundle(SECURE, archived, 10).complete).toBe(false);
  });
});

describe("several matches", () => {
  it("picks the CHEAPEST when one is strictly cheaper", () => {
    const two = [...FULL_CATALOG, it_({ name: "Veeam Backup", vendor: "other", msrp: 90 })];
    const r = resolveBundle(SECURE, two, 10);
    expect(r.resolved.find((x) => x.component.label === "Backup")!.item.name).toBe("Veeam Backup");
  });

  it("REFUSES an exact price tie instead of taking the first row", () => {
    /* Two rows at the same price are two different products; picking either one
       decides what the customer receives. */
    const tied = [...FULL_CATALOG, it_({ name: "Veeam Backup", vendor: "other", msrp: 150 })];
    const r = resolveBundle(SECURE, tied, 10);
    const amb = r.unresolved.find((u) => u.component.label === "Backup")!;
    expect(amb.reason).toBe("ambiguous");
    expect(amb.candidates).toEqual(["Acronis Cyber Backup", "Veeam Backup"]);
    expect(r.complete).toBe(false);
  });

  it("honours the vendor restriction", () => {
    // A Zoho row containing "workspace" must not satisfy the Google component.
    const r = resolveBundle(SECURE, [
      it_({ name: "Zoho Workspace Standard", vendor: "zoho", msrp: 105 }),
      it_({ name: "Acronis Cyber Backup",    vendor: "other", msrp: 150 }),
    ], 10);
    expect(r.unresolved.some((u) => u.component.label === "Google Workspace")).toBe(true);
  });
});

describe("seat counts", () => {
  it.each([[0, 1], [-4, 1], [7.9, 7]])("%s seats → qty %s on per-seat components", (seats, qty) => {
    const r = resolveBundle(SECURE, FULL_CATALOG, seats);
    expect(r.resolved.find((x) => x.component.label === "Backup")!.qty).toBe(qty);
  });
});

describe("bundleGapMessage — §24, name the gap and the next step", () => {
  it("is null when nothing was missed", () => {
    expect(bundleGapMessage(resolveBundle(SECURE, FULL_CATALOG, 10))).toBeNull();
  });

  it("tells the rep where to go, not just that something failed", () => {
    const noSsl = FULL_CATALOG.filter((i) => !i.name.includes("SSL"));
    const msg = bundleGapMessage(resolveBundle(SECURE, noSsl, 10))!;
    expect(msg).toContain("SSL certificate");
    // Names the nav entry as it actually reads at /items — a pointer to a page the
    // user cannot find is the dead end §24 exists to prevent.
    expect(msg).toMatch(/Catalog & Products/);
  });

  it("names the tied rows so the rep can tell them apart", () => {
    const tied = [...FULL_CATALOG, it_({ name: "Veeam Backup", vendor: "other", msrp: 150 })];
    const msg = bundleGapMessage(resolveBundle(SECURE, tied, 10))!;
    expect(msg).toContain("Acronis Cyber Backup");
    expect(msg).toContain("Veeam Backup");
  });
});

describe("the bundle definitions themselves", () => {
  it("every bundle has a required component — an all-optional package is not a package", () => {
    for (const b of SOLUTION_BUNDLES) {
      expect(b.components.some((c) => c.required), b.name).toBe(true);
    }
  });

  it("every bundle explains itself in the rep's words", () => {
    for (const b of SOLUTION_BUNDLES) expect(b.pitch.length).toBeGreaterThan(30);
  });

  it("ids are unique", () => {
    const ids = SOLUTION_BUNDLES.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("no component matches everything — an empty keyword list would add a random row", () => {
    for (const b of SOLUTION_BUNDLES) {
      for (const c of b.components) expect(c.keywords.length, `${b.name}/${c.label}`).toBeGreaterThan(0);
    }
  });
});

describe("a custom bundle resolves the same way", () => {
  const custom: SolutionBundle = {
    id: "x", name: "X", pitch: "A locally defined package for a specific customer ask.",
    components: [{ label: "Hosting", keywords: ["hosting"], vendors: ["hosting"], required: true }],
  };

  it("matches on vendor plus keyword", () => {
    const r = resolveBundle(custom, [it_({ name: "Shared Hosting 10GB", vendor: "hosting", msrp: 400 })], 3);
    expect(r.complete).toBe(true);
    expect(r.resolved[0].qty).toBe(3);
  });
});
