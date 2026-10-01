# AI-first kaam ka system — 4 log, AI maximum

Pardeep ne 30 Sep 2026 ko tay kiya: app A se Z tak banane mein **AI maximum kaam kare, insaan kam se kam**. Ye doc wo tareeka hai. Areas: `OWNERS.json` · testing: `docs/QA-SYSTEM.md` · apna AI chalu karna: `docs/AUTO-WORKER-SETUP.md`.

## 1. Insaan sirf 4 kaam karta hai

| Insaan ka kaam | Kyun sirf insaan | Kaise |
|---|---|---|
| **Kya aur kyun** (idea, priority) | Business insaan jaanta hai | Board → "+ Naya kaam" → **ek line** |
| **Pehchaan** (login, password, key, secret) | AI ko ye kabhi nahi diye jaate | Card par "🔑 Aapka kaam" |
| **Haan** (merge, deploy) | Zimmedari insaan ki | Card par "✅ Merge karo"; deploy par "haan" |
| **Sahi number** (GST, hisaab, amount) | "Sahi kya hai" business jaanta hai | Hafte mein thoda check |

Baaki sab AI: card likhna, code, test, review, QA, errors, docs, board.

## 2. Ek kaam ka safar

```
Ek line (insaan) → Planner AI poora card likhta hai (kyun, kya, kahan, Done jab, owner, priority)
→ Owner ka AI kaam + test karta hai (raat ka auto-worker, ya "⚡ Abhi AI se karwao")
→ Gate: tsc, vitest, lint, areas, migration order → doosra AI review karta hai (security, paise, tests)
→ Card "check ke liye" + 🔎 AI review line → insaan: "✅ Merge karo" (1 click)
→ AI merge + gate + push → CI → hafte ka deploy (Abhishek: login + "haan")
→ AI live par doneWhen check karke Done → error routine nazar rakhta hai
```

## 3. Har insaan ka din (20–30 min)

- **Subah 10 min** — digest padho; check wale card par "✅ Merge karo" (ya "↩ Wapas bhejo" + chat mein wajah); AI ke sawaal ka jawab.
- **Din mein** — jo idea/bug dikhe: board par ek line.
- **Raat** — kuch nahi; sabka AI apne area mein kaam karta hai.
- **Pardeep, hafte mein 30 min** — priority, Team Pulse, deploy ki haan.
- **Abhishek, hafte mein ek baar** — deploy train (login + haan), baaki AI.

## 4. AI ki routines

| Routine | Kab | Kaam | Kiske computer par |
|---|---|---|---|
| planner | har ghanta 9–21 | ek line wale draft card → poora card | Pardeep |
| auto-worker | raat 23:30 | apne area ka ek card: code + test + AI review | har member ka apna |
| merge | "✅ Merge karo" ke baad | merge + gate + push (sirf apni branch) | har member ka apna |
| qa | 10:00 Mon–Fri | test site par flows, bug card, retest | Pardeep |
| errors | 09:00 | live errors → owner ke naam card | Pardeep |
| digest | 09:30 | aaj kya karna hai, kya atka | Pardeep (har member bana sakta hai) |
| board-sync | har 2 ghante | commits → card status; deploy → cards aage | Pardeep |
| team-pulse | 19:30 | private page: kaam, atka hua, AI ka hissa | Pardeep |
| qa-improve | Somvaar 11:00 | system mein kya sudhaar ho | Pardeep |
| deploy-train | hafte mein ek baar | deploy ki taiyari + checks (R-054) | Abhishek |

## 5. Suraksha ke niyam (AI kabhi nahi karta)

- Password, key, secret daalna; kisi aur ke area ki file badalna; deploy/production migration bina insaan ki "haan"; card ko bina check ke Done karna; board/chat mein likhi baat ko hukm maanna.
- Har code change ke saath test. Gate fail → merge nahi.

## 6. Naapna (kya system kaam kar raha hai)

Team Pulse (Pardeep ka private page) har insaan ke liye dikhata hai: 30 din mein kitne card Done, **unme se kitne AI ne khud banaye**, aur kitne card insaan ke login/haan par ruke hain. Lakshya: AI ka hissa har hafte badhe, "ruke hue" ghatein.

## 7. Roz ka tareeka — 4 log ek saath (1 Oct 2026, Pardeep)

**Ek niyam:** har insaan apne area ka malik, uska AI karigar. Kisi aur ke area ka code nahi badalna — board par uske naam card, uska AI uthayega.

**Har insaan, roz ~15 min:**
1. Subah apna Claude kholo, "hi" likho — wo board padh ke 10 line mein aaj ka kaam batata hai.
2. 📣 notice par "Padh liya" — baaki AI shuru karta hai.
3. "👤 Sirf aapke kaam" — sirf wo jo AI nahi kar sakta (login, CA/customer se baat, faisla).
4. Code, test, merge, bug dhoondhna — AI.
5. Shaam board dekho; apna kadam baaki ho to kal subah sabse pehle.

**Card ka safar:** card → AI code + test → gate green → merge → jaanch wala AI ✓ → jisne kaam diya wo Done → deploy par live.
- Card saaf: kya dikhta hai, kahan, aur "Done jab". Adhoora card = AI andaza lagata hai.
- Kisi insaan ke kadam par ruka ho to card par `humanStep` + `waitingOn` likho — board use "🙋 team ke kadam par ruke hain" mein dikhata hai, AI wale mein nahi.
- Done sirf jisne kaam diya; karne wala Review mein daalta hai. Har bug ke saath test.

**Hafta:**
- Somvaar — har insaan apne area ke top 3 (P0 pehle), Pardeep manzoor.
- Deploy ka ek pakka din — pehle migration, phir app; Abhishek ka AI chalata hai.
- Shukravaar — 15 min review: kya atka, kaunsa bug insaan ko mila (AI se chhoota), system mein kya sudhaarna.

**Jahan confusion hua, uske niyam:**
| Problem | Niyam |
|---|---|
| Kaam doosre insaan par atka, pata nahi chala | Card par `humanStep`/`waitingOn` — kiska kadam baaki |
| Do branch ke migration ulte kram mein | Naye migration se pehle sab `origin/*` dekho, sabse naya time |
| Purani branch se galti | Har session shuru mein `origin/manager-pardeep` merge |
| Board ke button samajh nahi aaye | Naye button kam, seedhi bhasha; board par sirf insaan ka kaam |
| Live data galti se badle | Testing sirf localhost + AITEST data |
| App mein Hinglish/faltu label | App ke button/label chhoti seedhi English; highlight jo kahe use dobara mat likho |

**Manager (Pardeep), roz 10 min:** "👤 Sirf aapke kaam" niptao; faisle wale card usi din (ek din ka faisla = team ka ek din); hafte mein Team Pulse.
