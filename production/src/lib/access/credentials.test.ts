import { describe, it, expect } from "vitest";
import {
  credentialFindings, looksLikeSecret, worstRisk,
  ROTATION_DAYS, EXPIRY_LADDER, type CredentialRow,
} from "./credentials";

const TODAY = "2026-08-14";

const row = (over: Partial<CredentialRow> = {}): CredentialRow => ({
  id: "c1",
  label: "GST portal",
  kind: "statutory",
  holder_name: "Pardeep Sharma",
  holder_employee_id: "e1",
  holder_active: true,
  stored_in: "Bitwarden (Anutech org)",
  last_rotated_on: "2026-08-01",
  expires_on: null,
  holder_count: 2,
  notes: null,
  ...over,
});

const codes = (rows: CredentialRow[]) => credentialFindings(rows, TODAY).map((f) => f.code);

describe("a healthy credential produces no findings", () => {
  it("says nothing when everything is in order", () => {
    expect(credentialFindings([row()], TODAY)).toEqual([]);
  });

  it("handles an empty register", () => {
    expect(credentialFindings([], TODAY)).toEqual([]);
    expect(worstRisk([])).toBe("none");
  });
});

describe("expiry — the DSC and token case", () => {
  it("flags an expired credential as critical", () => {
    const [f] = credentialFindings([row({ expires_on: "2026-08-01" })], TODAY);
    expect(f.code).toBe("expired");
    expect(f.risk).toBe("critical");
    expect(f.message).toMatch(/13 days ago/);
  });

  it("escalates as the date approaches, using the documented ladder", () => {
    const at = (days: number) => {
      const d = new Date(Date.parse(TODAY) + days * 86_400_000).toISOString().slice(0, 10);
      return credentialFindings([row({ expires_on: d })], TODAY)[0];
    };
    expect(at(EXPIRY_LADDER[0]).risk).toBe("medium");      // 30 days
    expect(at(EXPIRY_LADDER[1]).risk).toBe("high");        // 15 days
    expect(at(EXPIRY_LADDER[2]).risk).toBe("critical");    // 7 days
    expect(at(0).risk).toBe("critical");
    expect(at(0).message).toMatch(/today/);
  });

  it("stays quiet outside the warning window", () => {
    const far = new Date(Date.parse(TODAY) + 200 * 86_400_000).toISOString().slice(0, 10);
    expect(codes([row({ expires_on: far })])).not.toContain("expiring");
  });

  it("tells you to start now, because portal renewals are not same-day", () => {
    const soon = new Date(Date.parse(TODAY) + 5 * 86_400_000).toISOString().slice(0, 10);
    expect(credentialFindings([row({ expires_on: soon })], TODAY)[0].action).toMatch(/days, not minutes/);
  });

  it("ignores an unparseable date instead of throwing", () => {
    expect(() => credentialFindings([row({ expires_on: "someday" })], TODAY)).not.toThrow();
    expect(codes([row({ expires_on: "someday" })])).not.toContain("expired");
  });
});

describe("orphaned credentials — what only a register can find", () => {
  it("flags a credential whose only holder has left, as critical", () => {
    // The real reason to keep a register: a live bank or portal login whose named
    // holder is no longer with the business, which no password manager notices.
    const [f] = credentialFindings([row({ holder_active: false, holder_name: "Deepak Sharma" })], TODAY);
    expect(f.code).toBe("orphaned");
    expect(f.risk).toBe("critical");
    expect(f.message).toMatch(/Deepak Sharma/);
    expect(f.action).toMatch(/Change the secret/);
  });

  it("does not flag an active holder", () => {
    expect(codes([row({ holder_active: true })])).not.toContain("orphaned");
  });

  it("does not flag when there is no employee link at all", () => {
    // A vendor-held credential has no employee record; absence is not departure.
    expect(codes([row({ holder_employee_id: null, holder_active: null })])).not.toContain("orphaned");
  });
});

describe("rotation", () => {
  it("flags a credential with no rotation date at all", () => {
    const [f] = credentialFindings([row({ last_rotated_on: null })], TODAY);
    expect(f.code).toBe("never_rotated");
    expect(f.message).toMatch(/nobody knows how old/);
  });

  it("flags one past the rotation target", () => {
    const old = new Date(Date.parse(TODAY) - (ROTATION_DAYS + 30) * 86_400_000).toISOString().slice(0, 10);
    expect(codes([row({ last_rotated_on: old })])).toContain("rotation_overdue");
  });

  it("escalates to high past double the target", () => {
    const ancient = new Date(Date.parse(TODAY) - ROTATION_DAYS * 2.5 * 86_400_000).toISOString().slice(0, 10);
    const f = credentialFindings([row({ last_rotated_on: ancient })], TODAY).find((x) => x.code === "rotation_overdue")!;
    expect(f.risk).toBe("high");
  });

  it("stays quiet inside the target", () => {
    const recent = new Date(Date.parse(TODAY) - 30 * 86_400_000).toISOString().slice(0, 10);
    expect(codes([row({ last_rotated_on: recent })])).not.toContain("rotation_overdue");
  });
});

