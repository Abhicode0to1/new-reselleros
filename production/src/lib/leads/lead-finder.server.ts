/**
 * AI Lead Finder — the run. Discovery (Gemini + Google Search grounding) → dedupe against
 * leads, customers and earlier candidates → public signals (MX via DNS-over-HTTPS, website
 * fetch, published contacts from the company's own site) → baseline score + AI wording →
 * lead_finder_candidates. A run never touches `leads`; only enrichCandidateContacts fills an
 * already-approved lead's empty email/phone.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { resolveGeminiConfig, geminiJson, geminiGroundedText } from "@/lib/ai/gemini";
import { resolveDoh, DNS_TYPE } from "@/lib/dns/doh";
import {
  discoveryPrompt, parseDiscovery, mxProvider, siteNote, baselineScore, scoringPrompt, mergeScores,
  type FinderProfile, type DiscoveredCompany, type ScoreInput, type SiteAudit, type MxProvider,
} from "@/lib/leads/lead-finder";
import { CONTACT_PATHS, contactBonus, extractContacts, pickEmail, pickPhone, reachable, readContact, type ContactResult } from "@/lib/leads/lead-contacts";

type Admin = SupabaseClient<Database>;

export interface FinderRunResult { discovered: number; skippedDupe: number; saved: number; noContact: number; errors: string[] }

async function mxLookup(domain: string): Promise<{ provider: MxProvider; hosts: string[] | null }> {
  const r = await resolveDoh(domain, DNS_TYPE.MX, 5000);
  if (!r.ok) return r.kind === "nxdomain" ? { provider: "none", hosts: [] } : { provider: "unknown", hosts: null };
  return { provider: mxProvider(r.data), hosts: r.data };
}

async function probe(url: string): Promise<{ ok: boolean; status: number | null; server: string | null; generator: string | null; title: string | null }> {
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(8000), headers: { "user-agent": "Mozilla/5.0 (compatible; ResellerOS-LeadFinder/1.0)" } });
    let generator: string | null = null, title: string | null = null;
    if (res.ok && (res.headers.get("content-type") ?? "").includes("html")) {
      const html = (await res.text()).slice(0, 60_000);
      generator = html.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)/i)?.[1] ?? null;
      title = html.match(/<title[^>]*>([^<]{1,200})/i)?.[1]?.trim() ?? null;
    }
    return { ok: res.ok, status: res.status, server: res.headers.get("server"), generator, title };
  } catch { return { ok: false, status: null, server: null, generator: null, title: null }; }
}

const UA = { "user-agent": "Mozilla/5.0 (compatible; ResellerOS-LeadFinder/1.0)" };

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(6000), headers: UA });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("html")) return null;
    return (await res.text()).slice(0, 200_000);
  } catch { return null; }
}

/** Read the company's own site — home, then contact/about pages — for published contacts. At most 4 fetches. */
export async function findContacts(domain: string, website?: string | null): Promise<ContactResult> {
  const emails: string[] = [], phones: string[] = [];
  let source: string | null = null;
  const take = (html: string, url: string) => {
    const got = extractContacts(html, domain);
    const before = emails.length + phones.length;
    for (const e of got.emails) if (!emails.includes(e)) emails.push(e);
    for (const ph of got.phones) if (!phones.includes(ph)) phones.push(ph);
    if (!source && emails.length + phones.length > before) source = url;
  };

  // Home page; a site with no working HTTPS is tried once over HTTP.
  let base = `https://${domain}`;
  let home = website || base;
  let html = await fetchHtml(home);
  if (!html) { base = `http://${domain}`; home = base; html = await fetchHtml(home); }
  if (html) take(html, home);
  else return { email: null, phone: null, emails: [], phones: [], source_url: null, checked_at: new Date().toISOString() };

  // Then up to 3 contact/about pages, stopping once we have both an email and a phone.
  for (const path of CONTACT_PATHS.slice(0, 3)) {
    if (emails.length && phones.length) break;
    const url = base + path;
    const page = await fetchHtml(url);
    if (page) take(page, url);
  }
  return { email: pickEmail(emails, domain), phone: pickPhone(phones), emails: emails.slice(0, 5), phones: phones.slice(0, 5), source_url: source, checked_at: new Date().toISOString() };
}

/**
 * Contacts for candidates found before this step existed (or re-check one). Fills the
 * lead too when the candidate was already approved and the lead has no email/phone yet.
 */
