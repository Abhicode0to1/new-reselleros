/**
 * roles.ts — log in as a role of "E2E Test Co" (R-053), one storageState per role.
 *
 *   import { test, expect, skipUnlessRoles } from "./fixtures/roles";
 *   test.describe("W13 payroll", () => {
 *     skipUnlessRoles(["owner"]);
 *     test.use({ role: "owner" });
 *     test("…", async ({ page, db }) => { … });
 *   });
 *
 * - The browser logs in through the REAL /login form once per role per worker, and the
 *   resulting cookies are saved as a storageState file under test-results/.auth/. Every
 *   test of that role starts already signed in. The UI path is used on purpose: it writes
 *   whatever cookie format the app's @supabase/ssr version writes, so the fixture cannot
 *   drift from the app.
 * - `db` is a supabase-js client signed in as the SAME user with the anon key, so any data
 *   a spec sets up goes through RLS exactly like the app does. No service-role key here.
 * - Credentials: e2e-roles.mjs (E2E_<ROLE>_EMAIL / E2E_<ROLE>_PASSWORD). No defaults for
 *   passwords; skipUnlessRoles() skips with the missing variable names.
 */
import { test as base, expect, type Browser } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import {
  roleCreds, missingEnvFor, productionHostReason,
  E2E_CUSTOMER_NAME, E2E_TENANT_NAME, type E2ERole,
} from "./e2e-roles.mjs";

export { expect };
export type { E2ERole };
export { E2E_CUSTOMER_NAME, E2E_TENANT_NAME };

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || "";

/** Skip the enclosing describe when any env var needed to log in as `roles` is missing. */
export function skipUnlessRoles(roles: readonly E2ERole[]) {
  const missing = missingEnvFor(roles);
  base.skip(
    missing.length > 0,
    `Logged-in E2E (${roles.join(", ")}) needs env: ${missing.join(", ")} — see e2e/README.md "Logged-in E2E".`,
  );
}

/** Refuse to create data when the app under test is production (deny list in e2e-roles.mjs). */
function assertNotProduction(baseURL: string | undefined) {
  const why = productionHostReason(baseURL) ?? productionHostReason(SUPABASE_URL);
  if (why) throw new Error(`Logged-in E2E refuses to run against production: ${why}`);
}

async function signedInClient(role: E2ERole): Promise<SupabaseClient> {
  const { email, password } = roleCreds(role);
  if (!password) throw new Error(`no password env for ${role}`);
  const sb = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign-in as ${role} (${email}) failed: ${error.message} — was the seed run?`);
  return sb;
}

async function loginThroughUi(browser: Browser, baseURL: string, role: E2ERole, file: string) {
  const { email, password } = roleCreds(role);
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password ?? "");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  // Signed in = the @supabase/ssr session cookie exists. Waiting for the cookie rather
  // than for the post-login page keeps a slow first compile of ROLE_HOME out of it.
  await expect
    .poll(async () => (await context.cookies()).some((c) => /^sb-.+-auth-token/.test(c.name)), {
      timeout: 60_000,
      message: `login as ${role} (${email}) did not produce a session — wrong password or seed not run?`,
    })
    .toBe(true);
  await context.storageState({ path: file });
  await context.close();
}

type TestFixtures = { role: E2ERole; db: SupabaseClient };
type WorkerFixtures = { roleStateFile: (role: E2ERole, baseURL: string) => Promise<string> };

export const test = base.extend<TestFixtures, WorkerFixtures>({
  role: ["owner", { option: true }],

  /* Per worker, per role: log in once, reuse the storageState file for every later test
     of that role in the worker. (A worker-scoped `role` option would be neater, but
     Playwright forbids test.use() of worker options inside describe blocks, and specs
     mix roles per describe.) */
  roleStateFile: [async ({ browser }, use, workerInfo) => {
    const dir = path.join(workerInfo.project.outputDir, ".auth");
    fs.mkdirSync(dir, { recursive: true });
    const done = new Map<E2ERole, Promise<string>>();
    await use((role, baseURL) => {
      let p = done.get(role);
      if (!p) {
        const file = path.join(dir, `${role}-w${workerInfo.workerIndex}.json`);
        p = loginThroughUi(browser, baseURL, role, file).then(() => file);
        p.catch(() => done.delete(role)); // a failed login is retried by the next test
        done.set(role, p);
      }
      return p;
    });
  }, { scope: "worker" }],

  storageState: async ({ role, roleStateFile, baseURL }, use) => {
    assertNotProduction(baseURL);
    await use(await roleStateFile(role, baseURL!));
  },

  db: async ({ role }, use) => {
    const sb = await signedInClient(role);
    await use(sb);
    // No signOut(): its default scope is "global", which also revokes the browser
    // session that the saved storageState of this role depends on.
  },
});

/** The seeded customer of E2E Test Co (created by seed-e2e-tenant.mjs). */
export async function e2eCustomer(db: SupabaseClient): Promise<{ id: string; name: string }> {
  const { data, error } = await db.from("customers").select("id, name").eq("name", E2E_CUSTOMER_NAME).limit(1);
  if (error) throw new Error(`customers: ${error.message}`);
  if (!data?.length) throw new Error(`"${E2E_CUSTOMER_NAME}" not found — run the seed (e2e/README.md).`);
  return data[0] as { id: string; name: string };
}

/** Short unique suffix so repeated runs never collide ("E2E … 7f3a"). */
export function runTag(): string {
  return `${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 4)}`;
}

/**
 * Raise a real tax invoice for the E2E customer through the app's own RPC
 * (create_direct_invoice → generate_invoice), as the signed-in role. Intra-state,
 * 18% GST. Returns the invoice id and the gross amount.
 */
export async function createE2EInvoice(
  db: SupabaseClient,
  opts: { label: string; rate: number; qty?: number },
): Promise<{ invoiceId: string; quoteId: string; gross: number; taxable: number }> {
  const cust = await e2eCustomer(db);
  const qty = opts.qty ?? 1;
  const { data, error } = await db.rpc("create_direct_invoice", {
    p_customer_id: cust.id,
    // Same line shape as useCreateDirectInvoice (src/lib/queries/invoices.ts).
    p_line_items: [{ id: "line-1", name: opts.label, qty, rate: opts.rate, cost: 0 }],
    p_notes: `${opts.label} (automated E2E, test data)`,
    p_recurring: false,
  });
  if (error) throw new Error(`create_direct_invoice: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as { invoice_id: string; quote_id: string };
  const taxable = qty * opts.rate;
  return { invoiceId: row.invoice_id, quoteId: row.quote_id, taxable, gross: taxable + Math.round(taxable * 0.18) };
}

