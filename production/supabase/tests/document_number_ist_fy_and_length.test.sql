-- Regression test: a document number is <= 16 characters and comes from the financial
-- year of the DOCUMENT, not of the server clock. Migration 20260930172000 (R-015).
-- Rolled back — safe on production.
--
-- Three claims, and the first is the live one:
--
--   1. IST. This database runs in UTC (`show timezone`), so `current_date` between 00:00
--      and 05:30 IST is YESTERDAY. On 1 April at 02:00 IST that put an invoice, its
--      number and its GSTR-1 month into the financial year that had ended two hours
--      earlier. `ist_today()` is what `indian_fiscal_year()` and `next_document_number()`
--      now default to.
--   2. <= 16 characters (CGST Rule 46(b)). INV-ADPL-2026-27-0002 was 21.
--   3. The tenant code SURVIVES the shortening. invoices.id is a bare global primary
--      key, so dropping the code would make two tenants' first invoice of a year collide.
--
-- Fixture owns its data (L11): its own tenants, its own literal ids, nothing borrowed.

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e1e1e1e1-0000-4000-8000-000000000001', 'NUM TEST A', 'numa@example.in', '07', 'ADPL'),
  ('e1e1e1e1-0000-4000-8000-000000000002', 'NUM TEST B', 'numb@example.in', '07', 'BDPL'),
  -- A deliberately over-long code: nothing constrains tenants.doc_code today.
  ('e1e1e1e1-0000-4000-8000-000000000003', 'NUM TEST C', 'numc@example.in', '07', 'TOOLONGCODE');

do $$
declare
  v_a text; v_b text; v_c text; v_back text; v_next text;
  v_fy text;
begin
  -- ── 1. IST, not the server clock ──────────────────────────────────────────
  /* The arithmetic, stated rather than assumed: 31 Mar 2026 20:30 UTC is 1 Apr 2026
     02:00 IST. Postgres `current_date` for that instant is 31 March. */
  if (timestamptz '2026-03-31 20:30:00+00' at time zone 'Asia/Kolkata')::date <> date '2026-04-01' then
    raise exception 'SETUP FAIL: the IST arithmetic below is wrong, so nothing here proves anything';
  end if;

  if public.indian_fiscal_year(date '2026-03-31') <> 'FY2526' then
    raise exception 'FAIL 1: 31 March is not in FY2526';
  end if;
  if public.indian_fiscal_year(date '2026-04-01') <> 'FY2627' then
    raise exception 'FAIL 1: 1 April is not in FY2627';
  end if;

  /* ist_today() must equal the IST calendar date, not the UTC one. This assertion is
     only meaningful during the 00:00-05:30 IST window, so it is written as "it agrees
     with the IST timezone conversion" rather than "it differs from current_date" — the
     second would be a test that passes for 18.5 hours a day and fails for 5.5. */
  if public.ist_today() <> (now() at time zone 'Asia/Kolkata')::date then
    raise exception 'FAIL 2: ist_today() is % but IST says %',
      public.ist_today(), (now() at time zone 'Asia/Kolkata')::date;
  end if;

  -- ── 2. The document's own date decides the series ─────────────────────────
  v_back := public.next_document_number('invoice', 'e1e1e1e1-0000-4000-8000-000000000001', date '2026-03-28');
  if v_back not like '%-26-0001' then
    raise exception 'FAIL 3: a 28-March-2026 invoice took a number outside FY2526: %', v_back;
  end if;

  /* …and an April one opens its OWN series rather than continuing March's. This is the
     assertion that would catch a "fix" that simply relabels the string. */
  v_next := public.next_document_number('invoice', 'e1e1e1e1-0000-4000-8000-000000000001', date '2026-04-02');
  if v_next not like '%-27-0001' then
    raise exception 'FAIL 4: the first invoice of FY2627 was not 0001: % (after %)', v_next, v_back;
  end if;

  select fiscal_year into v_fy from public.document_series
   where tenant_id = 'e1e1e1e1-0000-4000-8000-000000000001' and doc_type = 'invoice'
   order by fiscal_year limit 1;
  if v_fy <> 'FY2526' then
    raise exception 'FAIL 5: expected a separate FY2526 series row, saw %', v_fy;
  end if;

  -- ── 3. Sixteen characters ─────────────────────────────────────────────────
  v_a := public.next_document_number('invoice', 'e1e1e1e1-0000-4000-8000-000000000001', date '2026-04-02');
  if length(v_a) > 16 then
    raise exception 'FAIL 6: % is % characters — CGST Rule 46(b) allows 16', v_a, length(v_a);
  end if;
  if v_a <> 'INV-ADPL-27-0002' then
    raise exception 'FAIL 6: unexpected shape %', v_a;
  end if;

  -- The longest GST prefix, at the largest 4-digit number.
  update public.document_series set last_number = 9998
   where tenant_id = 'e1e1e1e1-0000-4000-8000-000000000001' and doc_type = 'refund_voucher';
  v_c := public.next_document_number('refund_voucher', 'e1e1e1e1-0000-4000-8000-000000000001', date '2026-04-02');
  if length(v_c) > 16 then
    raise exception 'FAIL 7: refund voucher % is % characters', v_c, length(v_c);
  end if;

  -- An over-long doc_code must be capped, not allowed to push the number over the limit.
  v_c := public.next_document_number('invoice', 'e1e1e1e1-0000-4000-8000-000000000003', date '2026-04-02');
  if length(v_c) > 16 then
    raise exception 'FAIL 8: an 11-character doc_code produced % (% chars)', v_c, length(v_c);
  end if;
  if v_c <> 'INV-TOOL-27-0001' then
    raise exception 'FAIL 8: expected the code capped to 4, got %', v_c;
  end if;

  -- ── 4. The tenant code is what keeps invoices.id globally unique ──────────
  /* invoices.id is a bare PRIMARY KEY across every tenant. The card offered "drop the
     tenant code" as a way to save characters; this is why that would have been a
     primary-key violation at the moment two tenants each issued their first invoice of
     a year. */
  v_b := public.next_document_number('invoice', 'e1e1e1e1-0000-4000-8000-000000000002', date '2026-04-02');
  if v_b = 'INV-ADPL-27-0001' or split_part(v_b, '-', 2) <> 'BDPL' then
    raise exception 'FAIL 9: tenant B got % — the tenant code is not separating the series', v_b;
  end if;
  if v_b = v_a then
    raise exception 'FAIL 9: two tenants were given the same invoice number (%)', v_a;
  end if;

  raise notice 'PASS: % / % / % — IST financial year, <=16 chars, tenants separated', v_back, v_a, v_b;
end $$;

rollback;
