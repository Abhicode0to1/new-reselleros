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

async function inspectBugReports() {
  console.log("=== 1. FETCHING ALL SUPPORT TICKETS FROM ALL TENANTS ===");
  const { data: tickets, error: tErr } = await admin.from("support_tickets").select("*").order("created_at", { ascending: false });
  if (tErr) console.error("Ticket Fetch Error:", tErr);
  console.log(`Total Tickets Found: ${tickets?.length || 0}`);
  console.log(JSON.stringify(tickets, null, 2));

  console.log("\n=== 2. SEARCHING TICKETS BY RANJEET OR EXCEL ===");
  const ranjeetTickets = (tickets || []).filter(t => 
    JSON.stringify(t).toLowerCase().includes("ranjeet") ||
    JSON.stringify(t).toLowerCase().includes("excel") ||
    JSON.stringify(t).toLowerCase().includes("bug")
  );
  console.log(JSON.stringify(ranjeetTickets, null, 2));
}

inspectBugReports();