/**
 * A quote for the E2E customer that is NOT invoiced yet (status 'sent'), inserted through
 * RLS as the signed-in role with a number from next_document_number — the same numbering
 * the quote builder uses. `oneOff` keeps record_payment from creating a subscription.
 */
export async function createE2EQuote(
  db: SupabaseClient,
  opts: { label: string; rate: number; qty?: number; oneOff?: boolean; paymentTermsDays?: number },
): Promise<{ quoteId: string; gross: number; taxable: number }> {
  const cust = await e2eCustomer(db);
  const { data: me } = await db.from("users").select("tenant_id").limit(1).single();
  const tenantId = (me as { tenant_id: string } | null)?.tenant_id;
  const { data: id, error: idErr } = await db.rpc("next_document_number", { p_doc_type: "quote", p_tenant_id: tenantId });
  if (idErr || !id) throw new Error(`next_document_number: ${idErr?.message ?? "null"}`);
  const qty = opts.qty ?? 1;
  const taxable = qty * opts.rate;
  const gross = taxable + Math.round(taxable * 0.18);
  const { error } = await db.from("quotes").insert({
    id, tenant_id: tenantId, customer_id: cust.id, customer_name: cust.name,
    amount: gross, subtotal: taxable, tax_rate: 18, discount_pct: 0,
    line_items: [{ id: "line-1", name: opts.label, qty, rate: opts.rate, cost: 0 }],
    status: "sent", payment_status: "awaiting", is_one_off: opts.oneOff ?? true,
    payment_terms_days: opts.paymentTermsDays ?? null,
    notes: `${opts.label} (automated E2E, test data)`,
  });
  if (error) throw new Error(`quotes insert: ${error.message}`);
  return { quoteId: String(id), gross, taxable };
}

/**
 * An active subscription of the E2E customer, inserted through RLS (the same insert the
 * "Add / Onboard Subscription" dialog does). Dates are IST days relative to today.
 */
export async function createE2ESubscription(
  db: SupabaseClient,
  opts: { plan: string; seats: number; mrr: number; startInDays: number; renewInDays: number; termMonths?: number },
): Promise<{ id: string; renewalDate: string }> {
  const cust = await e2eCustomer(db);
  const { data: me } = await db.from("users").select("tenant_id").limit(1).single();
  const renewalDate = todayIST(opts.renewInDays);
  const { data, error } = await db.from("subscriptions").insert({
    tenant_id: (me as { tenant_id: string }).tenant_id,
    customer_id: cust.id, customer_name: cust.name,
    plan: opts.plan, vendor: "google", seats: opts.seats, mrr: opts.mrr,
    status: "active", billing_cycle: "yearly", term_months: opts.termMonths ?? 12,
    start_date: todayIST(opts.startInDays), renewal_date: renewalDate,
  }).select("id").single();
  if (error) throw new Error(`subscriptions insert: ${error.message}`);
  return { id: (data as { id: string }).id, renewalDate };
}

/** A 12-digit, UTR-shaped test reference that is unique per call. */
export function testUtr(): string {
  return `9${Date.now().toString().slice(-9)}${Math.floor(Math.random() * 90 + 10)}`;
}

/** App-shell check used by every W-spec: page rendered, not /login, not the error boundary. */
export async function expectAppPage(page: import("@playwright/test").Page, urlPath: string, heading: RegExp) {
  await page.goto(urlPath);
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/Something went wrong/i)).toHaveCount(0);
}

/** Indian money text exactly as the app prints it (lib/utils rupee): ₹1,18,000 */
export function inr(n: number): string {
  return `₹${Math.round(n).toLocaleString("en-IN")}`;
}

/** YYYY-MM-DD in IST — the business day the app's pages reason in. */
export function todayIST(offsetDays = 0): string {
  const d = new Date(Date.now() + 5.5 * 3_600_000 + offsetDays * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/** invoice_date the DB stamped (it uses the DB clock, which may differ from IST near midnight). */
export async function invoiceDateOf(db: SupabaseClient, invoiceId: string): Promise<string> {
  const { data, error } = await db.from("invoices").select("invoice_date").eq("id", invoiceId).single();
  if (error) throw new Error(`invoice ${invoiceId}: ${error.message}`);
  return String((data as { invoice_date: string }).invoice_date).slice(0, 10);
}

/** Parse "₹1,23,456.50" / "1,18,000" → 123456.5 */
export function rupees(text: string): number {
  const m = text.replace(/[^\d.\-]/g, "");
  return m ? Number(m) : NaN;
}
