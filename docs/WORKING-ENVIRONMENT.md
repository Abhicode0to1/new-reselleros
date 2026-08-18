# Working environment — kaam tez karne ke liye

> Likha 18 Aug 2026, ek aise session ke baad jo paanch goals tak chala. Har cheez **naapi
> hui** hai ya usi session me **asli me hui** — andaza nahi. Jahan mera pehla andaza galat
> nikla, wo bhi likha hai, kyoki wahi sabse zyada kaam ka hissa hai.

---

## Pehle: jo maine socha tha aur galat tha

Maine kaha tha "Stop hook har turn par 2926 tests chalata hai, ~40-60 second". **Naapa:**

```
Tests 2926 passed · Duration 7.26s · wall clock 9 sec
```

**9 second.** Ye problem nahi hai — ise chhedna hi nahi chahiye. Wo hook `CLAUDE.md §25.2`
me likhi wajah se hai (4 test mahino tak toote pade the, kyoki koi darwaza nahi tha), aur 9
second us bima ki bahut sasti keemat hai.

Sabak: **"slow lag raha hai" aur "slow hai" alag cheezein hain.** Naapo, phir badlo.

---

## Asli waqt kahan jaata hai — naapa hua, bade se chhota

| # | Kya | Kitna | Kiska kaam |
|---|---|---|---|
| 1 | `npm run build` **10+ minute** | Is session me 2 baar = 20+ min | Aap (§4) |
| 2 | Permission classifier ne **~8 call** rokin | Har rok = poora round trip barbaad | Aap (§1) |
| 3 | `SUPABASE_ACCESS_TOKEN` galat — CLI aur **dono MCP server** todta hai | Har DB read slow raaste se | Aap (§2) |
| 4 | Ek session me **5 goals** → baar-baar compaction | Detail ghisti hai, main apni purani baat galat yaad karta hoon | Aap (§5) |
| 5 | `CLAUDE.md` **827 lines** + `AGENTS.md` **259** = har session 1086 lines | Fixed tax, kabhi kam nahi hota | Main (§6) |

---

## §1 — Permission rules (sabse bada, 2 minute)

### Aaj ka live saboot

Ye migration **teen baar** ruki: `create function` do baar, `-f` ek baar. Aapne ek line
jodi, aur **turant lag gayi**. Wahi ek line ne teen round trip bacha diye.

### Aapne aaj ek galti ki thi — ye samajhna zaroori hai

Aapne line jodi par **comma chhoot gaya**:

```json
"allow": [
"Bash(npx supabase db query:*)"        ← comma nahi
      "Bash(cd /c/dev/...
```

Isse poori file **invalid JSON** ban gayi. Aur Claude Code aisi haalat me us file ki
**saari** permissions chup-chaap band kar deta hai — sirf nayi line nahi, **saari 185**.
Koi error nahi dikhta. Bas sab kuch permission maangne lagta hai aur wajah nahi pata chalti.

**Hamesha check karo** — file badalne ke baad ye chalao:

```bash
node -e "JSON.parse(require('fs').readFileSync('.claude/settings.local.json','utf8'));console.log('VALID')"
```

`VALID` na dikhe to file tooti hai.

### Aur ek baat: aapki jodi hui line mere commands se match nahi karti

Rule prefix se match hota hai. Aapne jodi:

```
Bash(npx supabase db query:*)
```

Par main token ke chakkar me commands aise chalata hoon:

```
env -u SUPABASE_ACCESS_TOKEN npx supabase db query --linked ...
```

Ye `npx` se shuru nahi hota, `env` se hota hai — **to rule match nahi karta.** Isi liye
trigger lag gaya par uske baad ka verification probe phir ruk gaya.

Do me se koi ek karo:

**Behtar** — token theek karo (§2). Phir `env -u` ki zaroorat hi nahi, aur aapki maujooda
line kaam karne lagegi.

**Ya turant** — ye line bhi jod do (comma ke saath!):

```
"Bash(env -u SUPABASE_ACCESS_TOKEN npx supabase db query:*)",
```

### Aur ye teen, jo har session me kaam aati hain

```
"Bash(bash deploy.sh)",
"Bash(git log:*)",
"Bash(npx supabase migration list:*)",
```