describe("location and access breadth", () => {
  it("flags a credential with no recorded location as high", () => {
    for (const v of [null, "", "   "]) {
      const f = credentialFindings([row({ stored_in: v })], TODAY).find((x) => x.code === "no_location");
      expect(f, String(v)).toBeTruthy();
      expect(f!.risk).toBe("high");
    }
  });

  it("flags a single point of failure", () => {
    const f = credentialFindings([row({ holder_count: 1 })], TODAY).find((x) => x.code === "single_holder");
    expect(f).toBeTruthy();
    expect(f!.action).toMatch(/locked out/);
  });

  it("does not flag when two or more people have access", () => {
    expect(codes([row({ holder_count: 2 })])).not.toContain("single_holder");
  });

  it("does not guess when the holder count is unknown", () => {
    expect(codes([row({ holder_count: null })])).not.toContain("single_holder");
  });
});

describe("looksLikeSecret — the one hole in a metadata-only design", () => {
  it("catches named provider key prefixes", () => {
    for (const s of [
      "key is rzp_live_abc123", "AIzaSyD-abcdefghij", "sk_live_51H",
      "ghp_16C7e42F292c69", "xoxb-123-456", "AKIAIOSFODNN7EXAMPLE",
      "eyJhbGciOiJIUzI1NiJ9", "-----BEGIN RSA PRIVATE KEY-----",
    ]) {
      expect(looksLikeSecret(s), s).toBe(true);
    }
  });

  it("catches a labelled password, however it is written", () => {
    for (const s of [
      "password: hunter2", "Password = Anutech@2026", "pwd - abc123",
      "PIN: 4417", "otp = 998877", "api key: zzz", "api_key=zzz", "secret : shh",
    ]) {
      expect(looksLikeSecret(s), s).toBe(true);
    }
  });

  it("catches a long high-entropy run with no label", () => {
    expect(looksLikeSecret("Xk9#mQ2vLp8@Tz4wRn6!Bs")).toBe(true);
  });

  it("lets ordinary notes through", () => {
    for (const s of [
      "Held by the finance team, renewed every April.",
      "Login is at https://services.gst.gov.in/services/login and needs the DSC.",
      "Ask Hitesh before changing this — it breaks the nightly export.",
      "Two-factor is on the shared phone in the office drawer.",
      null, undefined, "", "   ",
    ]) {
      expect(looksLikeSecret(s), String(s)).toBe(false);
    }
  });

  it("does not trip on a long URL", () => {
    expect(looksLikeSecret("https://portal.example.co.in/session/renew?ref=aaaaaaaaaaaaaaaaaaaaaaaa")).toBe(false);
  });

  it("reports a secret in notes as CRITICAL, and says why it matters", () => {
    const f = credentialFindings([row({ notes: "password: Anutech@2026" })], TODAY)[0];
    expect(f.code).toBe("secret_in_notes");
    expect(f.risk).toBe("critical");
    expect(f.action).toMatch(/readable by the whole workspace/);
  });
});

describe("ordering and rollup", () => {
  it("puts the worst first, and the soonest expiry ahead of a later one", () => {
    const soon = new Date(Date.parse(TODAY) + 3 * 86_400_000).toISOString().slice(0, 10);
    const later = new Date(Date.parse(TODAY) + 25 * 86_400_000).toISOString().slice(0, 10);
    const f = credentialFindings([
      row({ id: "b", label: "Bank token", expires_on: later }),
      row({ id: "a", label: "DSC", expires_on: soon }),
      row({ id: "c", label: "Stale", last_rotated_on: "2024-01-01" }),
    ], TODAY);
    expect(f[0].label).toBe("DSC");
    expect(f[0].risk).toBe("critical");
  });

  it("rolls up to the worst risk present", () => {
    expect(worstRisk(credentialFindings([row({ holder_active: false })], TODAY))).toBe("critical");
    expect(worstRisk(credentialFindings([row({ stored_in: null })], TODAY))).toBe("high");
    expect(worstRisk(credentialFindings([row({ last_rotated_on: null })], TODAY))).toBe("medium");
    expect(worstRisk(credentialFindings([row()], TODAY))).toBe("none");
  });

  it("reports every problem on one credential, not just the first", () => {
    const f = credentialFindings([row({
      holder_active: false, stored_in: null, last_rotated_on: null,
      holder_count: 1, notes: "password: x9$Kd2Lm",
    })], TODAY);
    expect(new Set(f.map((x) => x.code))).toEqual(
      new Set(["orphaned", "no_location", "never_rotated", "single_holder", "secret_in_notes"])
    );
  });

  it("gives every finding a message AND a next step (§24)", () => {
    const f = credentialFindings([row({
      holder_active: false, stored_in: null, last_rotated_on: null, holder_count: 1,
      expires_on: "2026-08-01", notes: "pin: 1234",
    })], TODAY);
    expect(f.length).toBeGreaterThan(0);
    for (const x of f) {
      expect(x.message.length, x.code).toBeGreaterThan(0);
      expect(x.action.length, x.code).toBeGreaterThan(0);
    }
  });
});
