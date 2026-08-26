/*
 * Dummy data hatao — asli business data ke liye khaali maidan.
 * 26 Aug 2026, Pardeep ke kehne par. Production DB: ontpnqjoysjgrlsukecm
 *
 * ─── PEHLE YE ──────────────────────────────────────────────────────────────
 * PITR nahi hai, automatic backup nahi hai. Wapasi ka ek hi raasta: dump.
 * Is baar ka dump: resellersos-data-2026-08-26T03-10-32-128Z.json (117 tables / 1798 rows).
 *
 * ─── TRUNCATE KYUN CHHODA (pehla prayaas isi par ruka) ──────────────────────
 * TRUNCATE constraint ke MAUJOOD hone par atakta hai, us constraint me rows hone par nahi.
 * Iske do nateeje nikle, aur dono kharab the:
 *
 *   1. Bina cascade: chain `reimbursements → expenses → project_sales → customers` ki wajah
 *      se `customers` ko bhi bachana padta — yaani poora reset hi bekaar.
 *   2. Cascade ke saath: `bank_transactions` mitate hi `balance_sheet_items` (6 rows) aur
 *      `txn_category_rules` (5 rows) bhi chale jate — theek wahi jo bachani hain, aur
 *      chup-chaap.
 *
 * Beech ki wo saari tables (`expenses`, `project_sales`, `prepaid_advances`,
 * `bank_transactions`, `customer_groups`) KHAALI hain — koi asli reference hai hi nahi.
 * DELETE rows dekhta hai, isliye wo bina rukavat chalta hai. Isliye DELETE.
 *
 * ─── KRAM KI SAMASYA, AUR USKA HAL ─────────────────────────────────────────
 * DELETE me bachche pehle mitne chahiye, phir maa-baap. 83 tables ka kram haath se likhna
 * ek aur galti ka nyauta hai. Iske bajaye: baar-baar chakkar lagao, har chakkar me jo mit
 * sakti hai use mita do, FK error aaye to us table ko agle chakkar ke liye chhod do. Jab
 * ek poore chakkar me kuch bhi na mite, ruk jao.
 *
 * Aur ANT ME JAANCH: agar phir bhi kisi table me row bachi hai, `raise exception` — jisse
 * POORA transaction wapas ho jata hai. Aadha reset sabse kharab nateeja hai; ye us haalat
 * ko asambhav banata hai.
 *
 * ─── VERIFY IS FILE ME NAHI HAI ────────────────────────────────────────────
 * CLAUDE.md §25.6: usi transaction ka SELECT bina commit hui haalat dekhta hai aur us
 * badlav ko "safal" bata deta hai jo abhi gायab hone wala hai. Ginti alag run me hogi.
 */

begin;

do $$
declare
  keep      text[] := array[
    /* Pehchan aur pahunch: ye gaye to login khatam */
    'users','tenant_secrets','tenant_domains','api_keys','user_google_tokens',
    'push_subscriptions',
    /* Wo ek brake jo quote.send ko hold par rokta hai */
    'ai_autonomy',
    /* Apna paisa aur accounting setup */
    'bank_accounts','txn_category_rules','balance_sheet_items',
    /* Log: asli staff ho sakte hain */
    'employees','attendance','attendance_settings','employee_loans','employee_documents',
    'employee_loan_repayments','leave_entries','salary_payments','reimbursements',
    'expense_claims',
    /* Setup aur templates */
    'vendors','support_plans','holidays','campaign_templates',
    /* Counters: mitaye nahi, 0 kiye jayenge (neeche) */
    'document_series','customer_number_seq',
    /* Personal vault */
    'personal_accounts','personal_holdings','personal_transactions','personal_vault_pin'
  ];
  targets   text[];
  tbl       text;
  pending   text[];
  next_pend text[];
  pass      int := 0;
  moved     boolean;
  leftover  text;
  total     bigint := 0;
  n         bigint;
