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
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const admin = createClient(supabaseUrl, serviceKey);

async function testSalesRLS() {
  const salesEmail = "sales@anutech.in";
  
  // Get sales user id
  const { data: u } = await admin.from("users").select("*").eq("email", salesEmail).single();
  console.log("Sales User in DB:", u);

  const tenant_id = u.tenant_id;

  // Let's check expenses table count for this tenant
  const { data: expenses, error } = await admin.from("expenses").select("*").eq("tenant_id", tenant_id).eq("category", "Employee Advance Disbursal");
  console.log("Direct Service Role Query for 'Employee Advance Disbursal':", expenses);
}

testSalesRLS();
