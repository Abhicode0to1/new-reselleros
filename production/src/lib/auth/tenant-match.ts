/**
 * Domain-based tenant matching — the half that touches the database.
 *
 * The decision itself lives in `domain.ts` and is pure. This module only fetches
 * what that decision needs, records the outcome, and tells a human about it.
 *
 * ─── EVERY FUNCTION HERE IS BEST-EFFORT ON PURPOSE ───────────────────────────
 * These run inside sign-up and OAuth callback. If a lookup, an insert, or a
 * WhatsApp notification fails, the person in front of the screen must still get a
 * coherent next step — a signup that 500s because a notification could not be
 * delivered is a worse outcome than a notification nobody received. So failures
 * are logged and swallowed, and each function returns something the caller can
 * still act on.
 */
import "server-only";
import { createAdminClient } from "@/lib/supabase/server";
import { sendWhatsApp } from "@/lib/whatsapp/client";
import { sendEmail } from "@/lib/email/send";
import {
  emailDomain,
  isPublicEmailDomain,
  resolveDomainOwner,
  type DomainMatch,
  type TenantDomainRecord,
} from "./domain";
import type { TeamInviteRole } from "@/lib/supabase/database.types";

/**
 * The tenant that owns this address's domain — or null.
 *
 * Null for every "no signal" case, which are deliberately indistinguishable to
 * the caller: unparseable address, consumer mailbox provider, unknown domain, and
 * *claimed but unverified* domain. Only `verified_at is not null` routes anyone.
 */
export async function findVerifiedDomainTenant(
  email: string | null | undefined,
): Promise<DomainMatch | null> {
  const domain = emailDomain(email);
  if (!domain || isPublicEmailDomain(domain)) return null;

  const admin = createAdminClient();
  // Fetch by domain only. The verified-vs-claimed decision is NOT made here —
  // `resolveDomainOwner` makes it, so it is covered by tests that need no
  // database. Filtering it out in SQL would put a tenant-leak guard somewhere no
  // test can reach.
  const { data, error } = await admin
    .from("tenant_domains")
    .select("tenant_id, domain, verified_at, tenants(name)")
    .eq("domain", domain);

  if (error) {
    console.error("[tenant-match] domain lookup failed:", error.message);
    return null;
  }

  // The embedded relation comes back as an object or a single-element array
  // depending on how PostgREST resolves the FK; normalise both.
  const rows: TenantDomainRecord[] = (data ?? []).map((r) => {
    const rel = (r as { tenants?: { name?: string } | Array<{ name?: string }> }).tenants;
    return {
      tenant_id:   r.tenant_id,
      tenant_name: (Array.isArray(rel) ? rel[0]?.name : rel?.name) ?? "your company's workspace",
      domain:      r.domain,
      verified_at: r.verified_at,
    };
  });

  return resolveDomainOwner(email, rows);
}

export interface OpenJoinRequestInput {
  tenantId:   string;
  email:      string;
  fullName?:  string | null;
  authUserId?: string | null;
  matchedBy:  "domain" | "manual";
  role?:      TeamInviteRole;
  note?:      string | null;
}

/**
 * Park someone in `join_requests`. Grants nothing — that is the whole design.
 *
 * Re-asking is not an error: the partial unique index allows exactly one OPEN
 * request per person per tenant, so a duplicate is reported as `alreadyPending`
 * rather than failing the signup they are in the middle of.
 */
export async function openJoinRequest(
  input: OpenJoinRequestInput,
): Promise<{ ok: boolean; alreadyPending: boolean }> {
  const admin = createAdminClient();
  const { error } = await admin.from("join_requests").insert({
    tenant_id:      input.tenantId,
    auth_user_id:   input.authUserId ?? null,
    email:          input.email.trim().toLowerCase(),
    full_name:      input.fullName ?? null,
    requested_role: input.role ?? "support",
    matched_by:     input.matchedBy,
    note:           input.note ?? null,
  });

  if (error) {
    // 23505 = the partial unique index above. They already asked; nothing to do.
    if (error.code === "23505") return { ok: true, alreadyPending: true };
    console.error("[tenant-match] join request insert failed:", error.message);
    return { ok: false, alreadyPending: false };
  }
  return { ok: true, alreadyPending: false };
}

/**
 * Tell the workspace owner somebody is waiting.
 *
 * Two channels, both best-effort, and neither is the system of record — the
 * Dashboard card reads `join_requests` directly, so a request is never lost just
 * because a message failed to send. That ordering matters: notifications are how
 * an owner finds out FAST, not how they find out AT ALL.
 *
 * ⚠️ WhatsApp will no-op until credentials are set (Settings → Integrations →
 * WhatsApp Business). As of 14 Aug 2026 they are not set for any tenant here, so
 * `sendWhatsApp` throws immediately and the catch below records that.
 */
export async function notifyOwnerOfJoinRequest(input: {
  tenantId:    string;
  tenantName:  string;
  email:       string;
  fullName?:   string | null;
  appUrl?:     string | null;
}): Promise<{ whatsapp: "sent" | "skipped"; email: "sent" | "skipped" }> {
  const admin = createAdminClient();
  const who = input.fullName?.trim() || input.email;
  const link = `${(input.appUrl ?? "").replace(/\/+$/, "")}/team`;

  const { data: tenant } = await admin
    .from("tenants")
    .select("phone, email")
    .eq("id", input.tenantId)
    .maybeSingle();

  const body =
    `${who} (${input.email}) wants to join ${input.tenantName} on ResellerOS.\n\n` +
    `They have NO access yet — nothing happens until you approve it.\n\n` +
    `Approve or reject: ${link || "open Team in ResellerOS"}`;

  let whatsapp: "sent" | "skipped" = "skipped";
  if (tenant?.phone) {
    try {
      await sendWhatsApp({
        tenantId: input.tenantId,
        to:       tenant.phone,
        message:  { kind: "text", text: body },
      });
      whatsapp = "sent";
    } catch (e) {
      // Expected while WhatsApp is unconfigured. Never fails the signup.
      console.warn("[tenant-match] WhatsApp alert skipped:", (e as Error).message);
    }
  }

  let mail: "sent" | "skipped" = "skipped";
  const { data: owner } = await admin
    .from("users")
    .select("email")
    .eq("tenant_id", input.tenantId)
    .eq("role", "owner")
    .limit(1)
    .maybeSingle();

  const to = owner?.email ?? tenant?.email ?? null;
  if (to) {
    try {
      const res = await sendEmail({
        to,
        subject: `${who} is waiting to join ${input.tenantName}`,
        text:    body,
        route:   { tenantId: input.tenantId },
        kind:    "join_request",
      });
      if (res.status === "sent") mail = "sent";
    } catch (e) {
      console.warn("[tenant-match] email alert skipped:", (e as Error).message);
    }
  }

  return { whatsapp, email: mail };
}
