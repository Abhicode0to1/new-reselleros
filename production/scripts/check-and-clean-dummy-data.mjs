import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "../.env.local") });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing Supabase credentials in .env.local");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function main() {
  console.log("=== Checking Supabase Data ===");

  const { data: custs } = await supabase.from("customers").select("id, name, domain, tenant_id");
  console.log(`Customers count: ${custs?.length || 0}`);
  custs?.forEach(c => console.log(` - [${c.id}] ${c.name} (${c.domain || 'no domain'})`));

  const { data: leads } = await supabase.from("leads").select("id, company, domain, is_junk");
  console.log(`\nLeads count: ${leads?.length || 0}`);

  const { data: quotes } = await supabase.from("quotes").select("id, customer_name, amount");
  console.log(`\nQuotes count: ${quotes?.length || 0}`);

  const { data: subs } = await supabase.from("subscriptions").select("id, customer_name, domain");
  console.log(`\nSubscriptions count: ${subs?.length || 0}`);
}

main().catch(console.error);
