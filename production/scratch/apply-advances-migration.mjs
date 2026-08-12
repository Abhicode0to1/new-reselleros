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

async function applyAdvancesMigration() {
  console.log("=== CREATING EMPLOYEE EXPENSE ADVANCES MIGRATION ===");
  
  const migrationSql = `
    CREATE TABLE IF NOT EXISTS public.employee_expense_advances (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
      employee_id UUID REFERENCES public.employees(id) ON DELETE SET NULL,
      employee_name TEXT NOT NULL,
      disbursed_amount NUMERIC(14,2) NOT NULL CHECK (disbursed_amount > 0),
      disbursed_date DATE NOT NULL DEFAULT CURRENT_DATE,
      payment_method TEXT NOT NULL DEFAULT 'bank_transfer',
      bank_account_id UUID REFERENCES public.bank_accounts(id) ON DELETE SET NULL,
      purpose TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE public.employee_expense_advances ENABLE ROW LEVEL SECURITY;

    DO $$ 
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = 'employee_expense_advances' AND policyname = 'Users can manage tenant employee_expense_advances'
      ) THEN
        CREATE POLICY "Users can manage tenant employee_expense_advances" ON public.employee_expense_advances
          FOR ALL USING (tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid()));
      END IF;
    END $$;
  `;

  // Write migration file to migrations directory
  const migrationPath = path.join(process.cwd(), 'supabase', 'migrations', '0225_employee_expense_advances.sql');
  fs.writeFileSync(migrationPath, migrationSql, 'utf8');
  console.log(`Saved migration to: ${migrationPath}`);

  // Test table creation using dummy insert / inspect or SQL execution
  const { data: test, error } = await admin.from("employee_expense_advances").select("*").limit(1);
  if (error && error.message.includes("does not exist")) {
    console.log("Table does not exist yet. Please execute migration SQL in Supabase SQL editor or CLI.");
  } else {
    console.log("✅ employee_expense_advances table exists & ready!");
  }
}

applyAdvancesMigration();
