// R-048 part 2 (4 Oct 2026): end-to-end check of two-step sign-in against the LOCAL stack.
// Creates a throwaway confirmed user (aitest-mfa@example.test), enrolls TOTP, proves the
// middleware sends a password-only session to /mfa, then deletes everything. Refuses to run
// unless .env.local points at a local Supabase. Needs the dev server on :3001.
//   node scripts/check-mfa-local.mjs
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import crypto from "node:crypto";
const req = createRequire("C:/Users/mso50/new-reselleros/production/package.json");
const { createClient } = req("@supabase/supabase-js");
const { createServerClient } = req("@supabase/ssr");
const env = Object.fromEntries(readFileSync("C:/Users/mso50/new-reselleros/production/.env.local","utf8").split(/\r?\n/).filter(l=>/^[A-Z_]+=/.test(l)).map(l=>{const i=l.indexOf("=");return [l.slice(0,i), l.slice(i+1).replace(/^"|"$/g,"")];}));
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL, ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY, SVC = env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_.includes("127.0.0.1") && !URL_.includes("localhost")) throw new Error("not local");
const EMAIL = "aitest-mfa@example.test", PASS = "Aitest-Mfa-pass-1";
const admin = createClient(URL_, SVC, { auth: { persistSession: false } });

function totp(secretB32, t = Date.now()) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; let bits = "";
  for (const c of secretB32.replace(/=+$/,"").toUpperCase()) bits += A.indexOf(c).toString(2).padStart(5,"0");
  const key = Buffer.from(bits.match(/.{8}/g).map(b=>parseInt(b,2)));
  const ctr = Buffer.alloc(8); ctr.writeBigUInt64BE(BigInt(Math.floor(t/1000/30)));
  const h = crypto.createHmac("sha1", key).update(ctr).digest(); const o = h[h.length-1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6,"0");
}
// cookie-jar client so the session lands in @supabase/ssr cookies
function ssrClient(jar) {
  return createServerClient(URL_, ANON, { cookies: { getAll: () => [...jar].map(([name,value])=>({name,value})), setAll: (cs) => cs.forEach(({name,value})=> value ? jar.set(name,value) : jar.delete(name)) } });
}
const cookieHeader = (jar) => [...jar].map(([n,v])=>`${n}=${v}`).join("; ");
async function dash(jar) {
  const r = await fetch("http://localhost:3001/dashboard", { headers: { cookie: cookieHeader(jar) }, redirect: "manual" });
  return `${r.status} ${r.headers.get("location") ?? ""}`;
}

// fresh test user (confirmed)
const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 });
for (const u of list.users.filter(u=>u.email===EMAIL)) await admin.auth.admin.deleteUser(u.id);
const { data: cu } = await admin.auth.admin.createUser({ email: EMAIL, password: PASS, email_confirm: true });
const tenantId = crypto.randomUUID();
await admin.from("tenants").insert({ id: tenantId, name: "AITEST MFA Co", email: EMAIL });
await admin.from("users").insert({ id: cu.user.id, tenant_id: tenantId, email: EMAIL, full_name: "AITEST MFA", initials: "AM", role: "owner", color: "amber" });

const jar1 = new Map(); const c1 = ssrClient(jar1);
await c1.auth.signInWithPassword({ email: EMAIL, password: PASS });
console.log("1. no 2FA yet, /dashboard ->", await dash(jar1));
const { data: en, error: enErr } = await c1.auth.mfa.enroll({ factorType: "totp", friendlyName: "test" });
if (enErr) { console.log("enroll error:", enErr.message); process.exit(1); }
const v = await c1.auth.mfa.challengeAndVerify({ factorId: en.id, code: totp(en.totp.secret) });
console.log("2. enroll+verify:", v.error ? "FAIL " + v.error.message : "ok (aal2)");
console.log("3. same session after verify, /dashboard ->", await dash(jar1));

const jar2 = new Map(); const c2 = ssrClient(jar2);
await c2.auth.signInWithPassword({ email: EMAIL, password: PASS });
const aal = (await c2.auth.mfa.getAuthenticatorAssuranceLevel()).data;
console.log("4. new password-only login aal:", aal.currentLevel, "->", aal.nextLevel);
console.log("5. password-only session, /dashboard ->", await dash(jar2));
const wrong = await c2.auth.mfa.challengeAndVerify({ factorId: en.id, code: "000000" });
console.log("6. wrong code:", wrong.error ? "refused" : "ACCEPTED (bad)");
const ok = await c2.auth.mfa.challengeAndVerify({ factorId: en.id, code: totp(en.totp.secret) });
console.log("7. right code:", ok.error ? "FAIL " + ok.error.message : "ok");
console.log("8. after code, /dashboard ->", await dash(jar2));

// cleanup
await admin.from("users").delete().eq("id", cu.user.id);
await admin.from("tenants").delete().eq("id", tenantId);
await admin.auth.admin.deleteUser(cu.user.id);
console.log("cleaned up");
