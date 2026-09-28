# QA — Hitesh ka kaam kaise chalega

*28 Sep 2026. Hitesh Baghel: software testing. App ke user flows ko ek asli user ki tarah
chala kar dekhna, jo toota ya ajeeb lage use board par likhna, aur fix ke baad dobara check karna.*

## Kahan test karna hai

| jagah | URL | kab |
|---|---|---|
| **Online test environment** | https://reselleros-test-1027476185726.asia-south1.run.app | roz ka testing yahin. Iska data apna hai, asli customers ka nahi. |
| Local (apne laptop par) | `npm run dev:local` → http://localhost:3001 | sirf agar local Supabase set hai |
| **Production** | — | **Kabhi nahi.** Asli customers, asli invoice, asli paise. Wahan kuch banaya/badla to wo asli ho jaata hai. |

Payment hamesha **Razorpay test mode** mein; kabhi apna asli card mat daalna.
Login ke liye test account Pardeep dega — apna personal password kisi form mein mat daalna.

## Kya test karna hai (shuru yahan se)

1. [`docs/MANUAL-TEST-SCRIPT.md`](../MANUAL-TEST-SCRIPT.md) — Do / Expect ✓ wale journeys (lead → quote → payment → invoice → renewal). Pehle hafte yahi.
2. [`docs/TEST-PLAN.md`](../TEST-PLAN.md) — area-wise saare cases; 🔴 Critical wale pehle.
3. [`docs/SPINE-TEST-USE-CASES.md`](../SPINE-TEST-USE-CASES.md) aur [`docs/MONEY-FLOW-TEST-MATRIX.md`](../MONEY-FLOW-TEST-MATRIX.md) — paise ke hisaab wale cases (GST, IGST/CGST, discount).

Har round ki notes `docs/qa/runs/YYYY-MM-DD.md` mein likho (kya chalaya, kya pass, kya fail).
Ye folder aur `production/e2e/` (Playwright tests) aapke hain; baaki app code aap nahi badalte.

## Bug mile to — board par card

Board: https://claude.ai/artifact/2E442MT5zCLxm2oE1Lipos → **Main hoon: Hitesh** → **New task**.

- **Qism:** Request · **Kiska kaam:** jis area mein bug hai (neeche table) · **Title:** `Bug: <chhota sa kya toota>`
- **Kyun / detail** mein hamesha ye 5 cheezein:
  1. Kahan: page ka URL
  2. Steps: 1, 2, 3… kya click kiya
  3. Expected: kya hona chahiye tha
  4. Actual: kya hua (error ka text jaisa hai waisa)
  5. Screenshot / kis browser aur phone/laptop par
- **Priority:** P0 = paise galat, data doosre customer ka dikh gaya, login/payment band · P1 = flow atak gaya par raasta hai · P2 = dikhne mein galat · P3 = sujhaav
- Ek bug = ek card. Review / sujhaav (bug nahi) → `#qa` channel mein message.

| kis page par | kiska |
|---|---|
| Accounting, reports, leads/CRM, marketing, campaigns, payroll, purchases | Pardeep |
| Customers, quotes, subscriptions, renewals, invoices, payments | Abhishek |
| Public pages, `/buy`, checkout, login/signup, customer portal | Pawan |
| Pata nahi | Sab (Pardeep baant dega) |

## Fix ke baad — dobara check (retest)

Developer fix karke card ko **Review mein** karta hai. Board ke **My work** tab mein Hitesh ko
wo cards dikhenge jo **Hitesh ne khole the aur ab Review mein hain**. Test environment par
dobara wahi steps chalao:
- theek hai → #qa mein likho: `R-031 retest pass` — **Ho gaya** Pardeep karega
- ab bhi toota → #qa mein likho: `R-031 retest fail: <kya hua>` aur owner ko @naam

## Kya nahi karna

Production par test · asli customer ka data kahin copy karna · app code ya migration badalna ·
kisi aur ki branch par push · card ko khud Ho gaya / Mana kiya karna.
