import { describe, it, expect } from "vitest";
import {
  parseMx, normaliseHost, normaliseTxt,
  checkMx, checkVerificationTxt, checkSpf, overallState,
} from "./workspace-dns";

const mx = (s: string) => parseMx(s)!;

describe("normalisation — DNS answers are never tidy", () => {
  it("strips the trailing dot and lower-cases", () => {
    expect(normaliseHost("ASPMX.L.GOOGLE.COM.")).toBe("aspmx.l.google.com");
    expect(normaliseHost("  Smtp.Google.Com  ")).toBe("smtp.google.com");
  });

  it("parses an MX rdata string", () => {
    expect(parseMx("1 smtp.google.com.")).toEqual({ priority: 1, host: "smtp.google.com" });
    expect(parseMx("10 ALT4.ASPMX.L.GOOGLE.COM.")).toEqual({ priority: 10, host: "alt4.aspmx.l.google.com" });
  });

  it("rejects rdata that is not an MX", () => {
    for (const junk of ["", "smtp.google.com", "abc smtp.google.com", "1", "1 ."]) {
      expect(parseMx(junk)).toBeNull();
    }
  });

  it("unwraps quoted TXT and rejoins split chunks", () => {
    expect(normaliseTxt('"v=spf1 include:_spf.google.com ~all"')).toBe("v=spf1 include:_spf.google.com ~all");
    // DNS splits strings over 255 bytes into adjacent quoted chunks.
    expect(normaliseTxt('"google-site-verification=abc" "def"')).toBe("google-site-verification=abcdef");
  });
});

describe("checkMx — both published layouts are correct", () => {
  it("passes the current single-host layout", () => {
    const r = checkMx([mx("1 smtp.google.com.")]);
    expect(r.state).toBe("pass");
  });

  it("passes the legacy five-host layout", () => {
    // A checker that only knows the modern layout would call this broken — and a
    // false alarm on someone's live mail invites them to "fix" what works.
    const r = checkMx([
      mx("1 aspmx.l.google.com."), mx("5 alt1.aspmx.l.google.com."), mx("5 alt2.aspmx.l.google.com."),
      mx("10 alt3.aspmx.l.google.com."), mx("10 alt4.aspmx.l.google.com."),
    ]);
    expect(r.state).toBe("pass");
    expect(r.detail).toContain("still fully supported");
  });

  it("reports missing when there are no MX records at all", () => {
    const r = checkMx([]);
    expect(r.state).toBe("missing");
    expect(r.expected).toEqual(["1 smtp.google.com"]);
  });

  it("FAILS when mail points at another provider", () => {
    const r = checkMx([mx("10 mail.protection.outlook.com.")]);
    expect(r.state).toBe("fail");
    expect(r.detail).toContain("somewhere else");
  });

  // ── The fault that actually loses email ──────────────────────────────────
  it("FAILS when a leftover MX sits alongside Google's", () => {
    // This is the common real-world break: the old provider is never removed, so
    // a share of mail keeps going there and it looks like Workspace losing email.
    const r = checkMx([mx("1 smtp.google.com."), mx("20 mail.oldhost.in.")]);
    expect(r.state).toBe("fail");
    expect(r.detail).toContain("split between the two");
    expect(r.found).toContain("20 mail.oldhost.in");
  });

  it("warns on the right host at the wrong priority — mail still works", () => {
    const r = checkMx([mx("5 smtp.google.com.")]);
    expect(r.state).toBe("warn");
    expect(r.detail).toContain("still work");
  });

  it("warns when the legacy layout is incomplete, and says which are missing", () => {
    const r = checkMx([mx("1 aspmx.l.google.com."), mx("5 alt1.aspmx.l.google.com.")]);
    expect(r.state).toBe("warn");
    expect(r.expected).toEqual(["5 alt2.aspmx.l.google.com", "10 alt3.aspmx.l.google.com", "10 alt4.aspmx.l.google.com"]);
  });

  it("accepts googlemail.com hosts as Google", () => {
    expect(checkMx([mx("1 aspmx2.googlemail.com.")]).state).not.toBe("fail");
  });
});

