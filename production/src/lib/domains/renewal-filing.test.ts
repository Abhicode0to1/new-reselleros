import { describe, it, expect } from "vitest";
import {
  decideRenewalFiling,
  istDateToEpochSeconds,
  type QuotePaymentState,
} from "./renewal-filing";

const TERM = "2026-09-21";
const TERM_EPOCH = istDateToEpochSeconds(TERM)!;
const DAY = 86_400;
const YEAR = 365 * DAY;

const ask = (o: Partial<Parameters<typeof decideRenewalFiling>[0]> = {}) =>
  decideRenewalFiling({
    renewalStatus: "quoted",
    quotePayment: "received",
    years: 1,
    fromExpiresAt: TERM,
    liveExpiryEpochSeconds: TERM_EPOCH,
    liveOrderId: "123456",
    ...o,
  });

describe("istDateToEpochSeconds", () => {
  it("is IST midnight, not UTC midnight", () => {
    /* 05:30 apart. A UTC midnight would put the day boundary at 05:30 local, so a
       renewal quoted on the expiry date itself could compare a day out. */
    const utcMidnight = Date.UTC(2026, 8, 21) / 1000;
    expect(istDateToEpochSeconds("2026-09-21")).toBe(utcMidnight - 5.5 * 3600);
  });

  it("accepts a full ISO timestamp and uses its date", () => {
    expect(istDateToEpochSeconds("2026-09-21T17:45:00Z")).toBe(istDateToEpochSeconds("2026-09-21"));
  });

  it.each(["", "not-a-date", "21-09-2026", "2026/09/21"])("returns null for %p", (s) => {
    expect(istDateToEpochSeconds(s)).toBeNull();
  });
});

describe("decideRenewalFiling — files only when it should", () => {
  it("files when paid and the registrar agrees on the expiry", () => {
    const d = ask();
    expect(d.action).toBe("file");
    if (d.action === "file") {
      expect(d.years).toBe(1);
      /* RC's OWN value, not ours — its purpose is to match what the registrar
         holds so the registrar can reject a duplicate. */
      expect(d.expiryEpochSeconds).toBe(TERM_EPOCH);
    }
  });

  it("passes the term through", () => {
    const d = ask({ years: 5 });
    expect(d.action === "file" && d.years).toBe(5);
  });

  it("sends the registrar's expiry even when it differs from ours within a day", () => {
    /* Registrars report expiry at their own time of day; a same-day pair is
       normal and must not read as a mismatch. */
    const live = TERM_EPOCH + 6 * 3600;
    const d = ask({ liveExpiryEpochSeconds: live });
    expect(d.action).toBe("file");
    if (d.action === "file") expect(d.expiryEpochSeconds).toBe(live);
  });
});

describe("decideRenewalFiling — the money gate", () => {
  /* Filing against an unpaid quote is the reseller buying a year for a customer
     who did not ask, and nothing errors. */
  it.each<QuotePaymentState>(["awaiting", "partial", "none", null])(
    "waits when the quote is %p",
    (quotePayment) => {
      const d = ask({ quotePayment });
      expect(d.action).toBe("wait");
      if (d.action === "wait") expect(d.reason).toMatch(/paid in full/);
    },
  );

  it("a PARTIAL payment is not enough", () => {
    /* Named separately because it is the one somebody would be tempted to allow:
       the customer has paid something. They have not paid for a year. */
    expect(ask({ quotePayment: "partial" }).action).toBe("wait");
  });

  it("files on 'received'", () => {
    expect(ask({ quotePayment: "received" }).action).toBe("file");
  });

  it("files on 'invoiced' — the money arrived and a GST invoice was raised", () => {
    expect(ask({ quotePayment: "invoiced" }).action).toBe("file");
  });
});

describe("decideRenewalFiling — the duplicate guard", () => {
  /* ─── THE EXPENSIVE ONE ──────────────────────────────────────────────────
     A renewal that already landed but was not recorded — a crash after the
     call, or an operator renewing by hand at the registrar. Re-filing buys a
     second year at full price. */
  it("does NOT file when the registrar's expiry is already a year out", () => {
    const d = ask({ liveExpiryEpochSeconds: TERM_EPOCH + YEAR });
    expect(d.action).toBe("already_renewed");
    if (d.action === "already_renewed") expect(d.reason).toMatch(/already past|has been filed/i);
  });

  it("treats even a few days past the term as already renewed", () => {
    expect(ask({ liveExpiryEpochSeconds: TERM_EPOCH + 3 * DAY }).action).toBe("already_renewed");
  });

  it("still files when the registrar is within a day either side", () => {
    for (const skew of [-DAY + 60, -3600, 0, 3600, DAY - 60]) {
      expect(ask({ liveExpiryEpochSeconds: TERM_EPOCH + skew }).action, `skew ${skew}`).toBe("file");
    }
  });

  /* Our record ahead of the registrar's. Both the term and the amount are now in
     doubt, so this is a person's problem and not a guess. */
  it("refuses when the registrar's expiry is EARLIER than the quoted term", () => {
    const d = ask({ liveExpiryEpochSeconds: TERM_EPOCH - 30 * DAY });
    expect(d.action).toBe("refuse");
    if (d.action === "refuse") {
      expect(d.reason).toMatch(/EARLIER/);
      expect(d.nextStep).toMatch(/correct the expiry|ahead of the registrar/i);
    }
  });
});

describe("decideRenewalFiling — everything it refuses", () => {
  it("refuses without an order id at the registrar", () => {
    const d = ask({ liveOrderId: null });
    expect(d.action).toBe("refuse");
    if (d.action === "refuse") {
      expect(d.reason).toMatch(/order id/i);
      /* The realistic case for this database: no domain here has one. */
      expect(d.nextStep).toMatch(/not registered through ResellerClub/i);
    }
  });

  it("refuses when the registrar did not report an expiry", () => {
    for (const live of [null, NaN, Infinity]) {
      const d = ask({ liveExpiryEpochSeconds: live as number });
      expect(d.action, `live ${live}`).toBe("refuse");
      if (d.action === "refuse") expect(d.nextStep).toMatch(/renewed twice/);
    }
  });

  it("refuses an unparseable quoted term", () => {
    expect(ask({ fromExpiresAt: "whenever" }).action).toBe("refuse");
  });

  it.each(["renewed", "failed", "cancelled"] as const)("waits when the renewal is %s", (renewalStatus) => {
    const d = ask({ renewalStatus });
    expect(d.action).toBe("wait");
    if (d.action === "wait") expect(d.reason).toContain(renewalStatus);
  });

  it("every refusal carries a reason and a next step", () => {
    const bad = [
      { liveOrderId: null },
      { liveExpiryEpochSeconds: null },
      { fromExpiresAt: "nope" },
      { liveExpiryEpochSeconds: TERM_EPOCH - 90 * DAY },
    ];
    for (const o of bad) {
      const d = ask(o);
      expect(d.action).toBe("refuse");
      if (d.action === "refuse") {
        expect(d.reason.length).toBeGreaterThan(10);
        expect(d.nextStep.length).toBeGreaterThan(10);
        expect(d.nextStep).not.toBe(d.reason);
      }
    }
  });

  /* The order of the checks matters: an unpaid quote must never reach the
     registrar checks, because those can `refuse` and a refusal reads as "a
     person must look at this" when the truth is "nobody has paid yet". */
  it("reports the unpaid quote before any registrar problem", () => {
    const d = ask({ quotePayment: "awaiting", liveOrderId: null, liveExpiryEpochSeconds: null });
    expect(d.action).toBe("wait");
  });
});
