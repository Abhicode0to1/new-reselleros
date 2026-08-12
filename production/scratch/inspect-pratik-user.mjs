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

async function check() {
  const [{ data: users }, { data: tenants }, authRes] = await Promise.all([
    admin.from("users").select("*"),
    admin.from("tenants").select("id, name"),
    admin.auth.admin.listUsers().catch(() => ({ data: { users: [] } })),
  ]);

  console.log("=== ALL PUBLIC USERS FOR PRATIK ===");
  const pratikUsers = (users || []).filter(u => 
    (u.full_name || "").toLowerCase().includes("pratik") || 
    (u.email || "").toLowerCase().includes("pratik")
  );
  console.log(JSON.stringify(pratikUsers, null, 2));

  console.log("\n=== ALL AUTH USERS FOR PRATIK ===");
  const authUsers = authRes?.data?.users || [];
  const pratikAuth = authUsers.filter(u => 
    (u.email || "").toLowerCase().includes("pratik") || 
    JSON.stringify(u.user_metadata || {}).toLowerCase().includes("pratik")
  );
  console.log(JSON.stringify(pratikAuth, null, 2));
}

check();
