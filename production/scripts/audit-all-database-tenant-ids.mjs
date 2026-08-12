import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "../.env.local") });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

async function main() {
  console.log("=== COMPREHENSIVE MULTI-TENANT DATABASE AUDIT ===");

  // 1. Audit Leads
  const { data: leads } = await supabase.from("leads").select("id, company, tenant_id");
  console.log(`\n--- LEADS AUDIT (Total: ${leads?.length || 0}) ---`);
  const leadsByTenant = {};
  leads?.forEach((l) => {
    leadsByTenant[l.tenant_id] = (leadsByTenant[l.tenant_id] || 0) + 1;
  });
  console.log("Leads Breakdown by tenant_id:", leadsByTenant);

  // 2. Audit Customers
  const { data: custs } = await supabase.from("customers").select("id, name, tenant_id");
  console.log(`\n--- CUSTOMERS AUDIT (Total: ${custs?.length || 0}) ---`);
  const custsByTenant = {};
  custs?.forEach((c) => {
    custsByTenant[c.tenant_id] = (custsByTenant[c.tenant_id] || 0) + 1;
  });
  console.log("Customers Breakdown by tenant_id:", custsByTenant);

  // 3. Audit Subscriptions
  const { data: subs } = await supabase.from("subscriptions").select("id, customer_name, tenant_id");
  console.log(`\n--- SUBSCRIPTIONS AUDIT (Total: ${subs?.length || 0}) ---`);
  const subsByTenant = {};
  subs?.forEach((s) => {
    subsByTenant[s.tenant_id] = (subsByTenant[s.tenant_id] || 0) + 1;
  });
  console.log("Subscriptions Breakdown by tenant_id:", subsByTenant);

  // 4. Audit Quotes
  const { data: quotes } = await supabase.from("quotes").select("id, customer_name, tenant_id");
  console.log(`\n--- QUOTES AUDIT (Total: ${quotes?.length || 0}) ---`);
  const quotesByTenant = {};
  quotes?.forEach((q) => {
    quotesByTenant[q.tenant_id] = (quotesByTenant[q.tenant_id] || 0) + 1;
  });
  console.log("Quotes Breakdown by tenant_id:", quotesByTenant);
}

main().catch(console.error);
