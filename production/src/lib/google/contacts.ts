/**
 * Google People API client + two-way Contacts sync engine.
 *
 * Direction & conflict model (v1, last-write-wins):
 *   1. PULL  — fetch Google changes (incremental via nextSyncToken) and upsert
 *              into our `contacts` table, matched by external_id (= Google
 *              resourceName), falling back to primary email to avoid dupes.
 *   2. PUSH  — send local changes back: contacts edited in the app since their
 *              last sync are updated on Google; contacts created in the app
 *              (no resourceName yet) are created on Google.
 * Because PULL runs first and stamps google_synced_at, a contact touched on both
 * sides ends up with Google's value applied then re-pushed — i.e. the most-recent
 * writer effectively wins, and there's no echo loop.
 *
 * All DB access uses the service-role admin client (RLS-bypassing), so EVERY
 * query is explicitly scoped by tenant_id.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, ContactChannel } from "@/lib/supabase/database.types";
import { googleOAuthCreds, refreshAccessToken } from "@/lib/google/oauth";

type Admin = SupabaseClient<Database>;

const PERSON_FIELDS = "names,emailAddresses,phoneNumbers,organizations,biographies,urls,metadata";
const BASE = "https://people.googleapis.com/v1";

// ── Google People API person (subset we read/write) ─────────────────────────
interface GPerson {
  resourceName?: string;
  etag?: string;
  names?: { displayName?: string; givenName?: string; familyName?: string }[];
  emailAddresses?: { value?: string; type?: string }[];
  phoneNumbers?: { value?: string; type?: string }[];
  organizations?: { name?: string; title?: string }[];
  biographies?: { value?: string; contentType?: string }[];
  urls?: { value?: string }[];
  metadata?: { deleted?: boolean };
}

const EMAIL_LABELS = new Set(["work", "home", "other"]);
const PHONE_LABELS = new Set(["mobile", "work", "home", "other"]);

function normLabel(type: string | undefined, allowed: Set<string>, fallback: string): string {
  const t = (type ?? "").toLowerCase();
  return allowed.has(t) ? t : fallback;
}

// ── Mapping ─────────────────────────────────────────────────────────────────
interface ContactFields {
  full_name: string;
  emails: ContactChannel[];
  phones: ContactChannel[];
  email: string | null;
  phone: string | null;
  company: string | null;
  title: string | null;
  notes: string | null;
  website: string | null;
}

function personToContact(p: GPerson): ContactFields {
  const emails: ContactChannel[] = (p.emailAddresses ?? [])
    .map((e) => ({ value: (e.value ?? "").trim(), label: normLabel(e.type, EMAIL_LABELS, "other") }))
    .filter((e) => e.value !== "");
  const phones: ContactChannel[] = (p.phoneNumbers ?? [])
    .map((e) => ({ value: (e.value ?? "").trim(), label: normLabel(e.type, PHONE_LABELS, "mobile") }))
    .filter((e) => e.value !== "");
  const org = p.organizations?.[0];
  const displayName =
    p.names?.[0]?.displayName ||
    [p.names?.[0]?.givenName, p.names?.[0]?.familyName].filter(Boolean).join(" ") ||
    emails[0]?.value ||
    phones[0]?.value ||
    "(no name)";
  return {
    full_name: displayName,
    emails,
    phones,
    email: emails[0]?.value ?? null,
    phone: phones[0]?.value ?? null,
    company: org?.name?.trim() || null,
    title: org?.title?.trim() || null,
    notes: p.biographies?.[0]?.value?.trim() || null,
    website: p.urls?.[0]?.value?.trim() || null,
  };
}

interface LocalContact {
  id: string;
  full_name: string;
  emails: ContactChannel[] | null;
  phones: ContactChannel[] | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  title: string | null;
  notes: string | null;
  website: string | null;
  external_id: string | null;
  google_etag: string | null;
  google_synced_at: string | null;
  updated_at: string | null;
}

function contactToPerson(c: LocalContact): GPerson {
  const parts = (c.full_name ?? "").trim().split(/\s+/);
  const givenName = parts[0] ?? c.full_name ?? "";
  const familyName = parts.slice(1).join(" ");
  const emails = (c.emails?.length ? c.emails : c.email ? [{ value: c.email, label: "other" }] : []);
  const phones = (c.phones?.length ? c.phones : c.phone ? [{ value: c.phone, label: "mobile" }] : []);
  return {
    names: [{ givenName, familyName: familyName || undefined }],
    emailAddresses: emails.map((e) => ({ value: e.value, type: e.label })),
    phoneNumbers: phones.map((p) => ({ value: p.value, type: p.label })),
    organizations: c.company || c.title ? [{ name: c.company || undefined, title: c.title || undefined }] : [],
    biographies: c.notes ? [{ value: c.notes, contentType: "TEXT_PLAIN" }] : [],
    urls: c.website ? [{ value: c.website }] : [],
  };
}

// ── Token ───────────────────────────────────────────────────────────────────
export async function getFreshAccessToken(admin: Admin, userId: string): Promise<string> {
  const { data: tok } = await admin
    .from("user_google_tokens")
    .select("access_token, refresh_token, token_expiry")
    .eq("user_id", userId)
    .maybeSingle();
  if (!tok || (!tok.access_token && !tok.refresh_token)) throw new Error("Google Contacts not connected");

  const exp = tok.token_expiry ? Date.parse(tok.token_expiry) : 0;
  if (tok.access_token && exp > Date.now() + 60_000) return tok.access_token;

  if (!tok.refresh_token) throw new Error("No refresh token — please reconnect Google Contacts");
  const creds = googleOAuthCreds();
  if (!creds) throw new Error("Google OAuth not configured");
  const r = await refreshAccessToken(tok.refresh_token, creds);
  const expiry = new Date(Date.now() + (r.expires_in ?? 3600) * 1000).toISOString();
  await admin.from("user_google_tokens").update({ access_token: r.access_token, token_expiry: expiry }).eq("user_id", userId);
  return r.access_token;
}

// ── People API calls ─────────────────────────────────────────────────────────
class SyncTokenExpired extends Error {}

async function listConnections(
  accessToken: string,
  syncToken: string | null,
): Promise<{ people: GPerson[]; nextSyncToken: string | null }> {
  const people: GPerson[] = [];
  let pageToken: string | undefined;
  let nextSyncToken: string | null = null;
  do {
    const p = new URLSearchParams({ personFields: PERSON_FIELDS, pageSize: "200", requestSyncToken: "true" });
    if (syncToken) p.set("syncToken", syncToken);
    if (pageToken) p.set("pageToken", pageToken);
    const res = await fetch(`${BASE}/people/me/connections?${p.toString()}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 410) throw new SyncTokenExpired(); // sync token invalid → full resync
    if (!res.ok) throw new Error(`People list failed: ${res.status} ${await res.text().catch(() => "")}`);
    const data = (await res.json()) as { connections?: GPerson[]; nextPageToken?: string; nextSyncToken?: string };
    if (data.connections) people.push(...data.connections);
    pageToken = data.nextPageToken;
    if (data.nextSyncToken) nextSyncToken = data.nextSyncToken;
  } while (pageToken);
  return { people, nextSyncToken };
}

async function createGoogleContact(accessToken: string, person: GPerson): Promise<GPerson> {
  const res = await fetch(`${BASE}/people:createContact`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify(person),
  });
  if (!res.ok) throw new Error(`People create failed: ${res.status} ${await res.text().catch(() => "")}`);
  return (await res.json()) as GPerson;
}

async function updateGoogleContact(accessToken: string, resourceName: string, etag: string | null, person: GPerson): Promise<GPerson> {
  const fields = "names,emailAddresses,phoneNumbers,organizations,biographies,urls";
  const res = await fetch(`${BASE}/${resourceName}:updateContact?updatePersonFields=${encodeURIComponent(fields)}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ ...person, etag: etag ?? undefined }),
  });
  if (!res.ok) throw new Error(`People update failed: ${res.status} ${await res.text().catch(() => "")}`);
  return (await res.json()) as GPerson;
}

function newContactId(): string {
  return "C-" + Date.now().toString(36).toUpperCase() + "-" + Math.floor(Math.random() * 1000).toString(36).toUpperCase();
}

export interface SyncResult { pulled: number; pushed: number; created: number }

// ── The engine ───────────────────────────────────────────────────────────────
export async function syncUserContacts(admin: Admin, userId: string, tenantId: string): Promise<SyncResult> {
  const accessToken = await getFreshAccessToken(admin, userId);

  const { data: tokRow } = await admin.from("user_google_tokens").select("sync_token").eq("user_id", userId).maybeSingle();
  let syncToken = tokRow?.sync_token ?? null;

  // ── PULL ──
  let people: GPerson[] = [];
  let nextSyncToken: string | null = null;
  try {
    ({ people, nextSyncToken } = await listConnections(accessToken, syncToken));
  } catch (e) {
    if (e instanceof SyncTokenExpired) {
      syncToken = null;
      ({ people, nextSyncToken } = await listConnections(accessToken, null));
    } else {
      throw e;
    }
  }

  let pulled = 0;
  for (const p of people) {
    if (!p.resourceName) continue;
    const now = new Date().toISOString();

    if (p.metadata?.deleted) {
      // Contact deleted in Google → unlink locally (keep the row + history).
      await admin.from("contacts")
        .update({ external_id: null, google_etag: null, google_synced_at: now })
        .eq("tenant_id", tenantId).eq("external_id", p.resourceName);
      pulled++;
      continue;
    }

    const fields = personToContact(p);
    const { data: existing } = await admin.from("contacts")
      .select("id").eq("tenant_id", tenantId).eq("external_id", p.resourceName).maybeSingle();

    if (existing) {
      await admin.from("contacts").update({ ...fields, google_etag: p.etag ?? null, google_synced_at: now, source: "google_api" }).eq("id", existing.id);
    } else {
      // Avoid dupes: fold into an unlinked local contact with the same primary email.
      let matchId: string | null = null;
      if (fields.email) {
        const { data: m } = await admin.from("contacts")
          .select("id").eq("tenant_id", tenantId).eq("email", fields.email).is("external_id", null).maybeSingle();
        matchId = m?.id ?? null;
      }
      if (matchId) {
        await admin.from("contacts").update({ ...fields, external_id: p.resourceName, google_etag: p.etag ?? null, google_synced_at: now, source: "google_api" }).eq("id", matchId);
      } else {
        await admin.from("contacts").insert({
          id: newContactId(), tenant_id: tenantId, source: "google_api", status: "engaged",
          external_id: p.resourceName, google_etag: p.etag ?? null, google_synced_at: now, ...fields,
        });
      }
    }
    pulled++;
  }

  // ── PUSH ── local contacts changed since their last sync, + brand-new ones.
  const { data: locals } = await admin.from("contacts")
    .select("id, full_name, emails, phones, email, phone, company, title, notes, website, external_id, google_etag, google_synced_at, updated_at")
    .eq("tenant_id", tenantId);

  let pushed = 0;
  let created = 0;
  for (const c of (locals ?? []) as LocalContact[]) {
    const hasSomething = c.full_name?.trim() || c.email || c.phone || (c.emails?.length ?? 0) > 0 || (c.phones?.length ?? 0) > 0;
    if (!hasSomething) continue;

    const syncedAt = c.google_synced_at ? Date.parse(c.google_synced_at) : 0;
    const updatedAt = c.updated_at ? Date.parse(c.updated_at) : 0;

    try {
      if (c.external_id) {
        if (updatedAt > syncedAt + 1000) { // local edited after last sync → push update
          const updated = await updateGoogleContact(accessToken, c.external_id, c.google_etag, contactToPerson(c));
          await admin.from("contacts").update({ google_etag: updated.etag ?? null, google_synced_at: new Date().toISOString() }).eq("id", c.id);
          pushed++;
        }
      } else {
        // Created in the app, not yet in Google → create it there.
        const createdP = await createGoogleContact(accessToken, contactToPerson(c));
        await admin.from("contacts").update({
          external_id: createdP.resourceName ?? null,
          google_etag: createdP.etag ?? null,
          google_synced_at: new Date().toISOString(),
        }).eq("id", c.id);
        created++;
      }
    } catch (e) {
      console.error(`[google-contacts] push failed for ${c.id}:`, e);
      // Skip this one; don't fail the whole sync.
    }
  }

  await admin.from("user_google_tokens").update({
    sync_token: nextSyncToken ?? syncToken,
    last_synced_at: new Date().toISOString(),
    last_error: null,
  }).eq("user_id", userId);

  return { pulled, pushed, created };
}