describe("checkVerificationTxt", () => {
  const TOKEN = "abc123XYZ";
  const rec = (v: string) => `"${v}"`;

  it("passes when the token matches", () => {
    const r = checkVerificationTxt([rec(`google-site-verification=${TOKEN}`)], TOKEN);
    expect(r.state).toBe("pass");
  });

  it("is case-insensitive about the prefix", () => {
    const r = checkVerificationTxt([rec(`GOOGLE-SITE-VERIFICATION=${TOKEN}`)], TOKEN);
    expect(r.state).toBe("pass");
  });

  it("reports missing when no token is present", () => {
    const r = checkVerificationTxt([rec("v=spf1 include:_spf.google.com ~all")], TOKEN);
    expect(r.state).toBe("missing");
    expect(r.expected).toEqual([`google-site-verification=${TOKEN}`]);
  });

  // ── The mistake this catches that a human rarely spots ────────────────────
  it("FAILS when a token is present but belongs to another domain", () => {
    // Copying the previous customer's token is a real and very confusing error:
    // the record looks right, and Google simply never verifies.
    const r = checkVerificationTxt([rec("google-site-verification=someoneElsesToken")], TOKEN);
    expect(r.state).toBe("fail");
    expect(r.detail).toContain("different customer");
  });

  it("warns rather than passes when no expected token was supplied", () => {
    // Claiming a pass here would be a guess dressed as a verification.
    const r = checkVerificationTxt([rec("google-site-verification=whatever")], null);
    expect(r.state).toBe("warn");
  });

  it("finds the token among many unrelated TXT records", () => {
    const r = checkVerificationTxt([
      rec("v=spf1 -all"), rec("MS=ms12345"), rec(`google-site-verification=${TOKEN}`),
    ], TOKEN);
    expect(r.state).toBe("pass");
  });
});

describe("checkSpf", () => {
  const rec = (v: string) => `"${v}"`;

  it("passes a single record that includes Google", () => {
    expect(checkSpf([rec("v=spf1 include:_spf.google.com ~all")]).state).toBe("pass");
  });

  it("reports missing when there is no SPF at all", () => {
    const r = checkSpf([rec("google-site-verification=x")]);
    expect(r.state).toBe("missing");
    expect(r.expected).toEqual(["v=spf1 include:_spf.google.com ~all"]);
  });

  // ── Why this is a FAIL and not a warning ─────────────────────────────────
  it("FAILS on two SPF records", () => {
    // RFC 7208 §3.2: more than one SPF record is a permerror, so receivers may
    // reject outright. Mail stops working rather than degrading.
    const r = checkSpf([rec("v=spf1 include:_spf.google.com ~all"), rec("v=spf1 include:zoho.com ~all")]);
    expect(r.state).toBe("fail");
    expect(r.detail).toContain("RFC 7208");
  });

  it("FAILS when SPF exists but does not authorise Google, and says not to add a second", () => {
    const r = checkSpf([rec("v=spf1 include:zoho.com ~all")]);
    expect(r.state).toBe("fail");
    expect(r.detail).toContain("do not add a second record");
  });
});

describe("overallState — worst wins", () => {
  const c = (state: "pass" | "warn" | "fail" | "missing") =>
    ({ id: "mx" as const, label: "", state, detail: "" });

  it("fail beats everything", () => {
    expect(overallState([c("pass"), c("missing"), c("fail")])).toBe("fail");
  });

  it("missing beats warn", () => {
    expect(overallState([c("pass"), c("warn"), c("missing")])).toBe("missing");
  });

  it("all pass is a pass", () => {
    expect(overallState([c("pass"), c("pass")])).toBe("pass");
  });
});
