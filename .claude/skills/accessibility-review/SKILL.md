---
name: accessibility-review
description: Check a screen against WCAG 2.1 AA and CLAUDE.md §8, using this app's own tokens and measured gaps — keyboard reach, focus visibility against the element's own background, aria-pressed on toggles, labels on icon-only buttons, contrast computed rather than eyeballed, and truncation that hides content. Load before calling any UI work done, and whenever CLAUDE.md §0.9's "design done" gate is invoked. Every check names a number or a file:line, and it says CLEAN when clean.
---

# accessibility-review

CLAUDE.md §0.9 requires this skill and it did not exist until 25 Aug 2026. §8 already sets the bar:

> "Every interactive element must be keyboard-accessible · Every image needs `alt` · Every form
> input needs a `<Label>` · Use semantic HTML (`<nav>`, `<main>`, `<button>` not `<div onClick>`) ·
> Color contrast WCAG 2.1 AA minimum"

> ⚠️ **29 Aug 2026: this file's `aria-pressed` counts had gone stale** (11 → 20 app-wide, 1 → 10 on
> `/leads`) because somebody fixed them. **Re-measure before reporting any number here.**
>
> Keyboard reach, focus visibility and contrast are this file's job. A control that is reachable and
> readable but sits in a column the user cannot see is a different defect — that is **`layout-audit`**.
> Run both.

**Compute, do not eyeball.** A contrast judgement made by looking is a judgement that changes with
the monitor. Every check below produces a number or a `file:line`.

**Say CLEAN when clean.** An accessibility report that always has twelve items gets filed and not
read, and then the real one is invisible.

---

## 0. Scope

Same as `design-critique`: the page **plus** the components only it uses.

```bash
cd production
P="src/app/(app)/<screen>/page.tsx"
L="src/components/features/<screen>"
F=$(echo "$P"; ls $L/*.tsx 2>/dev/null | grep -v "\.test\.")
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
## 0b. ⚠️ A LINE GREP LIES ABOUT JSX — read this before any check below

JSX attributes span lines. `<IconButton` on one line and `aria-label=` four lines down is normal,
and a `grep -v aria-label` on the opening line reports it as unlabelled.

**This produced two false positives on this skill's own first run** (25 Aug 2026): both
`<IconButton>`s on `/leads` were reported as missing labels, and both carried `aria-label` AND
`title` on following lines. §3 was CLEAN and the skill said otherwise.

So every attribute check below walks the ELEMENT, not the line:

```js
// node -e '…' $F  — reports element-level, not line-level
const fs = require("fs");
for (const f of process.argv.slice(1)) {
  const lines = fs.readFileSync(f, "utf8").split(/\r?\n/);
  lines.forEach((l, i) => {
    if (!/PATTERN_YOU_SEEK/.test(l)) return;
    let s = i; while (s > 0 && !/<[A-Za-z]/.test(lines[s])) s--;      // opening tag
    let e = i; while (e < lines.length - 1 && !/>/.test(lines[e])) e++; // closing bracket
    const el = lines.slice(s, e + 1).join(" ");
    if (!/ATTRIBUTE_THAT_WOULD_FIX_IT/.test(el)) console.log(`${f}:${i + 1}`);
  });
}
```

Verified: on `/leads` the line grep said 30 unlabelled `truncate`; the element walk says 28, with
3 labelled. Close enough to look right and wrong enough to matter.

---

## 1. Toggles without `aria-pressed` — the measured gap in this app

A button that holds an on/off state and does not say so reads to a screen reader as a plain
button. The user can press it and cannot tell it is now active.

⚠️ **Re-measured 29 Aug 2026, and the numbers had moved in the GOOD direction.** This said 11
app-wide and **one** on `/leads`. Today: **20** app-wide and **10** on `/leads`. The gap this
section was written about has largely been closed.

That does not retire the check, it changes what a finding looks like: zero on a screen is still a
finding; some-but-not-all is a question about which controls were missed. **Run the greps below.
Do not quote the numbers in this paragraph** — they are dated, and dating them is the point.

**⚠️ WIDE IS NOT THE SAME AS RIGHT, AND THIS SECTION HAS NOW ERRED BOTH WAYS.** The first version
said "under-reporting is the worse error", which is true, and it produced a detector that matched
any `className` holding a selection-shaped ternary. On /leads that returned **42 sites**, and
roughly half were `<span>`, `<td>`, `<th>`, `<p>` and `<li>` — status pills, table cells and
message rows that style themselves conditionally and are **not interactive**. The reported figure
of "19 missing `aria-pressed`" came from that pass and was wrong; the real count is **13**.

`aria-pressed` is only valid on a button role. On a `<span>` it does not fix anything — it asserts
the element is a toggle when it is text. So the detector stays wide, and then a HUMAN READ narrows
it, in this order:

1. **Is it interactive?** `<button>`, `<a>`, or `role="button"`. A conditional class on a `<span>`
   is a §6 colour-only question, not this one.
2. **Is the ternary a SELECTION, or something else?** Measured misses on /leads:
   `outcome-chips.tsx:40` matched on `size === "sm" ? …` — a sizing ternary on a one-shot action
   chip. `page.tsx`'s note button matched on enabled-vs-disabled styling. Neither holds a state,
   and `aria-pressed` on either announces something that does not exist.
3. **Then pick the right attribute, because it is not always `aria-pressed`:**
   - a toggle, or one of a single-select group → `aria-pressed`
   - a **current** item that is not pressable → `aria-current`. The /leads stage chips are this:
     the current stage is `disabled`, and disabled announces "unavailable", never "current".
   - a menu row where one is always in force → `role="menuitemradio"` + `aria-checked`. There is
     no `DropdownMenuRadioItem` in `components/ui/dropdown-menu.tsx`, so the role goes on the call
     site — and a test asserting `.closest("[role=menuitem]")` will break, which is the test being
     coupled to the role rather than the change being wrong.

```bash
grep -c "aria-pressed" $F | grep -v ":0"
grep -c "aria-current" $F | grep -v ":0"

