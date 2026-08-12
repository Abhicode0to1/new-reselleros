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
  console.log("=== Executing Dummy / Test Data Cleanup in Supabase ===");

  const dummyCustomerIds = [
    "3957e0dd-0a9c-4f11-9849-6dd44497ec34", // testuser
    "05e4b3b5-ca40-402f-8256-0059bcea05c3", // testuser2
    "049edd9a-f15f-4b66-b86c-4e9c17c2428a", // testing 1234
    "00d4de3f-1c05-40c4-a31d-6d2e5334b27e", // Demo Lead hitesh
    "0763e786-c308-41ec-b5db-3bad5054345b", // Lebosoft Solution duplicate
  ];

  // 1. Delete associated subscriptions, quotes, invoices, payments if any reference these test customers
  const { error: subErr } = await supabase.from("subscriptions").delete().in("customer_id", dummyCustomerIds);
  if (subErr) console.warn("Subscriptions cleanup notice:", subErr.message);

  const { error: quoteErr } = await supabase.from("quotes").delete().in("customer_id", dummyCustomerIds);
  if (quoteErr) console.warn("Quotes cleanup notice:", quoteErr.message);

  const { error: invErr } = await supabase.from("invoices").delete().in("customer_id", dummyCustomerIds);
  if (invErr) console.warn("Invoices cleanup notice:", invErr.message);

  // 2. Delete test customers from customers table
  const { data: deletedCusts, error: custErr } = await supabase
    .from("customers")
    .delete()
    .in("id", dummyCustomerIds)
    .select("id, name");

  if (custErr) {
    console.error("Customer deletion error:", custErr.message);
  } else {
    console.log(`Successfully deleted ${deletedCusts?.length || 0} test customer rows:`);
    deletedCusts?.forEach((c) => console.log(` - Deleted: [${c.id}] ${c.name}`));
  }

  // 3. Delete dummy test leads if any (company matching testuser, demo lead, testing 1234)
  const { data: deletedLeads, error: leadErr } = await supabase
    .from("leads")
    .delete()
    .or("company.ilike.%testuser%,company.ilike.%testing 1234%,company.ilike.%demo lead%")
    .select("id, company");

  if (leadErr) {
    console.warn("Leads deletion notice:", leadErr.message);
  } else {
    console.log(`Successfully deleted ${deletedLeads?.length || 0} test lead rows:`);
    deletedLeads?.forEach((l) => console.log(` - Deleted lead: [${l.id}] ${l.company}`));
  }

  console.log("\n=== Cleanup Finished ===");
}

main().catch(console.error);
