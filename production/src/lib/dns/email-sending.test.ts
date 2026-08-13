import { describe, it, expect } from "vitest";
import {
  checkSendingSpf, checkDkim, checkDmarc, sendingReport,
  countSpfLookups, dkimHost, dmarcHost,
  SPF_LOOKUP_LIMIT, RESEND_DEFAULTS,
} from "./email-sending";

const E = RESEND_DEFAULTS;
const GOOD_SPF = "v=spf1 include:_spf.google.com include:amazonses.com ~all";
const GOOD_DKIM = "v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC";

describe("lookup names", () => {
  it("builds the DKIM and DMARC hostnames", () => {
    expect(dkimHost("Anutech.in", "resend")).toBe("resend._domainkey.anutech.in");
    expect(dmarcHost("Anutech.in")).toBe("_dmarc.anutech.in");
  });
});

describe("countSpfLookups — the limit nobody sees coming", () => {
  it("counts the mechanisms that cost a DNS query", () => {
    expect(countSpfLookups("v=spf1 include:a.com include:b.com ~all")).toBe(2);
    expect(countSpfLookups("v=spf1 a mx include:x.com ~all")).toBe(3);
    expect(countSpfLookups("v=spf1 exists:%{i}.x.com redirect=y.com")).toBe(2);
  });

  it("does not count ip4, ip6 or all — they need no query", () => {
    expect(countSpfLookups("v=spf1 ip4:1.2.3.4 ip6:2001:db8::1 -all")).toBe(0);
  });

  it("counts EVERY qualifier, not just +", () => {
    // The bug this caught: matching only the bare token and `+` missed `-mx`,
    // `~a` and `?include:`. That UNDERCOUNTS, which is the dangerous direction —
    // a domain genuinely at 11 lookups would be reported as within the limit
    // while SPF was already a permerror for every sender.
    expect(countSpfLookups("v=spf1 +include:a.com +mx ~all")).toBe(2);
    expect(countSpfLookups("v=spf1 -include:a.com ~mx ?a -all")).toBe(3);
    expect(countSpfLookups("v=spf1 ?include:a.com ~include:b.com -all")).toBe(2);
  });

  it("still does not count a qualified ip4/ip6/all", () => {
    expect(countSpfLookups("v=spf1 +ip4:1.2.3.4 -ip6:2001:db8::1 ~all")).toBe(0);
  });
});

describe("SPF for sending", () => {
  it("passes a record that authorises the provider", () => {
    const c = checkSendingSpf([GOOD_SPF], E);
    expect(c.state).toBe("pass");
    expect(c.detail).toMatch(/2\/10 DNS lookups/);
  });

  it("reports a missing record with the exact line to publish", () => {
    const c = checkSendingSpf([], E);
    expect(c.state).toBe("missing");
    expect(c.fix).toMatch(/include:amazonses\.com/);
  });

  it("FAILS on two SPF records — the mistake that breaks mail that was working", () => {
    // Adding a provider by publishing a SECOND v=spf1 record is the most common
    // error there is. RFC 7208 makes it a permerror, so SPF then fails for every
    // sender, and it reads as "I added a record and all my mail broke".
    const c = checkSendingSpf([
      "v=spf1 include:_spf.google.com ~all",
      "v=spf1 include:amazonses.com ~all",
    ], E);
    expect(c.state).toBe("fail");
    expect(c.detail).toMatch(/2 SPF records/);
    expect(c.fix).toMatch(/Merge them into ONE/);
  });

  it("FAILS past the ten-lookup limit, and says the excess is ignored", () => {
    const spf = "v=spf1 " + Array.from({ length: 11 }, (_, i) => `include:s${i}.com`).join(" ") + " ~all";
    const c = checkSendingSpf([spf], E);
    expect(c.state).toBe("fail");
    expect(c.detail).toMatch(new RegExp(`over the limit of ${SPF_LOOKUP_LIMIT}`));
  });

  it("WARNS when sitting exactly on the limit, before the next service breaks it", () => {
    // A domain on Google Workspace plus a couple of services is often at 9 or 10.
    // The failure lands weeks later when someone adds one more include, and nobody
    // connects the two.
    const inc = Array.from({ length: SPF_LOOKUP_LIMIT - 1 }, (_, i) => `include:s${i}.com`).join(" ");
    const c = checkSendingSpf([`v=spf1 ${inc} include:amazonses.com ~all`], E);
    expect(c.state).toBe("warn");
    expect(c.fix).toMatch(/Adding one more service will break SPF/);
  });

  it("FAILS when SPF exists but does not authorise the provider", () => {
    const c = checkSendingSpf(["v=spf1 include:_spf.google.com ~all"], E);
    expect(c.state).toBe("fail");
    expect(c.fix).toMatch(/do NOT publish a second SPF record/i);
  });

  it("reports the WORST problem, not a list — a permerror cannot be fixed by adding an include", () => {
    const c = checkSendingSpf([
      "v=spf1 include:_spf.google.com ~all",
      "v=spf1 ip4:1.2.3.4 ~all",
    ], E);
    expect(c.detail).toMatch(/2 SPF records/);
    expect(c.detail).not.toMatch(/does not authorise/);
  });

  it("ignores non-SPF TXT records sharing the name", () => {
    const c = checkSendingSpf(["google-site-verification=abc", GOOD_SPF, "some other txt"], E);
    expect(c.state).toBe("pass");
  });
});

