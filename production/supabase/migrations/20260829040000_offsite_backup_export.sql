-- Off-site backup export: ek service-role-only raasta, taaki raat wala backup database ke
-- BAHAR bhi ja sake.
--
-- ─── YE KYUN CHAHIYE ────────────────────────────────────────────────────────
-- Roz 00:00 IST par `backup_all_tenants()` har tenant ka snapshot leta hai, aur wo chal bhi
-- raha hai — 29 Aug 2026 ko teeno tenant ke aaj ke snapshot maujood mile. Par wo sab
-- `backup.snapshots` me hain, yaani **usi database ke andar jiska wo backup hain**. Project
-- gaya to backup bhi usi ke saath jayega, aur is plan par Supabase ka apna koi backup nahi hai.
--
-- Database ke bahar ki ekmatra copy Pardeep ke laptop par thi, haath se banti thi, aur 29 Aug
-- ko teen din purani nikli. 26 Aug ko reset chal chuka hai, yaani ab jo data banega wo ASLI
-- hoga — abhi tak jo kho sakta tha wo nakli tha.
--
-- ─── MAUJOODA RPC KYUN KAAFI NAHI THI ───────────────────────────────────────
-- `get_tenant_backup(p_id)` payload deti hai, par `tenant_id = (select tenant_id from users
-- where id = auth.uid())` par bandhi hai. Cron service_role se chalta hai aur uska koi
-- `auth.uid()` nahi hota, to wahan se hamesha khaali aata hai. Wo shart sahi hai aur usme
-- haath nahi lagaya gaya — wahi cheez browser se aane wale har request ko rokti hai.
--
-- ─── SURAKSHA: GRANT SE, STRING PADH KAR NAHI ───────────────────────────────
-- Ye function HAR tenant ka poora data ek saath lautata hai. Isliye pahunch `revoke`/`grant`
-- se tay hoti hai — PostgREST role khud lagu karta hai, aur us par bharosa mere likhe hue
-- `current_setting('request.jwt.claims')` wale check se kahin zyada hai. Supabase har naye
-- function par `execute` PUBLIC ko deta hai, isliye neeche revoke karna choice nahi, zaroori
-- hai.
--
-- Body me ek doosra pehra bhi hai. Do pehre isliye ki agar kabhi koi migration galti se
-- `grant execute ... to authenticated` kar de, to wo galti chup-chaap cross-tenant leak na
-- ban jaye. Is repo me sabse mehngi galti wahi kism hai.

create or replace function public.export_snapshots_for_offsite(p_since timestamptz)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  /* `nullif(…, '')` choice nahi hai. `set_config('request.jwt.claims', null, true)` setting ko
     KHAALI STRING banata hai, NULL nahi — aur `''::jsonb` 22P02 se marta hai. Bina iske ye
     function har us session me crash karta hai jisne claims saaf ki hon, aur wo crash "backup
     nahi hua" jaisa hi dikhta. Pehli baar test chalate hi yahi hua. */
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_out  jsonb;
begin
  /* Doosra pehra. Asli deewar neeche wala grant hai; ye us din ke liye hai jis din koi
     grant galti se khul jaye. `auth.uid()` ka hona hi kaafi saboot hai ki ye ek browser
     session hai, aur ye function browser se kabhi nahi chalna chahiye. */
  if auth.uid() is not null or v_role in ('authenticated', 'anon') then
    raise exception 'export_snapshots_for_offsite is service_role only';
  end if;

  select coalesce(jsonb_agg(x order by x->>'created_at'), '[]'::jsonb) into v_out
  from (
    /* Har tenant ka sirf SABSE NAYA snapshot. Poora itihaas bhejna har raat pichhli
       raaton ki nakal dobara upload karta, aur off-site copy ka size roz badhta jaata
       bina kisi naye saboot ke. */
    select distinct on (s.tenant_id)
      jsonb_build_object(
        'tenant_id',   s.tenant_id,
        'tenant_name', t.name,
        'snapshot_id', s.id,
        'created_at',  s.created_at,
        'label',       s.label,
        'kind',        s.kind,
        'table_count', s.table_count,
        'payload',     s.payload
      ) as x
    from backup.snapshots s
    join public.tenants t on t.id = s.tenant_id
    where s.created_at >= p_since
    order by s.tenant_id, s.created_at desc
  ) q;

  return v_out;
end;
$$;

comment on function public.export_snapshots_for_offsite(timestamptz) is
  'service_role only. Har tenant ka sabse naya snapshot (p_since ke baad ka), taaki nightly '
  'cron use database ke bahar Cloud Storage par rakh sake. Browser se kabhi nahi.';

revoke all on function public.export_snapshots_for_offsite(timestamptz) from public;
revoke all on function public.export_snapshots_for_offsite(timestamptz) from anon;
revoke all on function public.export_snapshots_for_offsite(timestamptz) from authenticated;
grant execute on function public.export_snapshots_for_offsite(timestamptz) to service_role;
