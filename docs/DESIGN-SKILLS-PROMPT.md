# Design skills — jo hai, jo nahi hai, aur paste karne wala prompt

> Likha 25 Aug 2026. Sawaal tha: "kaun se design skill se is app ka design behtar hoga aur unhe
> kaise use karein". Jawaab do hisson me hai, aur pehla hissa ek **finding** hai.

---

## 1. 🔴 CLAUDE.md do skill mandatory kehta hai. Wo maujood nahi hain.

`production/CLAUDE.md` §0.9 likhta hai:

> "After building any new screen/component, run the `design-critique` and `accessibility-review`
> skills; **'design done' = design-critique + a11y (WCAG AA) pass**"

**Teen jagah dhoondha, teenon khaali:**

| Kahan dekha | Nateeja |
|---|---|
| Enabled claude.ai skills | `import-memory`, `morning`, `skill-creator`, `xlsx`, `pptx`, `pdf`, `docx` — **koi design skill nahi** |
| Skill catalogue (design/a11y/WCAG/UI keywords) | **0 result** — add karne ko bhi nahi hai |
| Repo ke local skills (`.claude/skills/`) | **ek** — `resellersos-env`, aur wo environment access ka hai, design ka nahi |

`design-critique` aur `accessibility-review` sirf **prose me** hain — CLAUDE.md, `docs/UX-AUDIT.md`
aur TASKS.md me naam se. **Wo kabhi bane hi nahi.**

**Matlab:** "design done" ka gate jab se likha gaya hai **tab se poora hi nahi ho sakta.** Aaj bhi
maine `/leads` par chha UI fix kiye aur wo dono skill nahi chalayi — chala hi nahi sakta tha.

---

## 2. Jo maujood hai: `skill-creator`

Ye **enabled hai**. To sahi kaam "koi skill dhoondho" nahi, **"wo do skill banao"** hai.

Aur banane layak material sach me maujood hai — isliye skill **generic nahi**, is app ki hogi:

| Material | Kitna |
|---|---|
| `globals.css` design tokens | **48 CSS variable** (amber/emerald/hairline/ink/paper + 3 font) |
| `tailwind.config.ts` defines | colors, fontFamily, screens, borderRadius, animation, container |
| `tailwind.config.ts` me **NAHI** hai | **`fontSize`** — 2,305 arbitrary `text-[Npx]` ka asli kaaran |
| `components/ui/` primitives | **28** (button, badge, card, dialog, sheet, status-pill, fab…) |
| CLAUDE.md ke design sections | §5 tokens · §6 fonts · §8 components + a11y · §20 responsive (poora breakpoint table + per-device rules + anti-patterns) |

**Ye zaroori hai:** generic "contrast check karo" wali skill bekaar hai, kyunki wo audit tool
pehle se deta hai. Is app ki asli samasyaayein **naapi hui aur khaas** hain:

- **2,010 element 12px se neeche**, 370 me se 273 file me (`docs/TYPE-SCALE-PROPOSAL.md`)
- **74 one-off raw button style**, jabki shared `<Button>` **1,039 baar** istemal hota hai
- `text-[11px]` line-height set **nahi** karta, `text-xs` karta hai — isliye rename layout hila deta hai
- §20 ka mobile rule: **table ko card list banao**, warna horizontal scroll

---

## 3. Paste karne wala prompt

Neeche wala poora block copy karke Claude Code me paste karo.

