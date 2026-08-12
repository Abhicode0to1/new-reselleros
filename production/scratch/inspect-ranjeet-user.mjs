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

async function checkRanjeet() {
  const [{ data: users }, { data: tenants }] = await Promise.all([
    admin.from("users").select("*"),
    admin.from("tenants").select("id, name, email"),
  ]);

  console.log("=== ALL TENANTS ===");
  console.log(tenants);

  console.log("\n=== USERS MATCHING RANJEET / RAJ ===");
  const matched = (users || []).filter(u => 
    (u.email || "").toLowerCase().includes("ranjeet") || 
    (u.email || "").toLowerCase().includes("raj") ||
    (u.full_name || "").toLowerCase().includes("ranjeet")
  );
  console.log(JSON.stringify(matched, null, 2));

  // Sync ranjeet@anutech.in for Ranjeet Raj if needed
  const targetEmail = "ranjeet@anutech.in";
  for (const u of matched) {
    if (u.email === "raj@anutech.in" || u.email === "ranjeetraj@exceltechnologies.in") {
      console.log(`\nUpdating user [${u.full_name} (${u.id})] email from ${u.email} to ${targetEmail}...`);
      await admin.from("users").update({ email: targetEmail }).eq("id", u.id);
    }
  }

  // Update Anutech tenant email to ranjeet@anutech.in if it was raj@anutech.in
  const anutechTenant = (tenants || []).find(t => t.name === "Anutech" && t.email === "raj@anutech.in");
  if (anutechTenant) {
    console.log(`\nUpdating Anutech tenant email to ${targetEmail}...`);
    await admin.from("tenants").update({ email: targetEmail }).eq("id", anutechTenant.id);
  }

  console.log("\n✅ Ranjeet Raj Sync Complete! Email configured for Google OAuth:", targetEmail);
}

checkRanjeet();
