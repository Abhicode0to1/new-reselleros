/**
 * Off-site backup — raat wale snapshot ko database ke BAHAR rakhne ka faisla.
 *
 * ─── YE KYUN HAI ────────────────────────────────────────────────────────────
 * `backup_all_tenants()` roz 00:00 IST par chalta hai aur sach me chalta hai — 29 Aug 2026
 * ko teeno tenant ke us raat ke snapshot maujood mile. Par wo `backup.snapshots` me hain,
 * yaani **usi database ke andar jiska wo backup hain**. Project gaya to backup bhi saath
 * jayega, aur is plan par Supabase ka apna koi backup nahi hai.
 *
 * Database ke bahar ki ekmatra copy laptop par thi, haath se banti thi, aur 29 Aug ko teen
 * din purani nikli. 26 Aug ko data reset ho chuka hai — yaani ab jo bhi banega wo ASLI hai.
 * Abhi tak jo kho sakta tha wo nakli tha; aaj se nahi.
 *
 * Ye file sirf FAISLE rakhti hai — naam kya ho, khidki kya ho, kya galti maani jaye. Network
 * ka kaam route me hai, taaki ye sab bina kisi upload ke test ho sake.
 */

/** Bucket ek doosre REGION me hai (asia-south2 / Delhi), jabki DB aur app dono Mumbai me. */
export const OFFSITE_BUCKET = "resellsubsos-prod-offsite-backups";

/** Snapshot itni der pehle tak ka chalega. Cron ke turant baad chalta hai, par ek ghanta
 *  patla hai — retry, thoda late scheduler, ya ek dheema sweep aur khidki khaali. */
export const OFFSITE_WINDOW_HOURS = 20;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Object ka naam — IST ki tareekh par, UTC par NAHI.
 *
 * Cron 00:00 IST par chalta hai, jo 18:30 UTC hai — PICHHLE din ka. UTC se naam banate to
 * har raat ka backup ek din purani tareekh par chadhta, aur "29 tareekh ka backup kahan hai"
 * ka jawab hamesha ek din khiska hua milta. Ye galti mahine bhar dikhti bhi nahi.
 */
export function offsiteObjectName(now: Date): string {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const d = String(ist.getUTCDate()).padStart(2, "0");
  /* Ek din, ek naam. Dobara chalane par purana object OVERWRITE hota hai, ek naya nahi
     banta — aur bucket par versioning on hai, to pichhli copy phir bhi bachi rehti hai.
     Har run par naya naam banate to 400 din me 400 nahi, hazaaron object hote, aur "aaj ka
     backup hai ya nahi" ek listing padhne ka kaam ban jata. */
  return `daily/${y}-${m}-${d}.json`;
}

/** Kis waqt ke baad ke snapshot lene hain. */
export function offsiteWindowStart(now: Date, hours = OFFSITE_WINDOW_HOURS): Date {
  return new Date(now.getTime() - hours * 3600_000);
}

export interface OffsiteSnapshot {
  tenant_id: string;
  tenant_name: string | null;
  snapshot_id: string;
  created_at: string;
  payload: unknown;
}

export interface OffsiteEnvelope {
  kind: "resellersos-offsite-backup";
  taken_at_utc: string;
  ist_date: string;
  project_ref: string;
  tenant_count: number;
  snapshots: OffsiteSnapshot[];
}

export function offsiteEnvelope(
  now: Date,
  projectRef: string,
  snapshots: OffsiteSnapshot[],
): OffsiteEnvelope {
  return {
    kind: "resellersos-offsite-backup",
    taken_at_utc: now.toISOString(),
    ist_date: offsiteObjectName(now).slice("daily/".length).replace(".json", ""),
    project_ref: projectRef,
    tenant_count: snapshots.length,
    snapshots,
  };
}

/**
 * Kya ye upload karne layak hai — ya khaali hone ki wajah se rok dena chahiye.
 *
 * Khaali envelope upload karna sabse bura nateeja hai: bucket me aaj ka object dikhega,
 * tareekh bhi sahi hogi, aur andar kuch nahi hoga. Us din tak pata nahi chalega jab restore
 * karna pade. Isliye kuch na bhejna behtar hai — aur uski shikayat health digest me jayegi.
 */
export function offsiteRefusal(env: OffsiteEnvelope, expectedTenants: number): string | null {
  if (env.snapshots.length === 0) {
    return "koi snapshot nahi mila — sweep chala hi nahi, ya khidki chhoti pad gayi";
  }
  if (expectedTenants > 0 && env.snapshots.length < expectedTenants) {
    /* Aadha backup poore backup jaisa dikhta hai. Jis tenant ka snapshot nahi gaya wo
       surakshit lagta hai aur hai nahi — theek wahi shakl jisme sweep ki apni per-tenant
       failure chhupti thi. */
    return `${expectedTenants} tenant hain par sirf ${env.snapshots.length} ka snapshot mila`;
  }
  const empty = env.snapshots.filter((s) => s.payload === null || s.payload === undefined);
  if (empty.length > 0) {
    return `${empty.length} snapshot bina payload ke — upload to ho jata, restore nahi hota`;
  }
  return null;
}
