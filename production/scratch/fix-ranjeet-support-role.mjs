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

async function fixRanjeetSupportRole() {
  const targetEmail = "ranjeet@anutech.in";
  
  // Find Anutech Digital primary tenant
  const { data: tenants } = await admin.from("tenants").select("id, name");
  const anutechDigital = (tenants || []).find(t => t.name.toLowerCase().includes("anutech digital"));

  if (!anutechDigital) {
    console.error("Anutech Digital tenant not found!");
    return;
  }

  console.log(`Anutech Digital Tenant ID: ${anutechDigital.id}`);

  // Fetch all users matching ranjeet
  const { data: users } = await admin.from("users").select("*");
  const ranjeetUser = (users || []).find(u => (u.email || "").toLowerCase() === targetEmail);

  if (ranjeetUser) {
    console.log(`Updating existing user [${ranjeetUser.id}] to role='support' under Anutech Digital...`);
    const { error: updateErr } = await admin
      .from("users")
      .update({
        tenant_id: anutechDigital.id,
        email: targetEmail,
        full_name: "Ranjeet Raj",
        role: "support",
        initials: "RR",
        is_active: true,
      })
      .eq("id", ranjeetUser.id);

    if (updateErr) console.error("Update Error:", updateErr);
  } else {
    console.log(`Inserting new employee user for ranjeet@anutech.in with role='support'...`);
    const newId = crypto.randomUUID();
    const { error: insertErr } = await admin
      .from("users")
      .insert({
        id: newId,
        tenant_id: anutechDigital.id,
        email: targetEmail,
        full_name: "Ranjeet Raj",
        role: "support",
        initials: "RR",
        color: "indigo",
        is_active: true,
      });

    if (insertErr) console.error("Insert Error:", insertErr);
  }

  // Also verify user list for Anutech Digital
  const { data: updatedUsers } = await admin
    .from("users")
    .select("id, tenant_id, full_name, email, role")
    .eq("tenant_id", anutechDigital.id);

  console.log("\n=== ANUTECH DIGITAL TEAM MEMBERS ===");
  console.log(updatedUsers);

  console.log("\n✅ Ranjeet Raj is now configured as an Employee with 'support' role in Anutech Digital!");
}

fixRanjeetSupportRole();
