/**
 * POST /api/portal/hosting/:id/upgrade
 *
 * A customer asking for a bigger hosting plan, from /portal/hosting.
 *
 * The hosting twin of `/api/portal/seat-request`, and it keeps that route's two
 * disciplines exactly, because they are the two ways this shape of endpoint gets
 * exploited.
 *
 * ─── IT WRITES THROUGH THE SERVER, NOT FROM THE BROWSER ─────────────────────
 * A portal session has no `users` row (lib/auth/roles.ts, EXTERNAL_ACTORS), so
 * `hosting_plan_changes` has no insert policy for `authenticated` — a table any
 * signed-in customer could insert into is a table they could fill with requests
 * against somebody else's account. The tenant, the customer, the domain and the
 * CURRENT plan all come from the account row read here.
 *
 * ─── THE BODY CARRIES A PLAN CODE AND NOTHING ELSE ──────────────────────────
 * No price, no tenant, no customer, and no current plan. An upgrade is priced
 * pro-rata at approval — see `lib/hosting/plan-change.ts` — so a price in the
 * body would be a number the customer chose, and a current plan in the body would
 * be the customer telling us what they are paying for now.
 *
 * ─── ONLY UP, AND ONLY FROM A KNOWN PLAN ────────────────────────────────────
 * `upgradeOptions` is the gate. It returns nothing when the account's plan cannot
 * be identified, which refuses the request rather than guessing — an account whose
 * plan we cannot read might already be on the largest one, and "upgrading" it
 * would charge for nothing. It also returns nothing for the top plan, and never
 * includes a smaller plan, so a downgrade cannot enter through here at all.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { requirePortalSession } from "@/lib/portal/session";
import { upgradeOptions, planFromCode } from "@/lib/hosting/plan-change";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const bodySchema = z.object({
  requested_plan_code: z.string().trim().min(1).max(40),
  note: z.string().trim().max(1000).optional(),
});

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const session = await requirePortalSession();

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Pick a plan and try again." }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { data: account } = await supabase
    .from("hosting_accounts")
    .select("id, tenant_id, customer_id, domain_name, status, is_trial, plan_code, plan_name, da_package")
    .eq("id", params.id)
    .is("deleted_at", null)
    .maybeSingle();

  /* Not theirs, or not there — the same answer either way, so the response cannot
     be used to discover which hosting-account ids exist. */
  if (!account || !account.customer_id || account.customer_id !== session.customerId) {
    return NextResponse.json({ error: "No such hosting account on your login." }, { status: 404 });
  }

  /* ─── A TRIAL IS NOT UPGRADEABLE, AND THE UI IS NOT THE GUARD ───────────
     `/portal/hosting` hides the chooser on a trial, and until 11 Sep 2026 that
     was the ONLY thing stopping this. Measured by calling this route directly
     against a trial on a real plan code: HTTP 200 and a request created. A trial
     has no paid term, so the pro-rata maths would fall back to a full term and
     bill the whole annual difference. See `isTrial` in lib/hosting/plan-change. */
  if (account.is_trial) {
    return NextResponse.json(
      {
        error:
          "This is a free trial, so there is no term to upgrade yet. Tell us which plan you want and we will set the paid account up on that one.",
      },
      { status: 409 },
    );
  }

  if (account.status !== "active") {
    /* Said in the customer's terms, not the column's (§24). */
    const why: Record<string, string> = {
      pending: "This account is still being set up. Once it is live you can move it to a bigger plan.",
      suspended: "This account is suspended, so its plan cannot be changed. Raise a request and we will sort it out.",
      expired: "This account has lapsed. Renew it first and then you can move to a bigger plan.",
      terminated: "This account is closed.",
      failed: "This account did not finish setting up. Raise a request and we will look at it.",
    };
    return NextResponse.json(
      { error: why[account.status] ?? "This account's plan cannot be changed right now." },
      { status: 409 },
    );
  }

  /* The plan as it really is. `plan_code` is the field provisioning writes;
     `da_package` is DirectAdmin's own name for the same thing and is the fallback
     for rows provisioned before plan_code existed. */
  const currentRaw = account.plan_code ?? account.da_package ?? account.plan_name;
  const current = planFromCode(currentRaw);
  const options = upgradeOptions(currentRaw);

  if (!current) {
    return NextResponse.json(
      {
        error:
          "We cannot tell which plan this account is on, so we cannot offer an upgrade. Raise a request and we will get it sorted.",
      },
      { status: 409 },
    );
  }
  if (options.length === 0) {
    return NextResponse.json(
      { error: `${current.name} is our largest plan, so there is nothing bigger to move to. Talk to us about a server of your own.` },
      { status: 409 },
    );
  }

  const wanted = options.find((p) => p.code === planFromCode(parsed.data.requested_plan_code)?.code);
  if (!wanted) {
    return NextResponse.json(
      {
        error: `That is not an upgrade from ${current.name}. You can move to ${options.map((p) => p.name).join(" or ")}.`,
      },
      { status: 400 },
    );
  }

  const { data: created, error } = await supabase
    .from("hosting_plan_changes")
    .insert({
      tenant_id: account.tenant_id,
      hosting_account_id: account.id,
      customer_id: account.customer_id,
      domain_name: account.domain_name,
      /* From the ACCOUNT, not the body. This is what makes a stale request
         detectable at approval time — see the table's own comment. */
      from_plan_code: current.code,
      requested_plan_code: wanted.code,
      note: parsed.data.note ?? null,
      requested_by_email: session.userEmail ?? null,
      status: "pending",
    })
    .select("id")
    .single();

  if (error) {
    /* 23505 is `uq_hosting_plan_changes_one_pending`. The index is the real guard
       rather than a read-then-insert, because two taps in the same second both
       pass a prior read. The customer gets told what is already true. */
    if (error.code === "23505") {
      return NextResponse.json(
        {
          error: `You have already asked to upgrade ${account.domain_name}. We are on it and will come back to you with the price.`,
        },
        { status: 409 },
      );
    }
    console.error("[portal/hosting/upgrade]", error.message);
    return NextResponse.json({ error: "Could not send that just now. Please try again." }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    id: created.id,
    from: current.name,
    to: wanted.name,
    /* Deliberately no amount. It is worked out at approval, and quoting one here
       would show a number that is not the one charged. */
    message: `We have your request to move ${account.domain_name} from ${current.name} to ${wanted.name}. We will send you the price for the rest of your term.`,
  });
}
