---
name: design-critique
description: Review a screen or component against THIS app's design system — the tokens in globals.css, the 28 primitives in components/ui, and CLAUDE.md §5/§6/§8/§20 — and report countable findings rather than opinions. Load before calling any UI work done, and whenever CLAUDE.md §0.9's "design done" gate is invoked. Every check names a number, so two runs on one screen agree. Not a generic design review: the checks encode failures measured in this repo, and the false positives it has already produced.
---

# design-critique

CLAUDE.md §0.9 requires this skill and it did not exist until 25 Aug 2026. Six UI fixes shipped to
`/leads` that day without it, because it could not be run.

**Report countable findings, never opinions.** "This feels cluttered" is what a person says; this
skill says "153 arbitrary font sizes in 24 files". A check with no number produces a different
answer on the second run, and a review nobody can reproduce is a review nobody acts on.

**Say CLEAN when clean, in one line.** A skill that always finds something teaches the reader to
skim it — the same argument `money-health-card.tsx` makes for rendering nothing when healthy.

---

## 0. Scope, before any check

A screen is its page file **plus the components only it uses**. `/leads` is
`src/app/(app)/leads/page.tsx` plus `src/components/features/leads/*.tsx` — 24 files, not one.
Reviewing the page alone misses most of the UI.

```bash
cd production
P="src/app/(app)/<screen>/page.tsx"
L="src/components/features/<screen>"
F=$(echo "$P"; ls $L/*.tsx 2>/dev/null | grep -v "\.test\.")
echo "$F" | tr ' ' '\n' | grep -c tsx     # state the file count in the report
```

---

## 0a. ⚠️ ASSERT THE PATH BEFORE EVERY BROWSER MEASUREMENT

On this skill's first run, three browser checks were taken against `/dashboard` while the report
was headed `/leads`. `location.href = "/leads"` had not stuck — the app was still on its default
route — and the numbers that came back were confident, plausible, and about the wrong screen. The
tell was a label in the output ("Review the automation dials") that belongs to a dashboard card.

So every browser snippet starts by refusing to run anywhere else:

```js
if (location.pathname !== "/leads") return JSON.stringify({ ABORT: location.pathname });
```

And navigate with `window.location.assign(path)`, then read `location.pathname` back in a SEPARATE
call before measuring. Same discipline as applying a migration and verifying it in a separate run
(`resellersos-env` §2): a check that shares a call with the thing it is checking cannot fail.

---
## 1. Arbitrary font sizes — the largest single problem in this codebase

`tailwind.config.ts` defines `colors`, `fontFamily`, `screens`, `borderRadius`, `animation` and
`container`. It does **not** define `fontSize`. So there is no type scale, and 2,305 elements use
`text-[Npx]` — 2,010 of them below 12px, across 273 of 370 `.tsx` files.

```bash
grep -ho "text-\[[0-9.]*px\]" $F | sort | uniq -c | sort -rn
```

**Any count above zero is a finding**, and the fix is **not** the call site. Patching four
instances makes the screen inconsistent with the other 2,301 and improves nothing measurable.
Point at `docs/TYPE-SCALE-PROPOSAL.md` and report the count.

**Say this too, because it decides whether the fix is safe:** `text-[11px]` sets `font-size` only.
`text-xs` sets `font-size` **and** `line-height`. 2,052 elements currently inherit their
line-height, so a scale defined the normal Tailwind way changes vertical rhythm everywhere.

---

## 2. Hardcoded colours — CLAUDE.md §5

> "Never hardcode colors in components. Use Tailwind tokens: `bg-paper` not `bg-white`,
> `text-ink` not `text-black`, `border-hairline` not `border-gray-200`."

48 tokens exist in `globals.css`. App-wide there are still **248** raw palette values and **98**
bare `bg-white` / `text-black` / `bg-black` / `text-white`.

```bash
grep -hoE '\b(bg|text|border|ring)-(white|black|gray|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(50|100|200|300|400|500|600|700|800|900|950)\b|\b(bg-white|text-black|bg-black|text-white)\b' $F | sort | uniq -c | sort -rn
```

Report each with its `file:line`. These ARE worth fixing at the call site — unlike §1, a token
swap is one-for-one and changes nothing but the theme binding.

**`text-white` on a coloured fill is the one to check rather than assume.** `bg-ink text-paper` is
the token form; `bg-black text-white` is not, and the difference shows in dark mode.

---

## 3. Raw `<button>` against the shared primitive