describe("DKIM", () => {
  it("passes a published key", () => {
    expect(checkDkim([GOOD_DKIM], E).state).toBe("pass");
  });

  it("reports a missing record at the selector", () => {
    const c = checkDkim([], E);
    expect(c.state).toBe("missing");
    expect(c.fix).toMatch(/resend\._domainkey/);
  });

  it("FAILS on an empty p= — a published REVOCATION that a presence check would pass", () => {
    // The record exists, so "is there a DKIM record?" answers yes while every
    // signature fails.
    for (const rec of ["v=DKIM1; k=rsa; p=", "v=DKIM1; p=;", "v=DKIM1; p=   "]) {
      const c = checkDkim([rec], E);
      expect(c.state, rec).toBe("fail");
      expect(c.detail).toMatch(/REVOKED/);
    }
  });

  it("suggests re-copying, because long keys get truncated when pasted", () => {
    expect(checkDkim(["v=DKIM1; k=rsa; p="], E).fix).toMatch(/truncated when pasted/);
  });

  it("ignores unrelated TXT records at the name", () => {
    expect(checkDkim(["some-unrelated-value", GOOD_DKIM], E).state).toBe("pass");
  });
});

describe("DMARC", () => {
  it("warns when absent, without claiming mail is broken", () => {
    const c = checkDmarc([]);
    expect(c.state).toBe("warn");
    expect(c.detail).toMatch(/Mail still sends/);
  });

  it("passes p=none, which is the safe starting policy", () => {
    expect(checkDmarc(["v=DMARC1; p=none; rua=mailto:x@y.z"]).state).toBe("pass");
  });

  it("warns on a strict policy, because it silently bins real mail when alignment fails", () => {
    for (const p of ["reject", "quarantine"]) {
      const c = checkDmarc([`v=DMARC1; p=${p}`]);
      expect(c.state, p).toBe("warn");
      expect(c.detail).toMatch(p === "reject" ? /rejected outright/ : /sent to spam/);
    }
  });
});

describe("sendingReport", () => {
  it("says the domain can send when SPF and DKIM are right", () => {
    const r = sendingReport("anutech.in", [GOOD_SPF], [GOOD_DKIM], ["v=DMARC1; p=none"]);
    expect(r.canSend).toBe(true);
    expect(r.state).toBe("pass");
  });

  it("does NOT block sending on a missing DMARC record", () => {
    // A missing DMARC does not stop mail leaving, so it must not gate the
    // switchover away from the shared From address.
    const r = sendingReport("anutech.in", [GOOD_SPF], [GOOD_DKIM], []);
    expect(r.canSend).toBe(true);
    expect(r.state).toBe("warn");
  });

  it("blocks on a broken SPF or a revoked DKIM", () => {
    expect(sendingReport("x.in", ["v=spf1 ~all", "v=spf1 ~all"], [GOOD_DKIM], []).canSend).toBe(false);
    expect(sendingReport("x.in", [GOOD_SPF], ["v=DKIM1; p="], []).canSend).toBe(false);
    expect(sendingReport("x.in", [], [], []).canSend).toBe(false);
  });

  it("still allows sending while SPF sits on the lookup limit", () => {
    const inc = Array.from({ length: SPF_LOOKUP_LIMIT - 1 }, (_, i) => `include:s${i}.com`).join(" ");
    const r = sendingReport("x.in", [`v=spf1 ${inc} include:amazonses.com ~all`], [GOOD_DKIM], ["v=DMARC1; p=none"]);
    expect(r.canSend).toBe(true);
    expect(r.state).toBe("warn");
  });

  it("takes the provider from the caller rather than assuming Resend", () => {
    // Provider records change. A checker that hardcodes last year's values reports
    // a healthy domain as broken.
    const custom = { spfInclude: "spf.mailgun.org", dkimSelector: "mg", providerName: "Mailgun" };
    const r = sendingReport(
      "x.in",
      ["v=spf1 include:spf.mailgun.org ~all"],
      [GOOD_DKIM],
      [],
      custom,
    );
    expect(r.provider).toBe("Mailgun");
    expect(r.canSend).toBe(true);
    expect(dkimHost("x.in", custom.dkimSelector)).toBe("mg._domainkey.x.in");
  });

  it("gives every non-passing check a next step (§24)", () => {
    const r = sendingReport("x.in", [], [], []);
    for (const c of r.checks) {
      if (c.state === "pass") continue;
      expect(c.fix, c.id).toBeTruthy();
    }
  });
});