> **Tradeoff imaandari se:** har rule ek jaanch hatati hai. `db query:*` ka matlab hai main
> bina poochhe production database me likh sakta hoon. Ye aapne aaj jaan-boojh kar diya.
> `Bash(*)` jaisa kuch **kabhi mat** jodna — wo saari jaanch khatam kar deta hai.

---

## §2 — `SUPABASE_ACCESS_TOKEN` theek karo (ye do jagah tod raha hai)

### Live saboot

Aapke Command Prompt me:

```
Invalid access token format. Must be like `sbp_0102...1920`.
```

Maine yahi mere shell me jaancha (**value nahi chhapi**):

```
len=75   first4=sbp_   charset_ok=0
```

Asli PAT = `sbp_` + **40 hex** = 44 chars. Jo set hai wo **75 chars** ka hai aur hex nahi.
Yaani wo Supabase ka access token hi **nahi** hai — kuch aur hai jo galat naam se rakha gaya.

### Isse do cheezein tooti hain

1. **CLI** — isi liye har command me `env -u SUPABASE_ACCESS_TOKEN` lagana padta hai.
2. **Dono MCP supabase server** — `mcp__supabase__execute_sql` ne is session me
   `Unauthorized. Please provide a valid access token` diya. MCP me `env -u` ka option
   nahi hai. To har DB read slow CLI raaste se gaya, jabki MCP tez hai.

### Kya karna hai

Ye credential ka kaam hai — main na token maangunga na dikhaunga. Aap khud:

1. Windows me **Start → "environment variables" → "Edit the system environment variables"**
2. **Environment Variables…** button
3. User variables me `SUPABASE_ACCESS_TOKEN` dhundo
4. Us par sahi PAT lagao — Supabase dashboard → **Account → Access Tokens** → naya banao
   (`sbp_` + 40 hex). **Ya** agar zaroorat nahi to variable **Delete** kar do — CLI stored
   login se chal jaata hai (aaj `env -u` isi liye kaam kiya).
5. **Command Prompt band karke naya kholo** (env var purani window me nahi badalti)
6. Check: `npx supabase projects list` — list aani chahiye, error nahi

Delete karna sabse saaf hai, kyoki `supabase login` pehle se hua hua hai.

---

## §3 — Duplicate MCP server hatao

**Naapa hua** — asli me sirf ye configured hain:

```
project .mcp.json  → supabase
global ~/.claude.json → gw-pro, supabase-db
```

`supabase` aur `supabase-db` **ek hi kaam** karte hain. Dono ke tools har turn me jagah
khaate hain. Ek hata do — `supabase-db` (global wala), kyoki project wala `.mcp.json` me hai
aur team ke saath chalta hai:

```bash
claude mcp remove supabase-db
```

> Maine pehle kaha tha "3 supabase server aur ~12 marketing/finance server configured hain".
> **Wo galat tha.** Config me sirf 2 supabase hain. Marketing/finance/figma/canva wale
> **plugins** se aate hain, aur `enabledPlugins` teeno settings files me khaali hai — to main
> aapko koi line nahi bata sakta jo delete karni hai. Wo plugin UI se band hote hain.

---

## §4 — Build 10+ minute se kam karo (sabse bada waqt)

Is size ke Next.js app ke liye 10+ minute **abnormal** hai. Windows par sabse aam wajah:
**Defender har `node_modules` file scan karta hai.**

**PowerShell ko "Run as Administrator" se kholo** (Start → PowerShell par right-click →
Run as administrator) aur ye chalao:

```powershell
Add-MpPreference -ExclusionPath "C:\dev\ResellerOSv3 - Copy"
```

Check:

```powershell
(Get-MpPreference).ExclusionPath
```

Phir build ka time naapo:

```bash
cd /d "C:\dev\ResellerOSv3 - Copy\production" && powershell -Command "Measure-Command { npm run build }"
```

### Aur build ke do niyam jo aaj bhi kaate

1. **Dev server chalte waqt build kabhi mat chalao.** `.next` ud jaata hai aur chalta hua
   page apne hi chunks par 404 deta hai — bilkul "deploy toot gaya" jaisa dikhta hai. (Ye
   memory me hai: `build-dev-server-clash`.)
