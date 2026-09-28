/**
 * AI Lead Finder — the run. Discovery (Gemini + Google Search grounding) → dedupe against
 * leads, customers and earlier candidates → public signals (MX via DNS-over-HTTPS, website
 * fetch) → baseline score + AI wording → lead_finder_candidates. Nothing touches `leads`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { resolveGeminiConfig, geminiJson, geminiGroundedText } from "@/lib/ai/gemini";
import { resolveDoh, DNS_TYPE } from "@/lib/dns/doh";
import {
  discoveryPrompt, parseDiscovery, mxProvider, siteNote, baselineScore, scoringPrompt, mergeScores,
  type FinderProfile, type DiscoveredCompany, type ScoreInput, type SiteAudit, type MxProvider,
} from "@/lib/leads/lead-finder";

type Admin = SupabaseClient<Database>;

export interface FinderRunResult { discovered: number; skippedDupe: number; saved: number; errors: string[] }

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
  const result: FinderRunResult = { discovered: 0, skippedDupe: 0, saved: 0, errors: [] };
  const finish = async (ok: boolean, error?: string) => {
    if (run?.id) await admin.from("lead_finder_runs").update({ finished_at: new Date().toISOString(), ok, error: error ?? (result.errors.join(" | ") || null), discovered: result.discovered, skipped_dupe: result.skippedDupe, saved: result.saved }).eq("id", run.id);
    await admin.from("lead_finder_profiles").update({ last_run_at: new Date().toISOString() }).eq("id", profileId);
  };

  try {
    const cfg = await resolveGeminiConfig(admin, tenantId);
    if (!cfg.apiKey) throw new Error("Gemini API key nahi hai — Settings → Integrations → AI mein daalo.");
    const p: FinderProfile = { name: profile.name, cities: profile.cities, industries: profile.industries, company_size: profile.company_size, products: profile.products, must_have: profile.must_have, exclude: profile.exclude, daily_limit: profile.daily_limit };
    const known = await knownDomains(admin, tenantId);

    // Ask for a few more than the cap: some will be duplicates or fail the domain check.
    const want = Math.min(60, Math.ceil(p.daily_limit * 1.5));
    const dp = discoveryPrompt(p, [...known].slice(-150), want);
    const text = await geminiGroundedText({ apiKey: cfg.apiKey, model: cfg.model, system: dp.system, user: dp.user, label: "leads/finder-discovery" });
    const found: DiscoveredCompany[] = parseDiscovery(text);
    result.discovered = found.length;
    if (found.length === 0) { await finish(false, "Gemini ne koi company nahi di — profile ko aur specific karo (city + industry)."); return result; }

    const fresh = found.filter((c) => !known.has(c.domain));
    result.skippedDupe = found.length - fresh.length;
    const batch = fresh.slice(0, p.daily_limit);

    // Signals, a few at a time (DNS + two fetches each).
    const inputs: ScoreInput[] = [];
    const extras: { mx_hosts: string[] | null; site: SiteAudit }[] = [];
    for (let i = 0; i < batch.length; i += 5) {
      const chunk = batch.slice(i, i + 5);
      const sig = await Promise.all(chunk.map(async (c) => ({ mx: await mxLookup(c.domain), site: await auditSite(c.domain) })));
      chunk.forEach((c, k) => {
        inputs.push({ company: c.company, domain: c.domain, city: c.city ?? null, description: c.description ?? null, mx: sig[k].mx.provider, site: sig[k].site, products: p.products });
        extras.push({ mx_hosts: sig[k].mx.hosts, site: sig[k].site });
      });
    }

    const baselines = inputs.map(baselineScore);
    const sp = scoringPrompt(inputs, baselines);
    const ai = inputs.length ? await geminiJson<unknown>({ apiKey: cfg.apiKey, model: cfg.model, system: sp.system, user: sp.user, temperature: 0.3, timeoutMs: 45_000, label: "leads/finder-score", onFailure: (why) => result.errors.push(`AI scoring skip: ${why}`) }) : null;
    const scores = mergeScores(inputs, baselines, ai);

    const rows = inputs.map((inp, k) => ({
      tenant_id: tenantId, profile_id: profileId, run_id: run?.id ?? null,
      company: inp.company, domain: inp.domain, website: batch[k].website ?? `https://${inp.domain}`, city: inp.city, description: inp.description, source_url: batch[k].source_url ?? null,
      mx_provider: inp.mx, on_workspace: inp.mx === "google" ? true : inp.mx === "unknown" ? null : false,
      site_https: inp.site.https, site_status: inp.site.status, site_note: inp.site.note,
      signals: { mx_hosts: extras[k].mx_hosts, server: extras[k].site.server ?? null, generator: extras[k].site.generator ?? null },
      score: scores[k].score, product: scores[k].product, fit_reason: scores[k].fit_reason, pitch: scores[k].pitch,
    }));
    if (rows.length) {
      const { error } = await admin.from("lead_finder_candidates").upsert(rows, { onConflict: "tenant_id,domain", ignoreDuplicates: true });
      if (error) throw new Error(error.message);
      result.saved = rows.length;
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
