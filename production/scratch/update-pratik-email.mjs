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

async function syncPratikEmail() {
  const newEmail = "pratik@anutech.in";

  // Check tenants
  const { data: tenants } = await admin.from("tenants").select("id, name, email");
  console.log("=== TENANTS LIST ===");
  console.log(tenants);

  // Check users
  const { data: users } = await admin.from("users").select("*");
  console.log("\n=== USERS MATCHING PRATIK ===");
  const matched = (users || []).filter(u => 
    (u.email || "").toLowerCase().includes("pratik") || 
    (u.full_name || "").toLowerCase().includes("pratik")
  );
  console.log(matched);

  // Update Exceltechnologies tenant & user if needed
  const excelTenant = (tenants || []).find(t => t.name.toLowerCase().includes("exceltechnologies"));
  if (excelTenant) {
    console.log(`\nUpdating tenant [${excelTenant.name} (${excelTenant.id})] email to ${newEmail}...`);
    await admin.from("tenants").update({ email: newEmail }).eq("id", excelTenant.id);
  }

  // Update matching users to pratik@anutech.in
  for (const u of matched) {
    console.log(`Updating user [${u.full_name} (${u.id})] email from ${u.email} to ${newEmail}...`);
    await admin.from("users").update({ email: newEmail }).eq("id", u.id);
  }

  console.log("\n✅ Sync Complete! Pratik email is set to:", newEmail);
}

syncPratikEmail();