# Every className that carries a ternary, whatever it tests — then read each one.
grep -nE 'className=\{cn\(|className=\{[^}]*\?' $F | wc -l

# The shapes that MEAN "selected" in this app's vocabulary.
grep -nE '\?\s*"[^"]*(bg-paper|bg-ink|bg-amber|shadow-xs|font-bold)' $F | head -20
```

Every element whose class string branches on an `active`/`selected` variable needs either
`aria-pressed` (a toggle) or `aria-current` (navigation). Report each `file:line` that branches and
has neither.

`components/shared/team-view-toggle.tsx` is the pattern to copy — it carries `aria-pressed`
correctly.

---

## 2. The focus ring against its OWN background

`<Button>` uses `focus-visible:ring-2 focus-visible:ring-amber`. An amber ring is invisible on an
amber fill.

```bash
grep -hoE 'ring-[a-z-]+' $F | sort | uniq -c
grep -n "bg-amber\|bg-amber-soft\|bg-ink" $F   # the surfaces where an amber ring disappears
```

For every focusable element sitting on `bg-amber`, `bg-amber-soft` or `bg-ink`, tab to it in the
browser and read the computed ring colour against the computed background. Report the pair. Keep
the ring but change its colour on those surfaces — never remove it.

**⚠️ `el.focus()` DOES NOT PAINT THE RING, AND THIS SKILL'S FIRST VERSION SAID TO USE IT.**

`:focus-visible` fires on *keyboard* modality. Programmatic `.focus()` does not set it, so
`boxShadow` comes back `none` — and on its first run this check reported **30 of 31 focusables as
having no visible ring**, every one of them a false positive. That is the single worst output an
accessibility skill can produce: 30 fabricated majors bury whatever was real.

**Send a REAL Tab through the browser tool**, not a synthetic KeyboardEvent (a dispatched event
does not change modality either):

```
computer · action: "key" · text: "Tab"        # repeat: N to walk the page
```

Then read the focused element:

```js
const el = document.activeElement, cs = getComputedStyle(el);
({ focusVisible: el.matches(':focus-visible'),          // must be TRUE or the test is invalid
   ring: (cs.boxShadow||'').match(/rgba?\([^)]+\)/g) })
```

**If `focusVisible` is false, the measurement is void — do not report it as a finding.**

Measured on `/leads` with a real Tab: the ring is two-tone —
`rgb(250,249,245)` inner halo then `rgb(200,73,9)` amber — giving **19.93:1** against its own
background. That inner halo is what keeps it visible on amber surfaces, so the failure this section
was written to catch does not currently exist here.

---

## 3. Icon-only buttons need a name

**51** `<IconButton>` uses app-wide — re-measured 29 Aug 2026, unchanged. Each renders a glyph and
nothing else, so without a label a screen reader announces "button".

```bash
grep -n "<IconButton" $F | grep -v "aria-label" 
grep -nE '<Button[^>]*icon=' $F | grep -v ">" | grep -v "aria-label"   # icon Button with no child text
```

`aria-label="Hide tips"` on the leads tips control is the shape. A label is a **verb about the
result**: "Hide tips", not "chevron up".

---

## 4. Truncated text hides content

`truncate` clips to an ellipsis. Whatever was clipped is gone — for everybody, and permanently for
a screen reader if the element has no accessible name carrying the full string.

Measured on the sidebar: 13 truncated nav labels, and before this was fixed only 9 carried a
`title`. One still clips by 14px ("Advances & Expenses" needs 145px in a 131px slot).

```bash
grep -n "truncate" $F | grep -v "title="
```

**⚠️ A `truncate` THAT NEVER CLIPS NEEDS NO TITLE, and the static grep cannot tell.** On `/leads`
the grep found 28 without a `title`; in the browser only **14 actually clip, and all 14 of those
carry one**. So the static count over-reports by 2x, and the section is CLEAN.

**Order matters: measure the clipping FIRST, then look for titles on that subset.** A finding
about a title on an element with room to spare is noise.

```js
[...document.querySelectorAll('.truncate')]
  .filter(e => e.scrollWidth > e.clientWidth + 1)
  .map(e => ({ text: e.textContent.trim(), short: e.scrollWidth - e.clientWidth, hasTitle: !!e.title }));