begin
  select array_agg(c.table_name::text order by c.table_name)
    into targets
  from information_schema.columns c
  join information_schema.tables tb
    on tb.table_name = c.table_name
   and tb.table_schema = 'public'
   and tb.table_type   = 'BASE TABLE'
  where c.table_schema = 'public'
    and c.column_name  = 'tenant_id'
    and not (c.table_name = any (keep))
    /* ── Do tables jaan-boojh kar is loop se bahar ──────────────────────────
       contract_amendments: uspar append-only trigger hai jo DELETE se saaf mana kar deta
       hai — "delete the subscription itself if the whole record is being removed". Uski
       subscriptions wali FK ON DELETE CASCADE hai (jaancha), isliye subscription mitte hi
       wo apne aap chali jayegi. Ise zabardasti mitane ki koshish poore transaction ko
       gira deti hai.

       activity_log: ise SABSE AAKHIR ME mitana hai. customers/leads/quotes/payments par
       lage trg_activity_* trigger DELETE hone par activity_log me nayi row LIKHTE hain.
       Pehle mita dete to baaki deletes use dobara bhar dete, aur ant me ginti karne par
       lagta ki reset aadha reh gaya. */
    and c.table_name not in ('contract_amendments', 'activity_log');

  raise notice '% tables khaali ki jayengi (+ activity_log sabse aakhir me)',
    array_length(targets, 1);

  pending := targets;

  while array_length(pending, 1) > 0 and pass < 25 loop
    pass  := pass + 1;
    moved := false;
    next_pend := array[]::text[];

    foreach tbl in array pending loop
      begin
        execute format('delete from public.%I', tbl);
        get diagnostics n = row_count;
        total := total + n;
        moved := true;
      exception when others then
        /* ── `others` jaan-boojh kar, aur ye surakshit kyun hai ──────────────
           Sirf foreign_key_violation pakadna kaafi nahi nikla. Ye money app guard
           trigger se bhara hai, aur wo apni hi kism ka error uthate hain. Ek asli
           misaal: `customers` mitate hi FK `invoices.customer_id` ko NULL karti hai,
           aur tg_invoices_freeze_issued() use rok deta hai —

             "Invoice INV-TEST-2026-27-0006 has been issued, so its customer_id cannot
              be changed. Under CGST Section 34 ... corrected with a CREDIT NOTE"

           Wo rukavat sahi hai; bas kram galat tha — invoices pehle, customers baad me.
           Har guard ka naam ginne ke bajaye kram ko khud sulajhne dena zyada tikau hai.

           Ye isliye kuch nahi chhupata ki neeche wali jaanch har bachi hui table ka NAAM
           lekar `raise exception` karti hai, jisse poora transaction wapas ho jata hai.
           Yaani chup-chaap aadha reset ho hi nahi sakta. */
        next_pend := next_pend || tbl;
      end;
    end loop;

    pending := next_pend;
    exit when not moved;          -- ek poora chakkar bina pragati = ruk jao
  end loop;

  /* Aakhri jaanch: kuch bhi bacha to poora transaction wapas. */
  if array_length(pending, 1) > 0 then
    leftover := array_to_string(pending, ', ');
    raise exception 'Ye tables mit nahi payi (% chakkar ke baad): %. Kuch nahi badla.',
      pass, leftover;
  end if;

  /* Ab activity_log — sabse aakhir me, jab uspar likhne wale saare deletes ho chuke. */
  delete from public.activity_log;
  get diagnostics n = row_count;
  total := total + n;
  raise notice 'activity_log se % rows (sabse aakhir me)', n;

  raise notice 'Kul % rows mitayi, % chakkar me', total, pass;
end $$;

/*
 * GST document counters ko 0 par lao.
 *
 * ANUTECH ke counters nakli data se yahan tak pahunch gaye the: quote 72, purchase_order 52,
 * receipt_voucher 45, invoice 37. Inhe waise chhod dete to pehla ASLI invoice
 * INV-ADPL-2026-27-0038 banta, aur books me 0001–0037 kabhi maujood hi nahi hote. CGST
 * Rule 46 ke tehat wo audit me poochha jane wala sawaal hai — isliye ye kadam optional nahi.
 */
update public.document_series     set last_number = 0 where last_number <> 0;
update public.customer_number_seq set last_number = 0 where last_number <> 0;

commit;
