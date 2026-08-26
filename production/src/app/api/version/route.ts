/**
 * GET /api/version — kaun sa commit live hai.
 *
 * ─── YE KYUN BANA ───────────────────────────────────────────────────────────
 * 26 Aug 2026. "Deploy aa gaya?" ka jawab teen baar kahin se nahi mila:
 *
 *   • `gcloud builds` — auth expire tha, aur `gcloud auth login` interactive hai
 *   • GitHub commit status — Cloud Build wahan kuch report hi nahi karta (0 statuses)
 *   • app khud — kuch nahi batati thi
 *
 * To do baar timer par bharosa karna pada, aur ek baar wo andaza GALAT tha: main keh
 * chuka tha ki ~10 minute me aa gaya hoga, aur naap kar dekha to purana code chal raha
 * tha. Pichhle deploy 6:00 aur 7:40 me aaye the, teesra 13 minute me bhi nahi aaya.
 *
 * Deploy ke aane ko naapna sirf soochna nahi hai — usi par ye faisla tikta hai ki
 * "Connect dabana surakshit hai ya nahi", kyunki purana code Google ki ek scope gira
 * deta tha. Andaza wahan mehnga tha.
 *
 * ─── ISME KYA NAHI HAI, AUR KYUN ────────────────────────────────────────────
 * Ye route JAAN-BOOJHKAR public hai — auth ke peeche rakhne se wahi kaam nahi hota
 * jiske liye ye bana (bahar se ek curl se naap lena). Isliye isme sirf wo teen cheez
 * hain jo bahar se koi bhi anuman lagakar bata sakta hai:
 *
 *   • commit ka short SHA — repo private hai; SHA se koi darwaza nahi khulta
 *   • Cloud Build ka build id — us build ko console me dhoondhne ke liye
 *   • node ka version
 *
 * Aur isme ye kabhi nahi jayega: `process.env` ka dump, koi key, koi tenant ki ginti,
 * koi DB ka haal. Ek version endpoint ko "sab kuch bata dene wala" banane ka man karta
 * hai, aur wo theek us din mehnga padta hai jis din koi use dhoondh leta hai.
 *
 * `/api/health/money` se alag: wo poochhta hai "sab theek chal raha hai?". Ye poochhta
 * hai "tum kaun ho?" — do alag sawaal, do alag jawab.
 */
import { NextResponse } from "next/server";

/* Cache se ye route bemaani ho jata. Ek stale version endpoint us bharam ka source hai
   jise ye theek karne aaya tha — aur wo bharam chup-chaap hota hai. */
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  /* `dev` = local dev ya koi aisa build jisme build-arg nahi gaya. Khaali string ke
     bajaye ek shabd, taaki `sha: ""` dekhkar koi "bug hai" na samjhe. */
  const sha = process.env.BUILD_SHA?.trim() || "dev";
  const buildId = process.env.BUILD_ID?.trim() || null;

  return NextResponse.json(
    { sha, buildId, node: process.version },
    {
      headers: {
        /* Teen tarah ke cache mana kiye ja rahe hain: browser, Cloud Run/CDN, aur koi bhi
           beech ka proxy. Ek bhi chhoot jaye to ye route purana jawab de sakta hai. */
        "Cache-Control": "no-store, max-age=0, must-revalidate",
        "CDN-Cache-Control": "no-store",
      },
    },
  );
}