export async function enrichCandidateContacts(admin: Admin, tenantId: string, opts: { ids?: string[]; limit?: number; force?: boolean } = {}): Promise<{ checked: number; found: number; removed: number }> {
  let q = admin.from("lead_finder_candidates").select("id, domain, website, signals, lead_id, status").eq("tenant_id", tenantId);
  // A re-check of one card may be an auto-rejected one; the bulk pass skips anything rejected.
  q = opts.ids?.length ? q.in("id", opts.ids) : q.neq("status", "rejected");
  const { data } = await q.order("score", { ascending: false }).limit(200);
  // Never checked, or checked and still unreachable while sitting in Review (sites add a contact page later).
  const todo = (data ?? []).filter((c) => opts.force || !readContact(c.signals) || (c.status === "new" && !reachable(readContact(c.signals)))).slice(0, opts.limit ?? 25);
  let found = 0, removed = 0;
  for (let i = 0; i < todo.length; i += 4) {
    await Promise.all(todo.slice(i, i + 4).map(async (c) => {
      const contact = await findContacts(c.domain, c.website);
      if (contact.email || contact.phone) found++;
      else if (c.status === "new") removed++;
      const prev = (c.signals as Record<string, unknown>) ?? {};
      const ok = reachable(contact);
      const signals: Record<string, unknown> = { ...prev, contact };
      // Same rule as a run: nothing to call or write to → out of Review; found later → back in.
      let status = c.status;
      if (!ok && c.status === "new") { status = "rejected"; signals.auto_rejected = "no-contact"; }
      if (ok && c.status === "rejected" && prev.auto_rejected) { status = "new"; delete signals.auto_rejected; }
      await admin.from("lead_finder_candidates").update({ signals: signals as never, status }).eq("id", c.id).eq("tenant_id", tenantId);
      if (c.lead_id && (contact.email || contact.phone)) {
        const { data: lead } = await admin.from("leads").select("contact_email, contact_phone").eq("id", c.lead_id).eq("tenant_id", tenantId).maybeSingle();
        const patch: { contact_email?: string; contact_phone?: string } = {};
        if (lead && !lead.contact_email && contact.email) patch.contact_email = contact.email;
        if (lead && !lead.contact_phone && contact.phone) patch.contact_phone = contact.phone;
        if (Object.keys(patch).length) await admin.from("leads").update(patch).eq("id", c.lead_id).eq("tenant_id", tenantId);
      }
    }));
  }
  return { checked: todo.length, found, removed };
}

async function auditSite(domain: string): Promise<SiteAudit> {
  const https = await probe(`https://${domain}`);
  const http = https.ok ? { ok: true, status: https.status, server: https.server, generator: https.generator, title: https.title } : await probe(`http://${domain}`);
  return siteNote({ httpsOk: https.ok, httpOk: http.ok, status: https.status ?? http.status, server: https.server ?? http.server, generator: https.generator ?? http.generator, title: https.title ?? http.title });
}

async function knownDomains(admin: Admin, tenantId: string): Promise<Set<string>> {
  const [leads, customers, cands] = await Promise.all([
    admin.from("leads").select("domain, contact_email").eq("tenant_id", tenantId),
    admin.from("customers").select("domain, contact_email").eq("tenant_id", tenantId),
    admin.from("lead_finder_candidates").select("domain").eq("tenant_id", tenantId),
  ]);
  const out = new Set<string>();
  const add = (d: string | null | undefined) => { const x = d?.trim().toLowerCase().replace(/^www\./, ""); if (x) out.add(x); };
  for (const r of leads.data ?? []) { add(r.domain); add(r.contact_email?.split("@")[1]); }
  for (const r of customers.data ?? []) { add(r.domain); add(r.contact_email?.split("@")[1]); }
  for (const r of cands.data ?? []) add(r.domain);
  return out;
}

