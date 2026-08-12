import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';

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

if (!serviceRoleKey) {
  console.log('SUPABASE_SERVICE_ROLE_KEY not set');
  process.exit(1);
}

const admin = createClient(supabaseUrl, serviceRoleKey);

async function fixBothRanjeetAccounts() {
  const excelTenantId = "13a364c7-d057-4725-876f-32376c8dd3c9";
  const excelUserUserId = "e8a1c481-7055-494a-a65c-4a1f81550868";
  const excelEmail = "ranjeetraj@exceltechnologies.in";

  const anutechTenantId = "fbb976f1-9090-4f10-9726-0901bd144e42";
  const anutechUserId = "edcb99a6-1eae-4da7-b9a7-cdd3c1e1f10e";
  const anutechEmail = "ranjeet@anutech.in";

  console.log("=== 1. RESTORING EXCEL TECHNOLOGIES WORKSPACE OWNER ===");
  await admin.from("tenants").update({ email: excelEmail }).eq("id", excelTenantId);
  const { error: excelErr } = await admin.from("users").update({
    tenant_id: excelTenantId,
    email: excelEmail,
    full_name: "Ranjeet Raj",
    role: "owner",
    is_active: true
  }).eq("id", excelUserUserId);

  if (excelErr) console.error("Excel user update error:", excelErr);
  else console.log(`✅ Excel Technologies workspace owner restored (${excelEmail})`);

  console.log("\n=== 2. CONFIGURING ANUTECH DIGITAL SUPPORT EMPLOYEE ===");
  const { error: anutechErr } = await admin.from("users").update({
    tenant_id: anutechTenantId,
    email: anutechEmail,
    full_name: "Ranjeet Raj",
    role: "support",
    is_active: true
  }).eq("id", anutechUserId);

  if (anutechErr) console.error("Anutech user update error:", anutechErr);
  else console.log(`✅ Anutech Digital Support employee configured (${anutechEmail})`);

  console.log("\n=== VERIFYING FINAL TENANTS & OWNERS ===");
  const [{ data: tenants }, { data: users }] = await Promise.all([
    admin.from("tenants").select("id, name, email"),
    admin.from("users").select("id, tenant_id, full_name, email, role"),
  ]);

  console.log("TENANTS:", tenants);
  console.log("USERS:", users);
}

fixBothRanjeetAccounts();
