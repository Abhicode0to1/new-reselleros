
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
  