export async function runLeadFinder(admin: Admin, tenantId: string, profileId: string, trigger: "manual" | "cron"): Promise<FinderRunResult> {
  const { data: profile } = await admin.from("lead_finder_profiles").select("*").eq("id", profileId).eq("tenant_id", tenantId).maybeSingle();
  if (!profile) throw new Error("Profile nahi mila.");
  const { data: run } = await admin.from("lead_finder_runs").insert({ tenant_id: tenantId, profile_id: profileId, trigger }).select("id").single();
  const result: FinderRunResult = { discovered: 0, skippedDupe: 0, saved: 0, noContact: 0, errors: [] };
  const finish = async (ok: boolean, error?: string) => {
    if (run?.id) await admin.from("lead_finder_runs").update({ finished_at: new Date().toISOString(), ok, error: error ?? (result.errors.join(" | ") || null), discovered: result.discovered, skipped_dupe: result.skippedDupe, saved: result.saved }).eq("id", run.id);
    await admin.from("lead_finder_profiles").update({ last_run_at: new Date().toISOString() }).eq("id", profileId);
  };

  try {
    const cfg = await resolveGeminiConfig(admin, tenantId);
    if (!cfg.apiKey) {
      // dev:local blanks every live key on purpose (scripts/dev-local.mjs), so on a laptop
      // "go to Settings" sends people hunting for a key that was switched off deliberately.
      throw new Error(process.env.NEXT_PUBLIC_APP_ENV === "local"
        ? "Local mode (dev:local) mein AI band hai — live keys jaan-boojh kar band hoti hain. AI test karna ho to isi local app ki Settings → Integrations → AI mein apni Gemini key daalo."
        : "Gemini API key nahi hai — Settings → Integrations → AI mein daalo.");
    }
    const p: FinderProfile = { name: profile.name, cities: profile.cities, industries: profile.industries, company_size: profile.company_size, products: profile.products, must_have: profile.must_have, exclude: profile.exclude, daily_limit: profile.daily_limit };
    const known = await knownDomains(admin, tenantId);

    // Ask for well over the cap: some are duplicates, and about a third publish no phone/email.
    const want = Math.min(60, Math.ceil(p.daily_limit * 2.5));
    const dp = discoveryPrompt(p, [...known].slice(-150), want);
    const text = await geminiGroundedText({ apiKey: cfg.apiKey, model: cfg.model, system: dp.system, user: dp.user, label: "leads/finder-discovery" });
    const found: DiscoveredCompany[] = parseDiscovery(text);
    result.discovered = found.length;
    if (found.length === 0) { await finish(false, "Gemini ne koi company nahi di — profile ko aur specific karo (city + industry)."); return result; }

    const fresh = found.filter((c) => !known.has(c.domain));
    result.skippedDupe = found.length - fresh.length;

    // Signals, a few at a time (DNS + site + contact pages each). Keep going until the day's
    // cap of REACHABLE companies is met; the unreachable ones are still saved (so they are not
    // suggested again) but straight into Rejected, with the reason on the card.
    const batch: DiscoveredCompany[] = [];
    const inputs: ScoreInput[] = [];
    const extras: { mx_hosts: string[] | null; site: SiteAudit; contact: ContactResult }[] = [];
    const maxChecks = Math.min(fresh.length, p.daily_limit * 3, 60);
    let reachableCount = 0;
    for (let i = 0; i < maxChecks && reachableCount < p.daily_limit; i += 5) {
      const chunk = fresh.slice(i, Math.min(i + 5, maxChecks));
      const sig = await Promise.all(chunk.map(async (c) => ({ mx: await mxLookup(c.domain), site: await auditSite(c.domain), contact: await findContacts(c.domain, c.website) })));
      chunk.forEach((c, k) => {
        if (reachable(sig[k].contact)) { if (reachableCount >= p.daily_limit) return; reachableCount++; }
        batch.push(c);
        inputs.push({ company: c.company, domain: c.domain, city: c.city ?? null, description: c.description ?? null, mx: sig[k].mx.provider, site: sig[k].site, products: p.products });
        extras.push({ mx_hosts: sig[k].mx.hosts, site: sig[k].site, contact: sig[k].contact });
      });
    }

    const baselines = inputs.map(baselineScore);
    const sp = scoringPrompt(inputs, baselines);
    const ai = inputs.length ? await geminiJson<unknown>({ apiKey: cfg.apiKey, model: cfg.model, system: sp.system, user: sp.user, temperature: 0.3, timeoutMs: 45_000, label: "leads/finder-score", onFailure: (why) => result.errors.push(`AI scoring skip: ${why}`) }) : null;
    const scores = mergeScores(inputs, baselines, ai);

    const rows = inputs.map((inp, k) => {
      const ok = reachable(extras[k].contact);
      return {
      tenant_id: tenantId, profile_id: profileId, run_id: run?.id ?? null,
      company: inp.company, domain: inp.domain, website: batch[k].website ?? `https://${inp.domain}`, city: inp.city, description: inp.description, source_url: batch[k].source_url ?? null,
      mx_provider: inp.mx, on_workspace: inp.mx === "google" ? true : inp.mx === "unknown" ? null : false,
      site_https: inp.site.https, site_status: inp.site.status, site_note: inp.site.note,
      signals: ok
        ? { mx_hosts: extras[k].mx_hosts, server: extras[k].site.server ?? null, generator: extras[k].site.generator ?? null, contact: extras[k].contact }
        : { mx_hosts: extras[k].mx_hosts, server: extras[k].site.server ?? null, generator: extras[k].site.generator ?? null, contact: extras[k].contact, auto_rejected: "no-contact" },
      score: Math.min(100, scores[k].score + contactBonus(extras[k].contact)), product: scores[k].product, fit_reason: scores[k].fit_reason, pitch: scores[k].pitch,
      status: (ok ? "new" : "rejected") as "new" | "rejected",
      };
    });
    result.noContact = rows.filter((r) => r.status === "rejected").length;
    if (rows.length) {
      const { error } = await admin.from("lead_finder_candidates").upsert(rows, { onConflict: "tenant_id,domain", ignoreDuplicates: true });
      if (error) throw new Error(error.message);
      result.saved = rows.length - result.noContact;
    }
    await finish(result.errors.length === 0);
    return result;
  } catch (e) {
    await finish(false, (e as Error).message);
    throw e;
  }
}

/** Every enabled profile of every tenant — the nightly cron. */
export async function runAllLeadFinders(admin: Admin): Promise<{ profiles: number; saved: number; errors: string[] }> {
  const { data: profiles } = await admin.from("lead_finder_profiles").select("id, tenant_id").eq("enabled", true);
  const out = { profiles: 0, saved: 0, errors: [] as string[] };
  for (const p of profiles ?? []) {
    try { const r = await runLeadFinder(admin, p.tenant_id, p.id, "cron"); out.profiles++; out.saved += r.saved; out.errors.push(...r.errors); }
    catch (e) { out.errors.push(`${p.id}: ${(e as Error).message}`); }
  }
  return out;
}
