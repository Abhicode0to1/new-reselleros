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

async function restoreRanjeetRajExcel() {
  const excelTenantId = "13a364c7-d057-4725-876f-32376c8dd3c9";
  const excelEmail = "ranjeetraj@exceltechnologies.in";

  // Check if tenant exists
  const { data: tenant } = await admin.from("tenants").select("*").eq("id", excelTenantId).single();
  console.log("=== EXCEL TECHNOLOGIES TENANT ===");
  console.log(tenant);

  // Update tenant contact email back to ranjeetraj@exceltechnologies.in
  await admin.from("tenants").update({ email: excelEmail }).eq("id", excelTenantId);

  // Check if user exists for ranjeetraj@exceltechnologies.in
  const { data: users } = await admin.from("users").select("*").eq("tenant_id", excelTenantId);
  console.log("\n=== EXCEL TECHNOLOGIES USERS ===");
  console.log(users);

  const existingUser = (users || []).find(u => u.email === excelEmail);

  if (!existingUser) {
    console.log(`Creating owner user for ${excelEmail} under tenant ${excelTenantId}...`);
    const newUserId = crypto.randomUUID();
    const { error: insErr } = await admin.from("users").insert({
      id: newUserId,
      tenant_id: excelTenantId,
      email: excelEmail,
      full_name: "Ranjeet Raj",
      role: "owner",
      initials: "RR",
      color: "amber",
      is_active: true
    });
    if (insErr) console.error("Insert error:", insErr);
    else console.log("✅ Created user for Excel Technologies!");
  } else {
    console.log(`Updating existing user [${existingUser.id}] to owner of ${excelTenantId}...`);
    await admin.from("users").update({
      email: excelEmail,
      role: "owner",
      full_name: "Ranjeet Raj"
    }).eq("id", existingUser.id);
  }

  // Also verify ranjeet@anutech.in (Support in Anutech Digital)
  const { data: anutechUser } = await admin.from("users").select("*").eq("email", "ranjeet@anutech.in");
  console.log("\n=== ANUTECH DIGITAL SUPPORT USER (ranjeet@anutech.in) ===");
  console.log(anutechUser);

  console.log("\n✅ BOTH accounts configured successfully!");
}

restoreRanjeetRajExcel();