`components/ui/button.tsx` is used **1,039** times app-wide. There are also **415** raw
`<button>` elements carrying **83** distinct class combinations, **74** of them used exactly once.

```bash
echo "raw: $(grep -ho '<button' $F | wc -l) · primitive: $(grep -ho '<Button' $F | wc -l)"
```

A raw `<button>` is not automatically wrong — a filter chip legitimately is not a `<Button>`. What
is wrong is a **one-off style**: if its class string appears nowhere else, it is a new button
design nobody agreed to. Report the ratio, then the one-offs.

**And check what the primitive gives you for free that the raw one lost.** Measured on `/leads`:
the raw motion-filter buttons had no `aria-pressed`. `<Button>` would not have fixed that by
itself, but the audit that found it started here.

---

## 4. Active and selected states — one vocabulary, not three

Measured on `/leads` before it was fixed: folder chips used `bg-paper + shadow-xs + border`,
motion filters used the same, and the team-view toggle used `bg-ink text-paper` — a solid black
pill. Three vocabularies in one region, so an active filter could not be found by scanning.

```bash
grep -hoE 'active \? "[^"]*"' $F | sort -u
```

More than one distinct active style in a screen is a finding. Name them and say which one the rest
of the app uses.

---

## 5. §20 responsive — and the false positive this check has already produced

§20 requires a table to have a card-list alternative, not to be hidden.

**⚠️ THE NAIVE CHECK IS WRONG. Do not grep for `md:hidden`.** On `/leads` the table is wrapped in
`hidden xl:block` and paired with an `xl:hidden` `<ul>` of `SwipeLeadCard`. That is §20 done
correctly, and a `md:hidden` check flags it as broken. A first run that cries wolf is worse than
no run.

**The correct check: for each `<table>`, find its hide breakpoint, then look for a sibling that
appears at that same breakpoint.**

```bash
grep -Hn "<table" $F        # then read 10 lines above each for its wrapper
grep -ho "hidden [a-z]*:block\|[a-z]*:hidden" $F | sort | uniq -c
```

A table wrapped at `xl` needs an `xl:hidden` counterpart. A table with **no** wrapper at all is the
real finding — measured: `import-csv-dialog.tsx:298` has a table with no responsive treatment, so
it horizontal-scrolls in a dialog on a phone.

Also from §20, each worth one line:
- primary action in the desktop header → is there a `<FAB>` for mobile? **Check for a written
  decision before reporting its absence.** `/leads` has no FAB and that is deliberate:
  `page.tsx:1745` says "NO FAB HERE, deliberately (removed 13 Aug 2026 at Pardeep's request)".
  This check reported it as a finding on its first run, which §8 of this skill already forbids.

  ```bash
  grep -rn "FAB" $F | grep -iE "no fab|deliberate|removed|on purpose"
  ```
- touch targets ≥ 44px on anything tappable
- sticky elements → `pb-[env(safe-area-inset-bottom)]`. **A count of zero is not a finding until you
  have checked the hazard exists.** On /leads the safe-area count is 0 and the screen is correct:
  every sticky in scope is `sticky top-*`, and the notch rule is about BOTTOM-anchored elements.
  The ones that are bottom-anchored live outside a screen's scope — `MobileBottomNav.tsx:111`,
  `bulk-action-bar.tsx:69`, `dialog.tsx:220`, `fab.tsx:88` — and all four already carry it.

  ```bash
  # Comment-strip FIRST (see §6) — every one of the 5 hits this returned on /leads was prose:
  # four comments explaining the sticky header, one JSDoc about the right rail. Third time
  # running this skill that a grep read documentation as code.
  node -e 'const fs=require("fs");for(const f of process.argv.slice(1)){fs.readFileSync(f,"utf8")
    .replace(/\/\*[\s\S]*?\*\//g,"").replace(/^\s*\/\/.*$/gm,"").split("\n")
    .forEach((l,i)=>{if(/sticky|fixed bottom|fixed inset-x/.test(l)&&!/top-/.test(l))console.log(f+":"+(i+1)+l);});}' $F
  ```

---

## 6. Spacing that fights itself

Two real bugs found this way on `/leads`, both from one mechanism:

`flex justify-between` distributes free space across the gaps. An `ml-auto` on the last child
absorbs **all** of it, so `justify-between` has none left — the first two children go flush and the
last one slams right. It was filed as two separate audit findings.

**⚠️ THIS CHECK HAS NOW PRODUCED FOUR FALSE POSITIVES, EACH FROM A DIFFERENT DEFECT.** Every one of
them said "bug" about correct code, and the first three were in the *tooling*, not the screen. Read
them before trusting any number this section prints.

