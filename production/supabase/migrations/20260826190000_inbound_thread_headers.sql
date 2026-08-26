-- Inbound email ke thread headers darj karna.
--
-- ─── KYUN ───────────────────────────────────────────────────────────────────
-- 26 Aug 2026, Pardeep: "ek email id se to customer mujhse kai baar quote maang sakta hai,
-- kai reseller aise hain jo apne multiple clients ke liye quote maangte hain".
--
-- Wo sahi tha. `decideDisposition` ka niyam bina shart tha — bhejne wale ki khuli lead mili
-- to email usi par jud jata tha — to ek email id se doosra sauda shuru hi nahi ho sakta tha.
-- Uske apne data me ye ho chuka tha: 30 minute ke faasle par do alag subject wale email,
-- dono ek hi lead par jud gaye, aur lead ke seats overwrite hote rahe.
--
-- Sahi jawab email me pehle se hota hai — `In-Reply-To` aur `References` (RFC 5322). Wahi
-- tareeka har mail client thread banane ke liye use karta hai. Webhook inhe pehle se PARSE
-- karta tha (rawHeaders me), par kahin SAVE nahi karta tha — aur `lib/inbound/threads.ts`
-- ka comment isi kami ko naam se likhta hai:
--
--     "`inbound_emails` stores `message_id` but NEITHER of those headers, so nothing here
--      can reconstruct the actual reply chain."
--
-- ─── COLUMN KA NAAM: `thread_references`, `references` NAHI ──────────────────
-- `references` Postgres ka RESERVED KEYWORD hai (foreign key syntax). Us naam ka column
-- banta hai, par phir use har jagah double-quote karna padta hai, aur ek bhi jagah bhoolne
-- par error aisa aata hai jo column ki taraf ishara hi nahi karta. Naam badal dena sasta
-- hai; keyword se ladna nahi.
--
-- ─── SURAKSHIT ──────────────────────────────────────────────────────────────
-- Dono column nullable hain aur koi default nahi. Purani rows NULL rehti hain, aur NULL ka
-- matlab `thread-match.ts` me saaf hai: "pata nahi chala" — jiska nateeja nayi lead hai,
-- jo dikhti hai aur merge ki ja sakti hai. Koi backfill nahi, kyunki wo data mit chuka hai
-- aur uska andaza lagana usse bura hota.

alter table public.inbound_emails
  add column if not exists in_reply_to       text,
  add column if not exists thread_references text;

comment on column public.inbound_emails.in_reply_to is
  'RFC 5322 In-Reply-To header, jaisa aaya. Iska HONA batata hai ki mail kisi cheez ka jawab hai — dekho lib/inbound/thread-match.ts. NULL = forwarder ne nahi bheja.';

comment on column public.inbound_emails.thread_references is
  'RFC 5322 References header (space-separated message-ids). Naam `references` NAHI hai kyunki wo Postgres ka reserved keyword hai.';
