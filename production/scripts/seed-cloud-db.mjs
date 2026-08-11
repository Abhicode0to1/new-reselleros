import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf-8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const idx = l.indexOf("=");
      return [l.slice(0, idx).trim(), l.slice(idx + 1).trim().replace(/^"|"$/g, "")];
    })
);

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

console.log("Connecting to Supabase Cloud:", SUPABASE_URL);

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function seed() {
  const tenantId = "11111111-1111-1111-1111-111111111111";

  // 1. Tenant
  const { error: tErr } = await supabase.from("tenants").upsert({
    id: tenantId,
    name: "Excel Technologies Pvt Ltd",
    gstin: "27AABCE9876D1Z3",
    state: "Maharashtra",
    state_code: "27",
    address: "Mumbai, Maharashtra 400001",
    email: "pardeep@exceltechnologies.in",
    phone: "+91 98765 00000",
  });
  if (tErr) console.warn("Tenant seed:", tErr.message);

  // 2. Customers
  const customers = [
    {
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1",
      tenant_id: tenantId,
      name: "Acme Corp Pvt Ltd",
      domain: "acmecorp.com",
      gstin: "27AABCS1234D1Z5",
      state: "Maharashtra",
      state_code: "27",
      health: 85,
      contact_name: "Rajesh K",
      contact_title: "CTO",
      contact_email: "rajesh@acmecorp.com",
      contact_phone: "+91 98765 43210",
      since: "2023-09-15",
    },
    {
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2",
      tenant_id: tenantId,
      name: "Cosmo Tech",
      domain: "cosmotech.in",
      gstin: "27AABCC3456E2F7",
      state: "Maharashtra",
      state_code: "27",
      health: 72,
      contact_name: "Sneha M",
      contact_title: "IT Head",
      contact_email: "sneha@cosmotech.in",
      contact_phone: "+91 98123 11111",
      since: "2025-05-21",
    },
    {
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3",
      tenant_id: tenantId,
      name: "Delta Pvt Ltd",
      domain: "deltapl.com",
      gstin: "27AABCD5678F3G9",
      state: "Maharashtra",
      state_code: "27",
      health: 91,
      contact_name: "Arjun S",
      contact_title: "CTO",
      contact_email: "arjun@deltapl.com",
      contact_phone: "+91 99100 22334",
      since: "2024-06-22",
    },
    {
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4",
      tenant_id: tenantId,
      name: "Echo Pharma",
      domain: "echopharma.in",
      gstin: "29AABCE8765H4J1",
      state: "Karnataka",
      state_code: "29",
      health: 95,
      contact_name: "Dr. Verma",
      contact_title: "CEO",
      contact_email: "verma@echopharma.in",
      contact_phone: "+91 98765 33445",
      since: "2024-01-10",
    },
    {
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa5",
      tenant_id: tenantId,
      name: "Beta Industries",
      domain: "betaind.in",
      gstin: "27AABCB1234K5L6",
      state: "Maharashtra",
      state_code: "27",
      health: 88,
      contact_name: "Priya M",
      contact_title: "Operations Head",
      contact_email: "priya@betaind.in",
      contact_phone: "+91 99887 11223",
      since: "2024-06-18",
    },
  ];
  const { error: cErr } = await supabase.from("customers").upsert(customers);
  if (cErr) console.warn("Customers seed:", cErr.message);

  // 3. Leads
  const leads = [
    {
      id: "L1",
      tenant_id: tenantId,
      company: "TechBrand Pvt Ltd",
      plan: "Google Workspace Std",
      seats: 25,
      value: 200000,
      stage: "new",
      source: "manual",
      contact_name: "Vikram Mehta",
    },
    {
      id: "L2",
      tenant_id: tenantId,
      company: "Hotel Royal Group",
      plan: "Mixed plans",
      seats: 40,
      value: 400000,
      stage: "contact",
      source: "manual",
      contact_name: "Anita Sharma",
    },
    {
      id: "L3",
      tenant_id: tenantId,
      company: "Kilo Foods Ltd",
      plan: "Workspace Starter",
      seats: 15,
      value: 300000,
      stage: "demo",
      source: "csv",
      contact_name: "Sanjay Patel",
    },
    {
      id: "L4",
      tenant_id: "11111111-1111-1111-1111-111111111111",
      company: "Maple Studios",
      plan: "Workspace Plus",
      seats: 12,
      value: 180000,
      stage: "trial",
      source: "buy-workspace-v2",
      contact_name: "Rohan Kapoor",
    },
  ];
  const { error: lErr } = await supabase.from("leads").upsert(leads);
  if (lErr) console.warn("Leads seed:", lErr.message);

  console.log("✅ Seed process completed!");
}

seed();
