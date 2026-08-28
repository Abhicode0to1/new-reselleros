import { describe, it, expect, vi, afterEach } from "vitest";
import { cronFailureLine, reportCron } from "./cron-report";

/* ─────────────────────────────────────────────────────────────────────────────
   Neeche ka har nateeja is repo ke ASLI cron routes se liya gaya hai (28 Aug 2026 par
   padha), banaya hua nahi. Wajah: is file ka poora maqsad un aath cron ko awaaz dena hai,
   aur ek kaalpanik shape par pass hone wala test us din chup rahega jis din shape asli ho.
   ───────────────────────────────────────────────────────────────────────────── */

afterEach(() => vi.restoreAllMocks());

describe("cronFailureLine — chup rehna, jab tak chup rehna sahi hai", () => {
  it("saaf run par kuch nahi bolta", () => {
    /* google-contacts-sync ka wo run jo 28 Aug ko reconnect ke baad chala. */
    expect(cronFailureLine("google-contacts-sync", {
      ok: true, users: 1, synced: 1, failed: 0, totals: { pulled: 47, pushed: 0, created: 2, deleted: 0 },
    })).toBeNull();
  });

  it("khaali errors array par kuch nahi bolta", () => {
    expect(cronFailureLine("mrr-snapshot", { tenants: 3, customers: 25, errors: [] })).toBeNull();
  });

  it("skipped ko failure NAHI maanta — ASLI FAISLA", () => {
    /* billing roz 40+ subscription skip karta hai kyunki unka invoice pehle se hai. Use
       failure ginne par har raat ek jhoothi email jayegi, aur do hafte me ye digest bhi
       waise hi anpadha ho jayega jaise "sab theek hai" wali email hoti hai. */
    expect(cronFailureLine("billing", {
      total_active: 17, invoices_raised: 2, already_raised: 15,
      skipped: [{ subscription_id: "s1", code: "no_price", reason: "item deleted" }],
      errors: [],
    })).toBeNull();
  });
});

describe("cronFailureLine — jab bolna chahiye", () => {
  it("google-contacts-sync ka failed count pakadta hai — ASLI MAAMLA", () => {
    /* Yahi wo nateeja hai jo 13 din tak har 6 ghante me 200 ke saath lauta. */
    const line = cronFailureLine("google-contacts-sync", {
      ok: true, users: 1, synced: 0, failed: 1,
      totals: { pulled: 0, pushed: 0, created: 0, deleted: 0 },
    });
    expect(line).toBe("[cron/google-contacts-sync] failed=1");
  });

  it("errors array ki wajah bhi line me laata hai", () => {
    const line = cronFailureLine("google-contacts-sync", {
      failed: 1,
      errors: ["People list failed: 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT"],
    });
    expect(line).toContain("failed=1");
    expect(line).toContain("errors=1");
    expect(line).toContain("ACCESS_TOKEN_SCOPE_INSUFFICIENT");
  });

  it("failed aur errors ko JODTA NAHI — dono alag dikhte hain", () => {
    /* birthday-greetings me `failed` send ka hai aur `errors` claim ka. Jod kar "3" likhna
       ek aisa aankda banata hai jo route me kahin likha hi nahi hai. */
    const line = cronFailureLine("birthday-greetings", {
      matched: 4, sent: 1, failed: 2,
      errors: [{ contact_id: "c1", message: "resend: domain not verified" }],
    });
    expect(line).toContain("failed=2");
    expect(line).toContain("errors=1");
    expect(line).not.toContain("=3");
  });

  it("object wale error se message nikalta hai", () => {
    const line = cronFailureLine("invoice-dunning", {
      considered: 9, emails_sent: 7,
      errors: [{ invoice_id: "i1", message: "no recipient on customer" }],
    });
    expect(line).toContain("no recipient on customer");
    expect(line).not.toContain("i1");
  });

  it("`error` key wale object se bhi nikalta hai — attendance ka shape", () => {
    const line = cronFailureLine("attendance-reminders", {
      considered: 10, pushed: 8,
      failures: [{ userId: "u1", error: "no device reached" }],
    });
    expect(line).toBe("[cron/attendance-reminders] failures=1 — no device reached");
  });

  it("string errors — mrr-snapshot ka shape", () => {
    const line = cronFailureLine("mrr-snapshot", {
      tenants: 3, errors: ["upsert failed: duplicate key"],
    });
    expect(line).toBe("[cron/mrr-snapshot] errors=1 — upsert failed: duplicate key");
  });
});