2. **Build tabhi chalao jab deploy karna ho** ya branch khatam ho. Har turn par nahi.
   `typecheck + test + lint` 1 minute me ho jaate hain; build unse alag cheezein pakadta hai
   (typedRoutes, prerender) — `CLAUDE.md §25.2`.

---

## §5 — Ek goal, ek session (context ke liye sabse bada)

Ye session **paanch** goals chala: Enquiries Hub → Poka-Yoke → Billing → Keyboard →
Hierarchy. Beech me kai baar compaction hua.

**Asli nuksaan, aaj ka:** compaction ke baad maine **do baar** apni hi purani baat galat yaad
ki — kaha "main DDL apply nahi kar sakta" jabki maine wo test hi nahi kiya tha. Jab test
kiya, chal gaya. Do round trip us ek galat yaad par gaye.

**Kya karna hai:** naya goal = **naya session**. Purana kaam nahi khota — commits aur memory
files me hai. Ek session me 2 se zyada goal na le jaao.

---

## §6 — Har session ka fixed tax kam karo

```
production/CLAUDE.md   827 lines
AGENTS.md              259 lines
```

Ye **har session me poora padha jaata hai**. 1086 lines ka tax jo kabhi kam nahi hota.

Isme se ye hisse ab kaam ke nahi lagte:
- §18 Roadmap (Phase 1-5 with weeks) — timeline kabhi follow nahi hui
- §19 Contacts (P1/P3/P4) — ye log naam se maujood nahi hain
- §17b ke "TBD" RPC — teeno ab ban chuke hain
- §12 Performance budgets — kabhi naape nahi gaye

Ye mera kaam hai. Bolo to main chhaant dunga — jo sach me niyam hain wo rahenge, jo
aakanksha thi wo hategi.

---

## Kaam dene ka sahi tareeka — jo aaj tez chala aur jo slow

### Tez chala

| Aapne kaha | Kyo tez chala |
|---|---|
| "ye annual 2004 support project me kyo dikha raha jabki quote 2000 ka tha" | Ek screen, ek galat number, ek expectation. Main seedha reproduce karke fix kar saka. |
| "chalu kar do, jo tumhe sahi lage wo karo" | Faisla mera, par daayra saaf. Maine naapa, behtar design chuna, laga diya. |
| "1" | Ek shabd, poora saaf — kyoki options pehle likhe the. |

### Slow chala

| Aapne kaha | Kya hua |
|---|---|
| "ab kya karna hai" (3 baar) | Har baar wahi list dohrai gayi. Ek option chun lena 3 turn bacha deta. |
| `/goal` ke 5-step block | Bade hain. Har step ke beech gate chalta hai. Theek hain, par ek session me ek hi. |
| kuch nahi (chup rehna) | Stop hook mujhe wapas chalu karta rehta hai; main "intezaar" likhta hoon aur turn barbaad hote hain. **Bas ek shabd likh do** — "ruko" ya "chhod do". |

### Teen aadatein jo sabse zyada bachaayengi

1. **Screenshot ke saath wo likho jo aapko dikhna chahiye tha.** "Q-2026-9776 accepted hai
   par Record payment ka option nahi" — isme screen, record, aur ummeed teeno thi. Us bug par
   ek hi round laga.
2. **"Ho gaya" ya "ye error aaya + poora output"** — aadha output slow karta hai. Aaj
   `Invalid access token format` ka poora line dekh kar hi asli wajah mili (version nahi,
   env var).
3. **Jab kuch do baar kaate, bolo "isko yaad rakho".** Main memory file bana dunga jo agle
   session me apne aap aa jayegi. Aaj do bani: `do-supabase-project-hain`,
   `supabase-token-env-var-toota-hai`.

---

## Karne ka order

1. **§2 token** — do jagah theek karta hai (CLI + MCP), aur §1 ki aapki line kaam karne
   lagti hai
2. **§4 Defender exclusion** — sabse bada single time saving
3. **§1** me `bash deploy.sh` aur `git log:*` jod do, aur JSON check karna seekh lo
4. **§3** `claude mcp remove supabase-db`
5. **§6** mujhe bolo, main docs chhaant dunga
6. **Agla goal naye session me**
