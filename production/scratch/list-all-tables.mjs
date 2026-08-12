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

const admin = createClient(supabaseUrl, serviceRoleKey);

async function listAllTables() {
  const tables = [
    "tenants", "users", "employees", "expenses", "reimbursements",
    "bank_accounts", "bank_transactions", "salary_payments", "salary_advances",
    "employee_loans", "employee_advances", "employee_expense_advances"
  ];

  for (const t of tables) {
    const { data, error } = await admin.from(t).select("*").limit(1);
    if (error) console.log(`Table [${t}]: ERROR -> ${error.message}`);
    else console.log(`Table [${t}]: EXISTS! (${data?.length || 0} rows)`);
  }
}

listAllTables();
