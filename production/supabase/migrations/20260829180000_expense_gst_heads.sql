-- Kharche ka GST kis KHAANE me gaya — IGST, ya CGST + SGST.
--
-- ─── YE KYUN CHAHIYE ────────────────────────────────────────────────────────
-- `expenses` me GST ka ek hi khaana tha: `gst_paid`. Aur GST report har kharche par ye
-- karti thi (accounting/gst/page.tsx):
--
--     igst: 0,  cgst: round(g/2),  sgst: g - cgst
--
-- Yaani HAR kharche ka GST aadha-aadha CGST/SGST **maan liya** jata tha aur IGST hamesha
-- shunya. Wahan comment likha tha ki ye jaan-boojhkar hai aur "worksheet me flag" hoga —
-- 29 Aug 2026 ko screen par dhoondha, koi flag nahi tha.
--
-- Aur wo maan-na aksar galat hi hai. Us din ka asli invoice:
--
--     ALBERTO INFOTECH (UP, GSTIN 09…)  →  ANUTECH (Delhi, 07…)
--     Tax Type: IGST   ₹274.42
--     app kehti thi:   CGST ₹137 + SGST ₹137
--
-- GSTR-3B ke Table 4(A)(5) me teeno alag column hain. Galat khaane me daala gaya credit
-- GSTR-2B se mel nahi khata, aur wo farq return bharte waqt saamne aata hai — jab use
-- theek karna sabse mehnga hota hai.
--
-- ─── AANKDA PEHLE SE MAUJOOD THA ────────────────────────────────────────────
-- Sabse buri baat: bill padhne wala AI ye teeno alag nikalta hai (`read-bill.ts` ka prompt
-- `cgst`, `sgst`, `igst` maangta hai). Phir `add-expense-dialog.tsx:261` unhe
-- `cgst + sgst + igst` karke ek number bana deta tha. Batwara wahin marta tha.
--
-- ─── `gst_paid` KO HAATH NAHI LAGAYA ────────────────────────────────────────
-- Wo kul GST hi rehta hai, aur 273 file me uske call site hain. Naye khaane us par CHADHTE
-- nahi, uske SAATH rehte hain. Purani har row waisi hi kaam karti rahegi — bas ab wo saaf
-- kehlayegi "maani hui" (`lib/accounting/gst-heads.ts`), kyunki `null` ka matlab hai "pata
-- nahi", aur 0 ka matlab hota "naapa, aur shunya tha". Wo do baatein ek jaisi nahi hain,
-- isliye default 0 NAHI diya gaya.

alter table public.expenses
  add column if not exists igst integer,
  add column if not exists cgst integer,
  add column if not exists sgst integer;

comment on column public.expenses.igst is
  'Bill par likha IGST. NULL = bill par batwara tha hi nahi (0 se alag: 0 ka matlab "naapa, shunya tha"). Dekho lib/accounting/gst-heads.ts';
comment on column public.expenses.cgst is
  'Bill par likha CGST. NULL = pata nahi.';
comment on column public.expenses.sgst is
  'Bill par likha SGST. NULL = pata nahi.';

/* Rinaatmak GST kisi bill par nahi hota. Bina is pehre ke ek kharab value (jaise
   igst 150, cgst -50) jodkar kul se MEL KHA JATI, aur ek bekaar batwara "naapa hua" ka
   darja le leta — jo maane hue se bhi bura hai, kyunki wo sach jaisa dikhta hai. */
alter table public.expenses
  drop constraint if exists expenses_gst_heads_non_negative;
alter table public.expenses
  add constraint expenses_gst_heads_non_negative
  check (
    (igst is null or igst >= 0) and
    (cgst is null or cgst >= 0) and
    (sgst is null or sgst >= 0)
  );