describe("cronFailureLine — line khud padhne layak rahe", () => {
  it("do se zyada wajah nahi likhta", () => {
    const line = cronFailureLine("compliance-reminders", {
      errors: ["pehla", "doosra", "teesra", "chautha"],
    })!;
    expect(line).toContain("errors=4");
    expect(line).toContain("pehla");
    expect(line).toContain("doosra");
    expect(line).not.toContain("teesra");
  });

  it("DONO wajah bachti hain jab dono lambi hon", () => {
    /* Ye test poori line ke clip se nahi, har sample ke apne clip se pass hota hai. Sirf
       line-level clip rakhne par doosri wajah beech me kat kar gayab ho jaati hai — aur
       aksar wahi doosri wajah batati hai ki masla ek user ka hai ya sab ka. */
    const line = cronFailureLine("compliance-reminders", {
      errors: [`pehli-${"a".repeat(400)}`, `doosri-${"b".repeat(400)}`],
    })!;
    expect(line).toContain("pehli-");
    expect(line).toContain("doosri-");
  });

  it("lambi wajah kaat deta hai", () => {
    /* Ek 4KB ka Postgres error poori digest ko dhak leta — aur digest ka apna shorten()
       label ke baad kaatta hai, yaani wo bachata nahi. */
    const line = cronFailureLine("billing", { errors: ["x".repeat(500)] })!;
    expect(line.length).toBeLessThanOrEqual(300);
    expect(line).toContain("…");
  });

  it("ginti se pehle [cron/naam] aata hai, taaki digest ise app-error maane", () => {
    /* health-digest ka worthReading() sirf `[label]` wali line ko hamesha rakhta hai. */
    expect(cronFailureLine("billing", { failed: 1 })!.startsWith("[cron/billing] ")).toBe(true);
  });
});

describe("cronFailureLine — kachra andar aaye to crash na ho", () => {
  it("null, string, array — sab par null", () => {
    for (const junk of [null, undefined, "failed", 7, [1, 2, 3]]) {
      expect(cronFailureLine("x", junk)).toBeNull();
    }
  });

  it("failed=0 aur rinaatmak par chup", () => {
    expect(cronFailureLine("x", { failed: 0 })).toBeNull();
    expect(cronFailureLine("x", { failed: -1 })).toBeNull();
    expect(cronFailureLine("x", { failed: NaN })).toBeNull();
  });

  it("bina message wale object par ginti to deta hai", () => {
    /* Wajah na mile to bhi ginti chhupani nahi hai — "kuch nahi mila" aur "bata nahi paya"
       ek jaise nahi dikhne chahiye. */
    expect(cronFailureLine("x", { errors: [{ code: 500 }] })).toBe("[cron/x] errors=1");
  });
});

describe("reportCron — bolti hai, aur raaste me kuch badalti nahi", () => {
  it("failure par console.error par likhti hai", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    reportCron("google-contacts-sync", { failed: 1 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe("[cron/google-contacts-sync] failed=1");
  });

  it("saaf run par kuch nahi likhti", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    reportCron("billing", { invoices_raised: 2, errors: [] });
    expect(spy).not.toHaveBeenCalled();
  });

  it("wahi object wapas deta hai — response badalna is fix ka hissa nahi", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = { failed: 1, totals: { pulled: 0 } };
    expect(reportCron("x", result)).toBe(result);
  });

  it("console.warn NAHI — digest ka filter stderr/ERROR par hai", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    reportCron("x", { failed: 1 });
    expect(warn).not.toHaveBeenCalled();
  });
});
