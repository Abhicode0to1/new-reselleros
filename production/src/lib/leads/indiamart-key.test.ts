/**
 * S34 — the IndiaMART key screen's rules: how much of the key may be shown, what the status
 * card says, and that the two actionable failures are recognised from the CRON'S OWN words
 * (produced here by running the real runner against a fake DB), not from a copy of them.
 */
import { describe, it, expect, vi } from "vitest";
import { crmKeySchema, keyLast4, istDateTime, pullSummary, PULL_SCHEDULE_TEXT, KEY_SOURCE_TEXT } from "./indiamart-key";

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: () => { throw new Error("no DB in unit tests"); } }));
import { runIndiamartPull } from "./indiamart.server";

const KEY = "SYNTHETIC-KEY-0123456789-wxyz";

describe("keyLast4 — never more than four characters, and only of a real-length key", () => {
  it("returns the last four of a key of 16+ characters", () => {
    expect(keyLast4(KEY)).toBe("wxyz");
    expect(keyLast4(`  ${KEY}  `)).toBe("wxyz");
  });
  it("shows nothing for a value too short for four characters to be a small part of it", () => {
    expect(keyLast4("abc123")).toBeNull();
    expect(keyLast4("0123456789abcde")).toBeNull(); // 15
  });
  it("shows nothing when there is no key", () => {
    expect(keyLast4(null)).toBeNull();
    expect(keyLast4(undefined)).toBeNull();
    expect(keyLast4("   ")).toBeNull();
  });
});

describe("crmKeySchema — the one rule the page and the API both apply", () => {
  it("trims and accepts a plausible key", () => {
    expect(crmKeySchema.parse({ crm_key: `  ${KEY}\n` })).toEqual({ crm_key: KEY });
  });
  it("refuses a short or oversized paste with a next step", () => {
    const short = crmKeySchema.safeParse({ crm_key: "abc" });
    expect(short.success).toBe(false);
    expect(short.error!.issues[0].message).toMatch(/Lead Manager se poori key copy karo/);
    const long = crmKeySchema.safeParse({ crm_key: "x".repeat(201) });
    expect(long.success).toBe(false);
    expect(long.error!.issues[0].message).toMatch(/sirf CRM key paste karo/);
  });
});

describe("istDateTime — IST whatever the machine's zone", () => {
  it("formats the afternoon and the midnight hour", () => {
    expect(istDateTime("2026-09-29T08:45:00Z")).toBe("29 Sep 2026, 2:15 pm");
    expect(istDateTime("2026-09-28T18:35:00Z")).toBe("29 Sep 2026, 12:05 am");
    expect(istDateTime("2026-09-29T06:30:00Z")).toBe("29 Sep 2026, 12:00 pm");
  });
  it("does not print Invalid Date", () => {
    expect(istDateTime("not a date")).toBe("—");
  });
});

describe("pullSummary", () => {
  const base = { configured: true, last_run_at: "2026-09-29T08:45:00Z", last_ok: true, last_error: null, last_imported: 0 };

  it("no key: says leads are NOT coming, and what to do", () => {
    const s = pullSummary({ ...base, configured: false });
    expect(s.tone).toBe("neutral");
    expect(s.title).toMatch(/nahi aa rahi/);
    expect(s.detail).toContain(PULL_SCHEDULE_TEXT);
  });

  it("no key but an old run on record: still 'not saved' — a removed key must not read as working", () => {
    expect(pullSummary({ ...base, configured: false, last_ok: true }).tone).toBe("neutral");
  });

  it("key saved, never pulled: says the first pull is pending and how far back it reaches", () => {
    const s = pullSummary({ ...base, last_run_at: null, last_ok: null });
    expect(s.title).toMatch(/pehla pull abhi hona hai/);
    expect(s.detail).toMatch(/24 ghante/);
  });

  it("working: names the time and the count, singular and plural", () => {
    expect(pullSummary(base)).toMatchObject({ tone: "success", title: "Chal raha hai — last pull 29 Sep 2026, 2:15 pm" });
    expect(pullSummary(base).detail).toMatch(/koi nayi enquiry nahi/);
    expect(pullSummary({ ...base, last_imported: 1 }).detail).toBe("Us pull mein 1 nayi lead bani.");
    expect(pullSummary({ ...base, last_imported: 3 }).detail).toBe("Us pull mein 3 nayi leads bani.");
  });

  it("an unknown failure shows the recorded reason and still gives a next step", () => {
    const s = pullSummary({ ...base, last_ok: false, last_error: "IndiaMART error: server busy" });
    expect(s.tone).toBe("danger");
    expect(s.detail).toMatch(/^IndiaMART error: server busy/);
    expect(s.detail).toMatch(/key dobara save karo/);
  });

  /* The two failures the owner can act on, from the text the real cron writes. */
  function fakeDb() {
    const upserts: Record<string, unknown>[] = [];
    const from = () => {
      const b = {
        select: () => b,
        not: () => Promise.resolve({ data: [{ tenant_id: "t1", indiamart_crm_key: KEY }], error: null }),
        eq: () => b,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        upsert: (row: Record<string, unknown>) => { upserts.push(row); return Promise.resolve({ error: null }); },
      };
      return b;
    };
    return { admin: { from, rpc: vi.fn() } as never, upserts };
  }
  const reply = (body: unknown) => vi.fn(async () => ({ status: 200, json: async () => body }) as unknown as Response);
  const now = new Date("2026-09-29T08:45:00Z");

  it("recognises the cron's rate-limit record as 'wait', not as a broken key", async () => {
    const db = fakeDb();
    await runIndiamartPull({ admin: db.admin, now, fetchImpl: reply({ CODE: 429, MESSAGE: "hit this API once in every 5 minutes" }) });
    const st = db.upserts.at(-1)!;
    const s = pullSummary({ configured: true, last_run_at: st.last_run_at as string, last_ok: st.last_ok as boolean, last_error: st.last_error as string, last_imported: 0 });
    expect(s.tone).toBe("warning");
    expect(s.detail).toMatch(/Kuch karna nahi hai/);
  });

  it("recognises the cron's rejected-key record and sends the owner to get a new key", async () => {
    const db = fakeDb();
    await runIndiamartPull({ admin: db.admin, now, fetchImpl: reply({ CODE: 401, MESSAGE: "Invalid Key" }) });
    const st = db.upserts.at(-1)!;
    expect(String(st.last_error)).toContain("/marketing/indiamart");
    const s = pullSummary({ configured: true, last_run_at: st.last_run_at as string, last_ok: st.last_ok as boolean, last_error: st.last_error as string, last_imported: 0 });
    expect(s.tone).toBe("danger");
    expect(s.title).toMatch(/key reject ki/);
    expect(s.detail).toContain(KEY_SOURCE_TEXT);
    // …and the record the screen shows never carries the key itself.
    expect(JSON.stringify(db.upserts)).not.toContain(KEY);
  });
});
