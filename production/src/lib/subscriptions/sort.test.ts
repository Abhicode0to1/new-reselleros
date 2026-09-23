import { describe, it, expect } from "vitest";
import { sortSubscriptions, defaultDirFor, type SubSortKey } from "./sort";
import type { Subscription } from "@/lib/supabase/database.types";

const sub = (over: Partial<Subscription>): Subscription => ({
  id: over.id ?? "s1",
  customer_name: "Acme",
  plan: "Workspace Starter",
  vendor: "google",
  seats: 5,
  used: 0,
  mrr: 1000,
  start_date: "2026-01-01",
  renewal_date: "2027-01-01",
  status: "active",
  ...over,
} as Subscription);

const names = (rows: Subscription[]) => rows.map((r) => r.customer_name);

describe("sortSubscriptions — text columns", () => {
  const rows = [
    sub({ id: "a", customer_name: "Zebra Ltd" }),
    sub({ id: "b", customer_name: "acme corp" }),
    sub({ id: "c", customer_name: "Mango Pvt" }),
  ];

  it("sorts customers A–Z regardless of case", () => {
    // Imported names arrive with mixed case; "acme corp" must not sort after "Zebra".
    expect(names(sortSubscriptions(rows, { key: "customer", dir: "asc" })))
      .toEqual(["acme corp", "Mango Pvt", "Zebra Ltd"]);
  });

  it("reverses on desc", () => {
    expect(names(sortSubscriptions(rows, { key: "customer", dir: "desc" })))
      .toEqual(["Zebra Ltd", "Mango Pvt", "acme corp"]);
  });
});

describe("sortSubscriptions — numeric columns", () => {
  it("sorts seats as numbers, not as text", () => {
    // The bug a generic comparator gives you: "10" < "9" as strings.
    const rows = [sub({ id: "a", seats: 9 }), sub({ id: "b", seats: 10 }), sub({ id: "c", seats: 100 })];
    expect(sortSubscriptions(rows, { key: "seats", dir: "asc" }).map((r) => r.seats))
      .toEqual([9, 10, 100]);
  });

  it("sorts MRR biggest-first on desc", () => {
    const rows = [sub({ id: "a", mrr: 528 }), sub({ id: "b", mrr: 69000 }), sub({ id: "c", mrr: 1320 })];
    expect(sortSubscriptions(rows, { key: "mrr", dir: "desc" }).map((r) => r.mrr))
      .toEqual([69000, 1320, 528]);
  });
});

describe("sortSubscriptions — dates, which are nullable", () => {
  const rows = [
    sub({ id: "a", customer_name: "Later",  renewal_date: "2027-12-01" }),
    sub({ id: "b", customer_name: "Soon",   renewal_date: "2026-10-01" }),
    sub({ id: "c", customer_name: "NoDate", renewal_date: null }),
  ];

  it("sorts soonest first", () => {
    expect(names(sortSubscriptions(rows, { key: "renewal", dir: "asc" })))
      .toEqual(["Soon", "Later", "NoDate"]);
  });

  it("keeps a missing date LAST even when sorting descending", () => {
    /* A null is not "the earliest date" and not "the latest" — it is absent. Floating it
       to the top on desc would put the rows we know least about where the eye lands
       first. */
    expect(names(sortSubscriptions(rows, { key: "renewal", dir: "desc" })))
      .toEqual(["Later", "Soon", "NoDate"]);
  });

  it("treats an unparseable date as missing rather than as a tie", () => {
    const junk = [sub({ id: "a", customer_name: "Junk", start_date: "" }), sub({ id: "b", customer_name: "Real", start_date: "2026-05-01" })];
    expect(names(sortSubscriptions(junk, { key: "started", dir: "asc" })))
      .toEqual(["Real", "Junk"]);
  });
});

describe("sortSubscriptions — margin, where unknown is the common case", () => {
  const rows = [
    sub({ id: "a", customer_name: "Thin"    }),
    sub({ id: "b", customer_name: "Healthy" }),
    sub({ id: "c", customer_name: "Unknown" }),
  ];
  const marginOf = (s: Subscription) =>
    s.customer_name === "Thin" ? 50 : s.customer_name === "Healthy" ? 900 : null;

  it("puts the worst margin first when ascending", () => {
    expect(names(sortSubscriptions(rows, { key: "margin", dir: "asc" }, marginOf)))
      .toEqual(["Thin", "Healthy", "Unknown"]);
  });

  it("never treats an unpriced subscription as zero margin", () => {
    /* Most rows in this database have no catalogue cost. Sorting them as 0 would file
       every unpriced subscription among the worst offenders and bury the real ones. */
    const asc = sortSubscriptions(rows, { key: "margin", dir: "asc" }, marginOf);
    expect(asc[asc.length - 1].customer_name).toBe("Unknown");
    const desc = sortSubscriptions(rows, { key: "margin", dir: "desc" }, marginOf);
    expect(desc[desc.length - 1].customer_name).toBe("Unknown");
  });

  it("reports every row as unknown when no margin resolver is supplied", () => {
    const out = sortSubscriptions(rows, { key: "margin", dir: "asc" });
    expect(names(out)).toEqual(["Thin", "Healthy", "Unknown"]);   // order preserved
  });
});

describe("sortSubscriptions — general contract", () => {
  it("does not mutate the array it was given", () => {
    // The page passes the query's cached array; sorting in place would reorder the
    // React Query cache under every other consumer.
    const rows = [sub({ id: "a", mrr: 1 }), sub({ id: "b", mrr: 2 })];
    const before = rows.map((r) => r.id);
    sortSubscriptions(rows, { key: "mrr", dir: "desc" });
    expect(rows.map((r) => r.id)).toEqual(before);
  });

  it("is stable, so the newest-first default survives underneath", () => {
    // Sorting by vendor must still show the newest Google row at the top of the Google
    // block, not a random one.
    const rows = [
      sub({ id: "a", customer_name: "G-new", vendor: "google" }),
      sub({ id: "b", customer_name: "G-old", vendor: "google" }),
      sub({ id: "c", customer_name: "M-one", vendor: "microsoft" }),
    ];
    expect(names(sortSubscriptions(rows, { key: "vendor", dir: "asc" })))
      .toEqual(["G-new", "G-old", "M-one"]);
  });

  it("handles an empty list", () => {
    expect(sortSubscriptions([], { key: "mrr", dir: "asc" })).toEqual([]);
  });
});

describe("defaultDirFor — which way a column opens", () => {
  it("opens money and seats biggest-first", () => {
    expect(defaultDirFor("mrr")).toBe("desc");
    expect(defaultDirFor("seats")).toBe("desc");
  });

  it("opens margin WORST-first — a margin sort is a hunt for problems", () => {
    expect(defaultDirFor("margin")).toBe("asc");
  });

  it("opens text and dates naturally", () => {
    for (const k of ["customer", "plan", "vendor", "status", "started", "renewal"] as SubSortKey[]) {
      expect(defaultDirFor(k)).toBe("asc");
    }
  });
});
