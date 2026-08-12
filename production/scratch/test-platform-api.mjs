import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';

// Read .env.local
const envPath = path.join(process.cwd(), '.env.local');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const match = line.match(/^([^=]+)=(.*)$/);
    if (match) {
      process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
    }
  }
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://jhyxmskgbghstbdfszik.supabase.co';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

console.log("Supabase URL:", supabaseUrl);
console.log("Service Key Available:", Boolean(serviceRoleKey));

if (!serviceRoleKey) {
  console.log('SUPABASE_SERVICE_ROLE_KEY not set');
  process.exit(1);
}

const admin = createClient(supabaseUrl, serviceRoleKey);

async function test() {
  const [{ data: tenants }, { data: users }, authUsersRes] = await Promise.all([
    admin.from("tenants").select("id, name, email, phone, created_at, tier, gstin, state, setup_completed_at").order("created_at", { ascending: false }),
    admin.from("users").select("id, tenant_id, role, full_name, email"),
    admin.auth.admin.listUsers().catch((err) => { console.error("AUTH LIST ERR:", err); return { data: { users: [] } }; }),
  ]);

  console.log("TENANTS COUNT:", tenants?.length);
  console.log("USERS COUNT:", users?.length);
  const authUsers = authUsersRes?.data?.users || [];
  console.log("AUTH USERS COUNT:", authUsers.length);

  const authMap = new Map();
  for (const au of authUsers) {
    const meta = au.user_metadata || {};
    const name = meta.full_name || meta.name || meta.display_name || au.email?.split("@")[0] || null;
    const phone = au.phone || meta.phone || meta.mobile || meta.contact_phone || null;
    authMap.set(au.id, { email: au.email, phone, name });
    console.log(`AUTH USER [${au.id}]: email=${au.email}, phone=${phone}, name=${name}`);
  }

  console.log("\nPUBLIC USERS:");
  for (const u of users ?? []) {
    console.log(`USER: tenant_id=${u.tenant_id}, role=${u.role}, full_name=${u.full_name}, email=${u.email}`);
  }

  console.log("\nTENANTS:");
  for (const t of tenants ?? []) {
    console.log(`TENANT: id=${t.id}, name=${t.name}, email=${t.email}, phone=${t.phone}`);
  }

  const ownerByTenant = new Map();
  const firstUserByTenant = new Map();

  for (const u of users ?? []) {
    const au = authMap.get(u.id);
    const resolvedName = u.full_name || au?.name || u.email?.split("@")[0] || "—";
    const resolvedEmail = u.email || au?.email || null;
    const resolvedPhone = au?.phone || null;
    const userInfo = { name: resolvedName, email: resolvedEmail, phone: resolvedPhone };

    if (!firstUserByTenant.has(u.tenant_id)) {
      firstUserByTenant.set(u.tenant_id, userInfo);
    }
    if (u.role === "owner" && !ownerByTenant.has(u.tenant_id)) {
      ownerByTenant.set(u.tenant_id, userInfo);
    }
  }

  const rows = (tenants ?? []).map((t) => {
    const ownerData = ownerByTenant.get(t.id) || firstUserByTenant.get(t.id);
    const email = ownerData?.email || t.email || null;
    const phone = t.phone || ownerData?.phone || null;
    return { name: t.name, owner: ownerData?.name, email, phone };
  });

  console.log("\nFINAL PROCESSED SIGNUP ROWS:");
  console.log(JSON.stringify(rows, null, 2));
}

test();
