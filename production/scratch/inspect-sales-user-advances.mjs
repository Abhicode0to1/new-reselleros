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

async function inspectSalesUserAdvances() {
  const salesEmail = "sales@anutech.in";
  const tenant_id = "fbb976f1-9090-4f10-9726-0901bd144e42";

  console.log("=== 1. FETCHING ALL EXPENSES WITH CATEGORY 'Employee Advance Disbursal' ===");
  const { data: disbursals, error } = await admin
    .from("expenses")
    .select("*")
    .eq("tenant_id", tenant_id);

  console.log(`Total expenses for tenant: ${disbursals?.length || 0}`);
  console.log(JSON.stringify(disbursals, null, 2));

  console.log("\n=== 2. CHECKING SALES USER RECORD IN USERS TABLE ===");
  const { data: salesUser } = await admin.from("users").select("*").eq("email", salesEmail);
  console.log(salesUser);
}

inspectSalesUserAdvances();