```

---

## 5. Contrast, computed from the tokens

**52** tokens in `globals.css` (was 48 — re-measured 29 Aug 2026), and both themes matter —
`:root` and the dark override.

Compute rather than judge. In the browser, on the real screen:

```js
const lum = (c) => { const [r,g,b] = c.match(/\d+/g).map(Number).map(v => { v/=255; return v<=0.03928 ? v/12.92 : ((v+0.055)/1.055)**2.4; }); return 0.2126*r + 0.7152*g + 0.0722*b; };
const ratio = (a,b) => { const [x,y] = [lum(a), lum(b)].sort((p,q)=>q-p); return ((x+0.05)/(y+0.05)).toFixed(2); };
// walk text nodes, compare colour against the nearest painted background
```

**AA: 4.5:1 for body text, 3:1 for text ≥18.66px bold or ≥24px, and 3:1 for UI boundaries.**

**⚠️ TWO THINGS THIS SECTION GOT WRONG ON ITS FIRST RUN.**

**One: it predicted the wrong failure.** It said `text-ink-3 on bg-paper-2` — every `<Fact>` label
and hint line — would fail. Measured on `/leads`: 164 text nodes, and that pair passes. A skill
that names the culprit in advance sends the reader looking in the wrong place.

**Two: the background walk must require OPACITY.** A naive walk stops at the first
`backgroundColor` that is not the literal string `rgba(0, 0, 0, 0)` — and a translucent one passes
that test, then parses as black, and every element comes back at **1.0:1**. That produced **119
fabricated failures**. Walk until `alpha >= 0.95`, fall back to `<html>`, and if nothing is opaque
**skip the element and report it as skipped** rather than inventing a number.

**What actually fails here, and it is the same finding as the type problem:** both failures on
`/leads` are at **9px** —

```
rgb(171,165,155) on rgb(243,241,236) · 9px · 2.17:1  ("Filter")
rgb(224,31,31)   on rgb(254,236,236) · 9px · 4.20:1  ("🔥 Hot")
```

The smallest text is also the lowest contrast, and `text-[9px]` has 47 uses app-wide with no rung
in any scale to hold it. Report the contrast, then point at `docs/TYPE-SCALE-PROPOSAL.md` — raising
9px to the scale's floor fixes both at once.

---

## 6. Meaning carried by colour alone

§20 anti-patterns and WCAG 1.4.1. A chip that is red for overdue and green for fine says nothing
to a colour-blind reader.

```bash
grep -nE 'tone|variant|kind' $F | grep -iE 'rose|emerald|amber|danger|success' | head
```

For each coloured state, check there is also a word, an icon, or a number. `components/ui/badge.tsx`
and `status-pill.tsx` are where the pattern is set — read them before flagging a call site.

---

## 7. Semantic HTML and keyboard reach

```bash
grep -n "onClick" $F | grep -E "<div|<span" | grep -v "role=\"button\""
grep -c "<main\|<nav\|<header" $F
grep -n "tabIndex=\"-1\"\|tabindex=\"-1\"" $F
```

A `<div onClick>` is not reachable by keyboard and not announced as actionable. `role="button"`
plus `tabIndex={0}` plus a key handler is the repair — or just use `<button>`, which is what §8
says.

**Then tab the screen in the browser** and record the order. A dialog that does not trap focus, or
a drawer that leaves focus behind it, is a finding no grep will find:

```js
document.activeElement.tagName + " · " + (document.activeElement.textContent||'').slice(0,30)
```

---

## 8. Output shape

```
accessibility-review · /leads · 24 files

1. [major] Toggles without aria-pressed — 6 of 7
   page.tsx:838 folder chips · page.tsx:1015 motion filters · (4 more)
   fix: aria-pressed={active}. team-view-toggle.tsx has the pattern.

2. [major] Focus ring invisible — 2
   the amber ring on bg-amber-soft (tips card actions), measured 1.4:1
   fix: ring-ink on that surface. Keep the ring.

3. [minor] Contrast — text-ink-3 on bg-paper-2 = 3.9:1, needs 4.5:1
   affects every <Fact> label on the screen

CLEAN: icon-button labels · truncation titles · semantic HTML · colour-only meaning
```

Worst first. **Name what passed.**

---

## 9. What this skill must not do

- **Not fix anything.** Report and let a person choose — a contrast fix can mean changing a token
  used in 273 files.
- **Not add `aria-*` to silence a check.** `aria-label` on a `<div onClick>` announces it and still
  leaves it unreachable by keyboard. Fix the element, not the announcement.
- **Not claim a browser check it did not run.** Focus visibility, tab order and contrast need the
  running app. If the dev server was not up, say which checks are static-only and which were
  skipped. "Reasoned-only" is an acceptable answer (CLAUDE.md §25.3); calling it verified is not.
