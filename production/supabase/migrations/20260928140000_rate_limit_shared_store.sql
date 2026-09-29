-- S20 (28 Sep 2026) — rate limiter ki saanjhi ginti.
--
-- lib/security/rate-limit.ts ki ginti har Cloud Run instance ki apni memory me thi, to asli
-- seema `limit × instances` thi. `RATE_LIMIT_STORE=postgres` par middleware har public request
-- par `rate_limit_hit()` bulata hai — sab instances ek hi row dekhte hain. RPC fail/dheemi ho
-- to TS memory par laut jaata hai, isliye ye migration na bhi chali ho to kuch nahi tootta.
--
-- Design:
--   · UNLOGGED table — ginti hai, hisaab nahi. Crash par khali ho jaye to bas ek khidki
--     ki ginti nayi; WAL/replica/PITR par iska bojh nahi.
--   · key = SHA-256 hex (TS me hi hash) — DB me kacha IP nahi.
--   · Ek hi statement (INSERT … ON CONFLICT) — do instances ek saath aayein to bhi ginti
--     row-lock par line me lagti hai, dono "pehli" nahi ban sakte.
--   · Purani rows: har call par ~1% sambhavna se saaf (koi cron nahi chahiye).
--   · service_role ONLY. anon/authenticated ko ye function milta to koi bhi kisi aur ki
--     balti bhar kar use 429 dila sakta tha.

create unlogged table if not exists public.rate_limit_buckets (
  key       text primary key,
  hits      integer not null,
  reset_at  timestamptz not null
);

alter table public.rate_limit_buckets enable row level security;
-- Koi policy nahi: RLS on + policy nahi = anon/authenticated ko kuch nahi dikhta.
revoke all on table public.rate_limit_buckets from public;
revoke all on table public.rate_limit_buckets from anon;
revoke all on table public.rate_limit_buckets from authenticated;

comment on table public.rate_limit_buckets is
  'S20: saanjhi rate-limit ginti (fixed window). Sirf public.rate_limit_hit() likhta hai. UNLOGGED — crash par khali hona theek hai.';

create or replace function public.rate_limit_hit(p_key text, p_limit integer, p_window_ms integer)
returns table(allowed boolean, hits integer, retry_after_sec integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  /* export_snapshots_for_offsite wala hi doosra pehra: asli deewar grant hai, ye us din ke
     liye jab koi grant galti se khul jaye. nullif(…,'') — khaali claims ''::jsonb par marte. */
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_now  timestamptz := clock_timestamp();
  v_hits integer;
  v_reset timestamptz;
begin
  if auth.uid() is not null or v_role in ('authenticated', 'anon') then
    raise exception 'rate_limit_hit is service_role only';
  end if;
  if p_key is null or length(p_key) = 0 or length(p_key) > 128 then
    raise exception 'rate_limit_hit: key 1..128 chars hona chahiye (TS sha256 hex bhejta hai)';
  end if;
  if p_limit is null or p_limit < 1 or p_window_ms is null or p_window_ms < 1000 or p_window_ms > 86400000 then
    raise exception 'rate_limit_hit: limit >= 1 aur window 1s..24h honi chahiye';
  end if;

  insert into public.rate_limit_buckets as b (key, hits, reset_at)
  values (p_key, 1, v_now + make_interval(secs => p_window_ms / 1000.0))
  on conflict (key) do update
    set hits     = case when b.reset_at <= v_now then 1 else b.hits + 1 end,
        reset_at = case when b.reset_at <= v_now then excluded.reset_at else b.reset_at end
  returning b.hits, b.reset_at into v_hits, v_reset;

  if random() < 0.01 then
    delete from public.rate_limit_buckets where reset_at < v_now - interval '1 hour';
  end if;

  return query select
    v_hits <= p_limit,
    v_hits,
    case when v_hits <= p_limit then 0
         else greatest(1, ceil(extract(epoch from (v_reset - v_now)))::integer) end;
end;
$$;

comment on function public.rate_limit_hit(text, integer, integer) is
  'S20: ek koshish gino (fixed window). service_role only — middleware RATE_LIMIT_STORE=postgres par bulata hai. Test: supabase/tests/rate_limit_shared_store.test.sql';

revoke all on function public.rate_limit_hit(text, integer, integer) from public;
revoke all on function public.rate_limit_hit(text, integer, integer) from anon;
revoke all on function public.rate_limit_hit(text, integer, integer) from authenticated;
grant execute on function public.rate_limit_hit(text, integer, integer) to service_role;
