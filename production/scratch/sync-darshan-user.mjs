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

async function syncDarshanUser() {
  const email = "sales@anutech.in";
  
  const { data: users } = await admin.from("users").select("*").eq("email", email);
  console.log("=== USERS MATCHING sales@anutech.in ===");
  console.log(users);

  // Ensure full_name is Darshan (Sales Anutech / Darshan)
  if (users && users.length > 0) {
    const u = users[0];
    if (!u.full_name.includes("Darshan")) {
      console.log(`Updating full_name to 'Darshan (Sales)' for ${email}...`);
      await admin.from("users").update({ full_name: "Darshan (Sales)" }).eq("id", u.id);
    }
  }

  // Check employees table
  const { data: emp } = await admin.from("employees").select("*");
  const darshanEmp = (emp || []).find(e => e.name.toLowerCase().includes("darshan"));
  if (!darshanEmp) {
    console.log("Adding Darshan to employees table...");
    const tenant_id = "fbb976f1-9090-4f10-9726-0901bd144e42";
    await admin.from("employees").insert({
      id: crypto.randomUUID(),
      tenant_id,
      name: "Darshan",
      is_active: true,
      monthly_gross: 30000
    });
    console.log("✅ Added Darshan to employees table!");
  } else {
    console.log("Found Darshan in employees table:", darshanEmp);
  }
}

syncDarshanUser();
