/**
 * Google People API client + two-way Contacts sync engine.
 *
 * Syncs EVERY person on the Contacts page — standalone contacts, leads, AND
 * customers — into the user's Google Contacts, two-way. A per-user link table
 * (google_contact_links) maps each app record to its Google resourceName, so we
 * never duplicate on re-sync and can update in place without touching the
 * leads/customers schemas.
 *
 * Direction & conflict (last-write-wins):
 *   1. PULL  — Google changes (incremental via nextSyncToken) applied back to the
 *              mapped app record. New Google contacts become standalone contacts.
 *   2. PUSH  — app records changed since their last sync are pushed to Google;
 *              unmapped records are created there.
 * PULL runs first and stamps synced_at, so a record touched on both sides gets
 * Google's value then re-pushed — most-recent writer wins, no echo loop.
 *
 * For leads/customers only the CONTACT fields (name/email/phone/company) are
 * synced — never money fields. Junk-marked leads are excluded (spam stays off
 * the phone, mirroring how the app hides them).
 *
 * All DB access uses the service-role admin client; every query is tenant-scoped.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, ContactChannel } from "@/lib/supabase/database.types";
import { googleOAuthCreds, refreshAccessToken } from "@/lib/google/oauth";

type Admin = SupabaseClient<Database>;

const PERSON_FIELDS = "names,emailAddresses,phoneNumbers,organizations,biographies,urls,metadata";
const CONTACT_MASK = "names,emailAddresses,phoneNumbers,organizations,biographies,urls";
const LEADCUST_MASK = "names,emailAddresses,phoneNumbers,organizations";
const BASE = "https://people.googleapis.com/v1";

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
const normLabel = (t: string | undefined, allowed: Set<string>, fb: string) =>
  allowed.has((t ?? "").toLowerCase()) ? (t as string).toLowerCase() : fb;

function newContactId(): string {
  return "C-" + Date.now().toString(36).toUpperCase() + "-" + Math.floor(Math.random() * 1000).toString(36).toUpperCase();
}

function splitName(full: string): { givenName: string; familyName?: string } {
  const parts = (full ?? "").trim().split(/\s+/).filter(Boolean);
  return { givenName: parts[0] ?? full ?? "", familyName: parts.slice(1).join(" ") || undefined };
}

// ── Person → contact fields (for PULL into a standalone contact) ─────────────
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
    emails[0]?.value || phones[0]?.value || "(no name)";
  return {
    full_name: displayName,
    emails, phones,
    email: emails[0]?.value ?? null,
    phone: phones[0]?.value ?? null,
    company: org?.name?.trim() || null,
    title: org?.title?.trim() || null,
    notes: p.biographies?.[0]?.value?.trim() || null,
    website: p.urls?.[0]?.value?.trim() || null,
  };
}

// ── App record → Google person (for PUSH) ────────────────────────────────────
function contactRowToPerson(c: {
  full_name: string; emails: ContactChannel[] | null; phones: ContactChannel[] | null;
  email: string | null; phone: string | null; company: string | null; title: string | null;
  notes: string | null; website: string | null;
}): GPerson {
  const emails = c.emails?.length ? c.emails : c.email ? [{ value: c.email, label: "other" }] : [];
  const phones = c.phones?.length ? c.phones : c.phone ? [{ value: c.phone, label: "mobile" }] : [];
  return {
    names: [splitName(c.full_name)],
    emailAddresses: emails.map((e) => ({ value: e.value, type: e.label })),
    phoneNumbers: phones.map((p) => ({ value: p.value, type: p.label })),
    organizations: c.company || c.title ? [{ name: c.company || undefined, title: c.title || undefined }] : [],
    biographies: c.notes ? [{ value: c.notes, contentType: "TEXT_PLAIN" }] : [],
    urls: c.website ? [{ value: c.website }] : [],
  };
}

function simplePerson(name: string | null, org: string | null, email: string | null, phone: string | null): GPerson {
  const display = (name && name.trim()) || (org && org.trim()) || email || phone || "(no name)";
  return {
    names: [splitName(display)],
    emailAddresses: email ? [{ value: email, type: "work" }] : [],
    phoneNumbers: phone ? [{ value: phone, type: "mobile" }] : [],
    organizations: org ? [{ name: org }] : [],
  };
}

// ── Token ─────────────────────────────────────────────────────────────────
export async function getFreshAccessToken(admin: Admin, userId: string): Promise<string> {
  const { data: tok } = await admin
    .from("user_google_tokens").select("access_token, refresh_token, token_expiry").eq("user_id", userId).maybeSingle();
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

// ── People API ──────────────────────────────────────────────────────────────
class SyncTokenExpired extends Error {}

async function listConnections(accessToken: string, syncToken: string | null): Promise<{ people: GPerson[]; nextSyncToken: string | null }> {
  const people: GPerson[] = [];
  let pageToken: string | undefined;
  let nextSyncToken: string | null = null;
  do {
    const p = new URLSearchParams({ personFields: PERSON_FIELDS, pageSize: "200", requestSyncToken: "true" });
    if (syncToken) p.set("syncToken", syncToken);
    if (pageToken) p.set("pageToken", pageToken);
    const res = await fetch(`${BASE}/people/me/connections?${p.toString()}`, { headers: { authorization: `Bearer ${accessToken}` } });
    if (res.status === 410) throw new SyncTokenExpired();
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

async function updateGoogleContact(accessToken: string, resourceName: string, etag: string | null, person: GPerson, mask: string): Promise<GPerson> {
  const res = await fetch(`${BASE}/${resourceName}:updateContact?updatePersonFields=${encodeURIComponent(mask)}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ ...person, etag: etag ?? undefined }),
  });
  if (!res.ok) throw new Error(`People update failed: ${res.status} ${await res.text().catch(() => "")}`);
  return (await res.json()) as GPerson;
}

export interface SyncResult { pulled: number; pushed: number; created: number }

type SourceType = "contact" | "lead" | "customer";
interface LinkRow { source_type: SourceType; source_id: string; resource_name: string; etag: string | null; synced_at: string }

// ── The engine ───────────────────────────────────────────────────────────────
export async function syncUserContacts(admin: Admin, userId: string, tenantId: string): Promise<SyncResult> {
  const accessToken = await getFreshAccessToken(admin, userId);

  // Load this user's existing links.
  const { data: linkRows } = await admin
    .from("google_contact_links")
    .select("source_type, source_id, resource_name, etag, synced_at")
    .eq("user_id", userId).eq("tenant_id", tenantId);
  const links = (linkRows ?? []) as LinkRow[];
  const byResource = new Map<string, LinkRow>(links.map((l) => [l.resource_name, l]));
  const byRecord = new Map<string, LinkRow>(links.map((l) => [`${l.source_type}:${l.source_id}`, l]));

  const now = () => new Date().toISOString();
  const upsertLink = async (st: SourceType, sid: string, resourceName: string, etag: string | null) => {
    await admin.from("google_contact_links").upsert(
      { tenant_id: tenantId, user_id: userId, source_type: st, source_id: sid, resource_name: resourceName, etag, synced_at: now() },
      { onConflict: "user_id,source_type,source_id" },
    );
  };

  // ── PULL ──
  const { data: tokRow } = await admin.from("user_google_tokens").select("sync_token").eq("user_id", userId).maybeSingle();
  let syncToken = tokRow?.sync_token ?? null;
  let people: GPerson[] = [];
  let nextSyncToken: string | null = null;
  try {
    ({ people, nextSyncToken } = await listConnections(accessToken, syncToken));
  } catch (e) {
    if (e instanceof SyncTokenExpired) { syncToken = null; ({ people, nextSyncToken } = await listConnections(accessToken, null)); }
    else throw e;
  }

  // Records touched by PULL this run — skipped in PUSH so we never echo a
  // just-pulled change straight back to Google (pull bumps the row's updated_at,
  // which would otherwise look like a fresh local edit).
  const touched = new Set<string>();

  let pulled = 0;
  for (const p of people) {
    if (!p.resourceName) continue;
    const link = byResource.get(p.resourceName);

    if (p.metadata?.deleted) {
      // Deleted in Google → drop the link (keep the app record + history).
      if (link) await admin.from("google_contact_links").delete().eq("user_id", userId).eq("resource_name", p.resourceName);
      pulled++;
      continue;
    }

    const f = personToContact(p);
    if (link) {
      // Apply Google's edit back to the mapped app record.
      if (link.source_type === "contact") {
        await admin.from("contacts").update({
          full_name: f.full_name, emails: f.emails, phones: f.phones, email: f.email, phone: f.phone,
          company: f.company, title: f.title, notes: f.notes, website: f.website, google_synced_at: now(), source: "google_api",
        }).eq("id", link.source_id).eq("tenant_id", tenantId);
      } else if (link.source_type === "lead") {
        await admin.from("leads").update({ contact_name: f.full_name, contact_email: f.email, contact_phone: f.phone }).eq("id", link.source_id).eq("tenant_id", tenantId);
      } else {
        await admin.from("customers").update({ contact_name: f.full_name, contact_email: f.email, contact_phone: f.phone }).eq("id", link.source_id).eq("tenant_id", tenantId);
      }
      await upsertLink(link.source_type, link.source_id, p.resourceName, p.etag ?? null);
      touched.add(`${link.source_type}:${link.source_id}`);
    } else {
      // New Google contact → create a standalone app contact + link.
      const id = newContactId();
      await admin.from("contacts").insert({
        id, tenant_id: tenantId, source: "google_api", status: "engaged",
        external_id: p.resourceName, google_etag: p.etag ?? null, google_synced_at: now(),
        full_name: f.full_name, emails: f.emails, phones: f.phones, email: f.email, phone: f.phone,
        company: f.company, title: f.title, notes: f.notes, website: f.website,
      });
      await upsertLink("contact", id, p.resourceName, p.etag ?? null);
      touched.add(`contact:${id}`);
    }
    pulled++;
  }

  // ── PUSH ── build the unified app-people list from all three sources.
  const [{ data: contacts }, { data: leads }, { data: customers }] = await Promise.all([
    admin.from("contacts").select("id, full_name, emails, phones, email, phone, company, title, notes, website, updated_at").eq("tenant_id", tenantId),
    admin.from("leads").select("id, company, contact_name, contact_email, contact_phone, is_junk, updated_at").eq("tenant_id", tenantId),
    admin.from("customers").select("id, name, contact_name, contact_email, contact_phone, updated_at").eq("tenant_id", tenantId),
  ]);

  interface Candidate { st: SourceType; id: string; updatedAt: number; person: GPerson; mask: string }
  const candidates: Candidate[] = [];

  for (const c of contacts ?? []) {
    if (!(c.full_name?.trim() || c.email || c.phone || (c.emails?.length ?? 0) || (c.phones?.length ?? 0))) continue;
    candidates.push({ st: "contact", id: c.id, updatedAt: c.updated_at ? Date.parse(c.updated_at) : 0, person: contactRowToPerson(c), mask: CONTACT_MASK });
  }
  for (const l of leads ?? []) {
    if (l.is_junk) continue; // spam stays off the phone
    if (!(l.contact_name || l.contact_email || l.contact_phone)) continue;
    candidates.push({ st: "lead", id: l.id, updatedAt: l.updated_at ? Date.parse(l.updated_at) : 0, person: simplePerson(l.contact_name, l.company, l.contact_email, l.contact_phone), mask: LEADCUST_MASK });
  }
  for (const cu of customers ?? []) {
    if (!(cu.contact_name || cu.contact_email || cu.contact_phone)) continue;
    candidates.push({ st: "customer", id: cu.id, updatedAt: cu.updated_at ? Date.parse(cu.updated_at) : 0, person: simplePerson(cu.contact_name, cu.name, cu.contact_email, cu.contact_phone), mask: LEADCUST_MASK });
  }

  let pushed = 0, created = 0;
  for (const cand of candidates) {
    const key = `${cand.st}:${cand.id}`;
    if (touched.has(key)) continue; // just pulled — don't echo back to Google
    const link = byRecord.get(key);
    try {
      if (link) {
        const syncedAt = link.synced_at ? Date.parse(link.synced_at) : 0;
        if (cand.updatedAt > syncedAt + 1000) {
          const updated = await updateGoogleContact(accessToken, link.resource_name, link.etag, cand.person, cand.mask);
          await upsertLink(cand.st, cand.id, link.resource_name, updated.etag ?? null);
          pushed++;
        }
      } else {
        const createdP = await createGoogleContact(accessToken, cand.person);
        if (createdP.resourceName) await upsertLink(cand.st, cand.id, createdP.resourceName, createdP.etag ?? null);
        created++;
      }
    } catch (e) {
      console.error(`[google-contacts] push failed for ${cand.st}:${cand.id}:`, e);
    }
  }

  await admin.from("user_google_tokens").update({
    sync_token: nextSyncToken ?? syncToken, last_synced_at: now(), last_error: null,
  }).eq("user_id", userId);

  return { pulled, pushed, created };
}
