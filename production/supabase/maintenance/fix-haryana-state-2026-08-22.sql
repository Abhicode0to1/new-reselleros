-- Correct one customer's state: Haryana (06), recorded as Delhi (07).
--
-- FOUND BY MEASURING, NOT BY THE DETECTOR — worth saying, because it marks the detector's
-- boundary. lib/gst/mismatch.ts asks "is the place of supply KNOWN". Here it was known and
-- simply WRONG, so nothing fired. Name-versus-state matching was deliberately left out of
-- the detector: "Delhi Traders" may sit in Mumbai, and a false alarm on a tax screen is the
-- most expensive kind of noise there is. This one surfaced while verifying an unrelated
-- change, and Pardeep confirmed it on 22 Aug 2026.
--
-- WHAT THIS FIXES AND WHAT IT DOES NOT
--   Fixes: every invoice raised for this customer FROM NOW ON gets IGST, because
--   isInterStateSupply will finally have two different states to compare.
--
--   Does NOT fix: INV-ADPL-2026-27-0023, already issued and already PAID today, which
--   carries CGST + SGST. A tax head cannot be corrected by editing an issued invoice — the
--   customer holds a document showing the split, and silently changing the row would make
--   the books disagree with the paper. That needs a credit note (CGST s.34), and whether to
--   go that route or correct before the August GSTR-1 is filed is a decision for a CA, not
--   for this script.
--
-- WORTH KNOWING BEFORE PANICKING: the AMOUNT is not wrong. 18% is 18% either way — Rs 5,832
-- on Rs 32,400 whether it is CGST 9 + SGST 9 or IGST 18. The customer has not been
-- over- or under-charged. What is wrong is the HEAD: the tax was paid into the wrong pots,
-- and a Haryana buyer cannot claim a CGST+SGST credit.
--
-- GUARDED: one id, and only while it still reads 07, so a re-run or a since-corrected row
-- changes nothing.

update public.customers
   set state_code = '06',
       state      = 'Haryana'
 where tenant_id  = 'fbb976f1-9090-4f10-9726-0901bd144e42'
   and name       = 'HARYANA'
   and state_code = '07'
returning id, name, state_code, state;