1. **It read a COMMENT as code.** It matched `justify-between` and `ml-auto` inside the comment at
   `page.tsx:942` written to explain that *both had been removed*. A grep that reads prose as code
   flags every bug anybody documented.
2. **Stripping block comments SHIFTED EVERY LINE NUMBER AFTER THEM.** `.replace(/\/\*[\s\S]*?\*\//g, "")`
   deletes the newlines inside the comment too. Measured on `leads/page.tsx`: the first hit came
   back as line **454**; the real line is **773** — off by 319, pointing at unrelated code.
   Replace each comment with its own newlines instead of with nothing.
3. **`^\s*//` ATE 275 LINES.** `\s` matches `\n`, so `^\s*` chews backwards through every blank
   line above a comment. 4,166 lines became 3,891. Use `[ \t]*`.
4. **A fixed line window crossed into a NESTED flex.** `page.tsx:2886` was flagged for the
   `ml-auto` at `:2904` — but that sits inside `<div className="text-right flex-shrink-0">` opened
   at `:2900`, its own flex context and none of the outer row's business. Only DIRECT children
   matter, so walk by indentation rather than counting lines.

Write the corrected check to a FILE and run it as `node /tmp/spacing.js $F`. As a `node -e`
one-liner the backslashes get eaten — that has happened five times in this session, and a mangled
regex fails SILENTLY as "0 findings". Note `slice(2)`: in a script file `argv[1]` is the script
itself, and `slice(1)` reported the script as a source file, adding a phantom finding under /tmp.
With `node -e` it would be `slice(1)`.

```js
const fs = require("fs");
const strip = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))  // keep the newlines
  .replace(/^[ \t]*\/\/.*$/gm, "");                               // NOT \s* — see defect 3
const indent = (l) => l.match(/^[ \t]*/)[0].replace(/\t/g, "  ").length;

for (const f of process.argv.slice(2)) {
  const L = strip(fs.readFileSync(f, "utf8")).split("\n");
  L.forEach((l, i) => {
    if (!/justify-between/.test(l)) return;
    const base = indent(l);
    let childDepth = null;
    for (let j = i + 1; j < L.length; j++) {
      if (!L[j].trim()) continue;
      const d = indent(L[j]);
      if (d <= base) break;                    // the row has closed
      if (childDepth === null) childDepth = d;  // first line in = the direct-child level
      if (d !== childDepth) continue;           // deeper: a nested flex, not ours
      const m = L[j].match(/\b(ml-auto|mr-auto)\b/);
      if (m) console.log(f + ":" + (j + 1) + " direct child has " + m[1] + " (row opens " + (i + 1) + ")");
    }
  });
}
```

Measured on `/leads` with all four defects fixed: **29 `justify-between` rows, 0 real findings, 1
grandchild `ml-auto` correctly ignored. §6 is CLEAN** — but it also read CLEAN before any of this,
for the wrong reasons. A green light from a broken instrument is not a green light.

Measure gaps in the browser rather than reading them: `getBoundingClientRect()` on adjacent
children, and report the pixel numbers. Uneven gaps in one row are a finding.

---

## 7. Output shape

```
design-critique · /leads · 24 files

1. [major] Arbitrary font sizes — 153 uses of text-[Npx]
   app-wide: 2,305 · no fontSize scale in tailwind.config.ts
   fix: docs/TYPE-SCALE-PROPOSAL.md Option A. NOT the call sites.

2. [minor] Hardcoded colours — 12
   page.tsx:842 bg-black · lead-card.tsx:78 bg-rose-100 · (10 more)
   fix: bg-ink, bg-rose-soft — tokens exist in globals.css

CLEAN: active-state vocabulary · §20 table pairing · flex spacing
```

Ranked worst first. **Name what passed**, so the reader can tell a short report from a lazy one.

---

## 8. What this skill must not do

- **Not fix anything.** Report, then let a person choose. Today's type-scale finding has four open
  decisions that are not an engineer's to make.
- **Not invent a rule.** Every check above cites §5, §6, §8, §20, or a measured count. If the
  screen looks wrong and no rule covers it, say that in a sentence and propose the rule.
- **Not restyle toward a personal taste.** The amber accent, the serif for big numbers (§6), the
  flat folder chips whose counts must add up (`leads/page.tsx:851`) — those are decisions with
  reasons. Read the comment before calling something inconsistent.
