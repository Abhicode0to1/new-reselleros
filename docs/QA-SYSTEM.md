# QA system — testing, workflows aur errors automatic kaise pakde jaate hain

Pardeep ne 30 Sep 2026 ko tay kiya: testing ka zyadatar kaam machine/AI kare, 4 log sirf wo karein jo insaan hi kar sakta hai — aur **ye system har hafte behtar hota rahe** (neeche "Har hafte sudhaar").

## 1. Kya automatic chalta hai

| Kab | Kya | Kahan | Haalat (30 Sep) |
|---|---|---|---|
| Har push | CI: typecheck, unit tests, lint, build, migration order; SQL tests (RLS, paise) | `.github/workflows/ci.yml` | S44 mein SQL job + teeno dev branches jud rahe hain |
| Har push + raat | E2E (Playwright) — neeche ke 15 workflows, test company par, logged-in | `production/e2e/` | ~70 auth tests skip hote hain (test users/secrets nahi) — R-053 |
| Roz 10:00 (Mon–Fri) | AI QA routine `reselleros-qa`: test site ke pages + flows, fail → bug card, fix ke baad auto retest | `production/e2e/qa/run.mjs` | Chal raha hai (abhi sirf public + buy pages) |
| Roz 09:00 | Error routine `reselleros-errors`: production ke Cloud Run ERROR logs → group karke owner ke naam card | scheduled task | 30 Sep se |
| Har minute | Uptime check "ResellerOS live" + alerts | Cloud Monitoring | S9 |
| Raat 23:30 | Auto-worker: Pardeep ke area ke code cards local branch par | scheduled task | Chal raha hai |
| Somvaar 11:00 | Sudhaar routine `reselleros-qa-improve`: hafte ke bugs dekh kar system mein kya kami rahi | scheduled task | 30 Sep se |

## 2. Kaun kya karta hai

- **Pardeep (manager) + AI** — QA system ka malik (30 Sep se areas badle: Hitesh ab Accounting module): E2E suite, test company + test users, retest AI QA karta hai; hafte mein ek baar phone par haath se ghoomna (docs/MANUAL-TEST-SCRIPT.md).
- **Hitesh (Accounts)** — Accounting/GST/payroll module ka malik; apne workflows (W10–W13) ke tests.
- **Abhishek, Pawan, Hitesh** — **har fix ke saath test** (taaki bug wapas na aaye); Done/Review se pehle push + CI green; apne area ke bug card.
- **Pardeep** — hafte mein 30 min: naye bugs + Team Pulse dekh kar priority; business ke number (accounting, GST, renewal amount) khud check — "sahi number kya hai" ye wahi jaante hain.
- **Claude** — routines chalana, untested critical routes (webhooks, payments) ke tests likhna, errors ko sahi owner tak pahunchana, har hafte sudhaar ka prastav.

## 3. 15 main workflows (E2E aur AI QA inhi par chalte hain)

| # | Workflow | Area | Automatic test |
|---|---|---|---|
| W1 | Signup → /welcome → company bani / join request | Pawan | anutech-*.spec.ts (hissa) |
| W2 | Login, logout, password reset, role wise menu | Pawan | role-permissions.spec.ts |
| W3 | Lead aaya (form / IndiaMART) → assign → follow-up | Pardeep | lead-flow.spec.ts |
| W4 | Lead → quote → customer ko bhejna | Abhishek | money-spine.spec.ts (hissa) |
| W5 | Quote pay (Razorpay test) → invoice → subscription | Abhishek | money-spine.spec.ts |
| W6 | Seats badhana (duplicate nahi) | Abhishek | — (Journey 2 haath se) |
| W7 | Renewal reminder → renewal quote → pay → nayi date | Abhishek | — |
| W8 | Overdue invoice → dunning email/WhatsApp | Pardeep | — |
| W9 | Credit note / refund | Abhishek | — |
| W10 | Expense / purchase bill → GST input | Pardeep | — |
| W11 | GST reports: GSTR-1, 3B, HSN — invoice se milaan | Pardeep | — |
| W12 | Trial balance, P&L, Day Book | Pardeep | — |
| W13 | Salary / payroll run | Pardeep | — |
| W14 | Customer buy page (public) → checkout | Pawan | e2e/qa/buy-workspace.spec.ts |
| W15 | Ek company doosri ka data na dekh sake; sales role owner ka kaam na kar sake | Sab | cross-tenant.spec.ts, role-permissions.spec.ts |

"—" wale workflows ka test likhna R-053 ka hissa hai. Naya bada feature aaye to yahan row jodo.

## 4. Bug ka safar

bug mila (AI QA / error routine / team / customer) → board par owner ke naam card (steps, expected, actual) → owner fix + **test** → push, CI green → Review → AI retest (ya bug batane wala) pass → Done.

## 5. Har hafte sudhaar (system ko behtar karte rehna)

Har Somvaar `reselleros-qa-improve` pichhle hafte ko dekhta hai:
- Kaunse bug **insaan ne pakde jo automatic system se chhoot gaye** → unke liye kaunsa test/check jode.
- Kaunse checks bekaar shor (false alarm) karte hain → hatao ya sudhaaro.
- Kaunse workflows (upar ki table) ka test ab bhi "—" hai.
- CI kitni baar laal hua, aur kyun.

Wo Pardeep ko 1–3 sudhaar suggest karta hai; Pardeep "haan" bole to card banta hai. Jo sudhaar ho gaya, neeche log mein ek line.

### Sudhaar log
- 30 Sep 2026 — system shuru: error routine, weekly sudhaar routine, 15 workflows ki list, R-053 (auth E2E).