```
GOAL: Build the two design skills CLAUDE.md §0.9 already requires — `design-critique` and
`accessibility-review` — as LOCAL repo skills in .claude/skills/, using skill-creator.

Both are named as mandatory in production/CLAUDE.md §0.9 and neither exists. Verify that first
(ListSkills, SearchSkills, and ls .claude/skills/) and tell me if I'm wrong before building.

MAKE THEM THIS APP'S SKILLS, NOT GENERIC ONES. A skill that says "check colour contrast" is
worthless — an audit tool already does that. Read these before writing a line, and encode what
they actually say:

  production/CLAUDE.md            §5 tokens · §6 fonts · §8 components+a11y · §20 responsive
  production/src/app/globals.css  the 48 design tokens
  production/tailwind.config.ts   what IS defined — and note fontSize is NOT
  production/src/components/ui/   the 28 primitives a new screen must reuse
  docs/TYPE-SCALE-PROPOSAL.md     the measured type problem and its three options
  docs/UX-AUDIT.md                what has already been found

EACH SKILL MUST BE MEASURABLE, NOT ADVISORY. Every check states what to count and the number that
fails it, so two runs on the same screen agree. For example, and extend this list from what you
find in the repo:

  design-critique
    - arbitrary type: count text-[Npx] in the files touched. Any is a finding — the scale gap is
      documented, so the fix is the scale, not the call site.
    - raw <button>: count them against <Button>. A raw one needs a stated reason.
    - hardcoded colour: any bg-white / text-black / bg-rose-100 style class outside globals.css.
    - §20: does every table have a card-list alternative under md? Is there a FAB where the
      desktop header has a primary action?
    - active/selected states: do they match the rest of the app, or is this a third vocabulary?

  accessibility-review
    - every interactive element keyboard-reachable, and the focus ring visible against ITS OWN
      background (the amber ring on amber-soft is the case to check).
    - aria-pressed on every toggle. I found raw filter buttons missing it today.
    - every icon-only button has an aria-label.
    - truncated text carries a title, so an ellipsis is not lost content.
    - contrast at WCAG AA, computed from the tokens rather than eyeballed.
    - no colour-only meaning — chips and pills must not rely on hue alone.

OUTPUT SHAPE. Each skill returns findings as: file:line · what · the measured number · the fix ·
severity. Ranked worst first. If a screen is clean, say so in one line — a skill that always finds
something teaches me to ignore it.

THEN PROVE THEY WORK. Run both against /leads, which I know has real problems, and against one
screen you believe is clean. Show me both outputs. If the clean one produces a page of findings,
the skill is miscalibrated — fix it before telling me it's done.

CONSTRAINTS
- No new dependency.
- Don't change any UI in this task. Build the skills, run them, report. Fixes come after I see
  the findings.
- Gate before you call it done: cd production && npm run typecheck && npm run test && npm run lint
- Don't edit CLAUDE.md §0.9 to match what you built — if the skill names differ, tell me and I
  decide which moves.
```

---

## 4. Kyun ye prompt aise likha hai

| Line | Wajah |
|---|---|
| "Verify that first… tell me if I'm wrong" | Mera naap galat ho sakta hai. Ek session pehle jaanche, phir bnaye. |
| "NOT GENERIC ONES" + file list | Bina iske skill "use semantic HTML" likhegi, jo kisi kaam ki nahi. |
| "MEASURABLE, NOT ADVISORY" | Jo check ginti nahi deta, wo do run me do jawaab deta hai. |
| "extend this list from what you find" | Meri list poori nahi hai — repo me aur milega. |
| "run against one screen you believe is clean" | **Sabse zaroori line.** Jo skill hamesha kuch nikaalti hai, use log ignore karna seekh jaate hain — wahi `money-health-card` ka tark hai (healthy par kuch render nahi karta). |
| "Don't change any UI in this task" | Warna skill banane wala hi UI badal dega aur pata nahi chalega kis cheez ne kya theek kiya. |
| "Don't edit CLAUDE.md §0.9" | Rulebook ko code se milane ke bajaye code ko rulebook se milao — ya faisla insaan kare. |

---

## 5. Iske baad kya

Skill ban jaane ke baad **pehla asli kaam** `docs/TYPE-SCALE-PROPOSAL.md` ka Option A hai —
scale + ESLint rule. Wo **2,010 element ka sabse bada single sudhaar** hai aur uske chaar faisle
abhi khule hain (us doc ke §7 me).
