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

async function fixRanjeetGoogleAuth() {
  const oldEmail = "raj@anutech.in";
  const newEmail = "ranjeet@anutech.in";
  const anutechDigitalTenantId = "fbb976f1-9090-4f10-9726-0901bd144e42";

  console.log("=== STEP 1: CHECKING SUPABASE AUTH USERS ===");
  const authRes = await admin.auth.admin.listUsers();
  const authUsers = authRes?.data?.users || [];
  
  for (const au of authUsers) {
    console.log(`AUTH USER: id=${au.id}, email=${au.email}`);
    if (au.email?.toLowerCase() === oldEmail.toLowerCase() || au.email?.toLowerCase() === "ranjeetraj@exceltechnologies.in") {
      console.log(`--> Updating Auth User [${au.id}] email from ${au.email} to ${newEmail}...`);
      const { error: authErr } = await admin.auth.admin.updateUserById(au.id, {
        email: newEmail,
        email_confirm: true,
        user_metadata: { ...au.user_metadata, full_name: "Ranjeet Raj" }
      });
      if (authErr) console.error("Auth Update Error:", authErr);
      else console.log(`--> Auth User [${au.id}] successfully updated to ${newEmail}`);
    }
  }

  console.log("\n=== STEP 2: CHECKING PUBLIC USERS ===");
  const { data: publicUsers } = await admin.from("users").select("*");
  for (const pu of publicUsers || []) {
    if (pu.email?.toLowerCase() === oldEmail.toLowerCase() || pu.email?.toLowerCase() === "ranjeetraj@exceltechnologies.in") {
      console.log(`--> Updating Public User [${pu.id}] email to ${newEmail} and tenant to Anutech Digital...`);
      await admin.from("users").update({
        email: newEmail,
        tenant_id: anutechDigitalTenantId,
        full_name: "Ranjeet Raj",
        role: "support",
        is_active: true
      }).eq("id", pu.id);
    }
  }

  console.log("\n=== STEP 3: CHECKING TENANTS ===");
  const { data: tenants } = await admin.from("tenants").select("*");
  for (const t of tenants || []) {
    if (t.email?.toLowerCase() === oldEmail.toLowerCase()) {
      console.log(`--> Updating Tenant [${t.name} (${t.id})] contact email to ${newEmail}...`);
      await admin.from("tenants").update({ email: newEmail }).eq("id", t.id);
    }
  }

  console.log("\n=== VERIFYING FINAL STATE FOR RANJEET ===");
  const { data: finalUsers } = await admin.from("users").select("id, tenant_id, full_name, email, role").ilike("email", newEmail);
  console.log(finalUsers);

  console.log("\n✅ Ranjeet Google Auth & Database sync completed successfully!");
}

fixRanjeetGoogleAuth();
