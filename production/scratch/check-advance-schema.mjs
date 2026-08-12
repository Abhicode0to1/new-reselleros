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

async function checkAdvanceSchema() {
  console.log("=== CHECKING EXISTING TABLES FOR ADVANCES ===");
  const { data: adv, error: advErr } = await admin.from("employee_advances").select("*").limit(5);
  console.log("employee_advances table query result:", advErr ? advErr.message : adv);

  const { data: exp, error: expErr } = await admin.from("expenses").select("*").limit(1);
  console.log("expenses sample columns:", exp ? Object.keys(exp[0] || {}) : expErr?.message);
}

checkAdvanceSchema();
