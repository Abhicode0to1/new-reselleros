-- Project quotation ka public link ab sirf UUID par nahi chalega.
--
-- 1 Sep 2026 ke security audit ne naapa: /api/public/project-quote/[id]/accept
-- bina kisi token ke chalta tha — project ki id (jo URL, email aur request-log
-- me dikhti hai) akeli kaafi thi quotation ko active project banane ke liye.
-- Har doosra public quote-route 0115 se ?t= token maangta hai; ye ek chhoot
-- gaya tha. Wahi pattern yahan bhi:

alter table public.project_sales
  add column if not exists public_token uuid not null default gen_random_uuid();

create unique index if not exists project_sales_public_token_key
  on public.project_sales(public_token);

comment on column public.project_sales.public_token is
  'Unguessable token for the public /project-quote/[id]?t= link — id akela kabhi kaafi nahi (SEC audit 1 Sep 2026).';
