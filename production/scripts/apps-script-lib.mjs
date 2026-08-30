/**
 * Apps Script ko padhne aur LIKHNE ka darwaza — bina koi key file.
 *
 * ─── YE KYUN BANA ───────────────────────────────────────────────────────────
 * 28 Aug 2026 tak Pardeep ke dono Gmail forwarder me har chhota badlav uske haath se
 * hota tha: main exact line likh kar deta, wo paste karta, phir Run dabata. Ek din me
 * ye teen baar hua, aur har baar ek galti ki gunjaish thi (`secret` banaam `SECRET`,
 * chhoot gayi line, galat file).
 *
 * Pehla raasta — `gcloud auth application-default login --scopes=...script.projects` —
 * Google ne saaf mana kar diya: "This app is blocked. This app tried to access sensitive
 * info in your Google Account." Wajah scope nahi, gcloud ka SHARED OAuth client hai.
 *
 * Isliye ye: ek apna service account + Workspace ki domain-wide delegation.
 *
 * ─── AUR KEY FILE JAAN-BOOJHKAR NAHI ────────────────────────────────────────
 * Aam tareeka `gcloud iam service-accounts keys create` hai — ek JSON jo kabhi expire
 * nahi hoti aur disk par padi rehti hai. Uski jagah yahan IAM Credentials ka `signJwt`
 * hai: Pardeep ke user ko SA par `roles/iam.serviceAccountTokenCreator` mila hai, aur
 * har call par ek ghante ka token banta hai. Chori hone layak kuch bhi disk par nahi.
 *
 * Setup (ek baar ho chuka):
 *   SA        apps-script-agent@resellsubsos-prod.iam.gserviceaccount.com
 *   client id 104150092217722770237   (Admin console → Domain-wide delegation)
 *   scope     https://www.googleapis.com/auth/script.projects   — sirf yahi, aur kuch nahi
 *
 * Script IDs: dekho `npm run apps-script:list` ya Drive me
 * `mimeType = application/vnd.google-apps.script`.
 */
import { execSync } from "node:child_process";

export const SA    = "apps-script-agent@resellsubsos-prod.iam.gserviceaccount.com";

/**
 * KISKE roop me. Domain ka koi bhi user, DWD ki wajah se.
 *
 * 30 Aug 2026: `pardeep@anutech.in` par atka hona ek asli bug chhupa gaya. Enquiry
 * forwarder ko `sales@anutech.in` ke mailbox me chalna chahiye, aur wahan ek TEESRI script
 * baithi thi — jo `pardeep@` ki list me dikhti hi nahi. Do din tak har enquiry 401 khaati
 * rahi aur maine "sirf do script hain" maan kar dhoondha.
 *
 * Ek account dekh kar "aur kuch nahi hai" mat maano — `APPS_SCRIPT_AS` badal kar dekho.
 */
export const SUB = (process.env.APPS_SCRIPT_AS ?? "").trim() || "pardeep@anutech.in";
const SCOPE = "https://www.googleapis.com/auth/script.projects";

/** DWD se access token — koi key file nahi, IAM Credentials JWT sign karta hai. */
export async function token() {
  const my = execSync("gcloud auth print-access-token",
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const now = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({
    iss: SA, sub: SUB, scope: SCOPE,
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  });
  const s = await fetch(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${SA}:signJwt`,
    { method: "POST", headers: { authorization: `Bearer ${my}`, "content-type": "application/json" },
      body: JSON.stringify({ payload }) });
  if (!s.ok) throw new Error(`signJwt ${s.status}: ${(await s.text()).slice(0, 300)}`);
  const { signedJwt } = await s.json();
  const t = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: signedJwt }) });
  if (!t.ok) throw new Error(`token ${t.status}: ${(await t.text()).slice(0, 300)}`);
  return (await t.json()).access_token;
}

export async function readScript(tk, id) {
  const r = await fetch(`https://script.googleapis.com/v1/projects/${id}/content`,
    { headers: { authorization: `Bearer ${tk}` } });
  if (!r.ok) throw new Error(`read ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

export async function writeScript(tk, id, content) {
  const r = await fetch(`https://script.googleapis.com/v1/projects/${id}/content`,
    { method: "PUT",
      headers: { authorization: `Bearer ${tk}`, "content-type": "application/json" },
      body: JSON.stringify(content) });
  if (!r.ok) throw new Error(`write ${r.status}: ${(await r.text()).slice(0, 400)}`);
  return r.json();
}
