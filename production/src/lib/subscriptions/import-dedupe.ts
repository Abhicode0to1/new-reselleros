/**
 * Has this subscription already been imported?
 *
 * ─── WHY ────────────────────────────────────────────────────────────────────
 * The CSV importer inserts every matched row, with no check that the subscription is
 * already on file. It was built for a one-time migration out of Zoho Billing, where that
 * is exactly right — the table is empty and everything in the file is new.
 *
 * It is not right the second time. Abhishek asked on 23 Sep 2026 what happens if he
 * exports the subscriptions and re-imports the file. Today: nothing, because the export's
 * column names ("Customer", "Plan", "Seats") do not match the ones the importer looks for
 * ("Customer Number", "Item Name", "Quantity"), so every row is skipped as unmatched.
 *
 * That is a lucky accident, not a safeguard. Hand the importer any file whose columns DO
 * line up — a re-run of the original Zoho export, a corrected copy of a file already
 * imported, the same file twice by mistake — and every customer gets a second
 * subscription. Two renewal dates, two MRRs counted in the ARR, two rows the renewal cron
 * will chase. Nothing on screen would warn you, and the damage is only obvious later.
 *
 * ─── THE KEY IS THE DOMAIN, THEN THE PLAN ───────────────────────────────────
 * A domain is what a Workspace subscription actually is: one tenant, provisioned once.
 * Two rows for `acme.in` are the same service however the plan is spelled — and plan
 * names do NOT survive a trip between systems ("Google Workspace Business Starter" here,
 * "Google Workspace Business Starter - Annual, Monthly Pay" in an export), so matching on
 * them would let a duplicate straight through.
 *
 * Rows with no domain fall back to customer + plan, because that is all there is. It is
 * the weaker check of the two and it is the reason the outcome is "skipped, look at it"
 * rather than "deleted".
 *
 * ─── SKIPPED, NEVER MERGED ──────────────────────────────────────────────────
 * A duplicate is reported and left out. It is never used to UPDATE the existing row:
 * seats and MRR on the subscription may have been corrected by hand since the migration,
 * and silently overwriting that with an older CSV is a worse bug than the one this
 * prevents.
 */

/** The shape this needs from a subscription already on file. */
export interface TrackedSubscription {
  domain?: string | null;
  customer_id?: string | null;
  plan?: string | null;
}

/** The shape this needs from a row about to be imported. */
export interface IncomingRow {
  domain?: string | null;
  customer_id?: string | null;
  plan?: string | null;
}

export interface ImportDedupeIndex {
  /** Lower-cased domains that already carry a subscription. */
  domains: Set<string>;
  /** `customerId::plan` for rows that have no domain to match on. */
  customerPlans: Set<string>;
}

export function buildImportDedupeIndex(
  existing: readonly TrackedSubscription[],
): ImportDedupeIndex {
  const domains = new Set<string>();
  const customerPlans = new Set<string>();
  for (const sub of existing) {
    const d = normDomain(sub.domain);
    if (d) domains.add(d);
    const cp = customerPlanKey(sub.customer_id, sub.plan);
    if (cp) customerPlans.add(cp);
  }
  return { domains, customerPlans };
}

/**
 * Why this row is a duplicate, or null when it is genuinely new.
 *
 * Returns a SENTENCE rather than a boolean, because it is shown next to the row in the
 * preview and "skipped" on its own tells the operator nothing about what to do next.
 */
export function duplicateReason(
  row: IncomingRow, index: ImportDedupeIndex,
): string | null {
  const d = normDomain(row.domain);
  if (d && index.domains.has(d)) {
    return `${d} already has a subscription`;
  }
  const cp = customerPlanKey(row.customer_id, row.plan);
  if (!d && cp && index.customerPlans.has(cp)) {
    return "this customer already has this plan";
  }
  return null;
}

/**
 * Lower-cased hostname, with the `www.` and any protocol removed.
 *
 * A CSV exported from one system and edited in Excel arrives as `ACME.IN`,
 * `www.acme.in` and `https://acme.in` in the same column. Treating those as three
 * different domains would wave three copies of one subscription through.
 */
function normDomain(value: string | null | undefined): string | null {
  const raw = (value ?? "").trim().toLowerCase();
  if (!raw) return null;
  return raw.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "") || null;
}

/** `customerId::plan`, or null when either half is missing. */
function customerPlanKey(
  customerId: string | null | undefined, plan: string | null | undefined,
): string | null {
  const c = (customerId ?? "").trim();
  const p = (plan ?? "").trim().toLowerCase();
  if (!c || !p) return null;
  return `${c}::${p}`;
}
