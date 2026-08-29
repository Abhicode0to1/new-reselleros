---
name: layout-audit
description: Check whether a screen's information actually FITS and whether its order matches how the work is done — a table wider than its container, a sticky column covering its neighbour, a width defined in two places that have drifted, the most actionable column hidden behind a scroll, or an identity field that can be empty. Load alongside design-critique and accessibility-review before calling any UI work done. Those two check tokens, contrast and keyboard reach; none of them notices that the column carrying today's work is off-screen. Every check is measured in a running browser against REAL data — never from source, and never from an empty state.
---

# layout-audit

Written 29 Aug 2026, after a `/leads` redesign turned up five defects. **Four of the five were
invisible to `design-critique` and `accessibility-review`**, which had both been run. They check
whether the colours are tokens and whether a button can be reached by keyboard. They do not check
whether the thing is on the screen at all.

Every check below is a real bug from that day. None is a rule somebody thought sounded good.

---

## 0. TWO PRECONDITIONS. NEITHER IS OPTIONAL.

**0a. You must be looking at REAL data.**

That morning `/leads` was opened while logged out. Dev mode bypasses the middleware, so the page
rendered — header, toolbar, empty state, all of it. The table itself was not there. Thirty leads
exist; zero were visible. A redesign was about to be written for a screen that had been seen only
empty.

```js
document.querySelectorAll('tbody tr').length   // 0 = STOP. You are not looking at the screen.
```

If it is zero: get signed in, or say plainly that the review could not run. **Do not review a
layout from its empty state.** An empty state is a different design with a different job.

*(And if signing in needs a password: that is the user's to type, not yours. Ask, and wait.)*

**0b. Assert the path before every measurement.**

Borrowed from `design-critique` §0a, which learned it the hard way — three browser checks were once
taken on `/dashboard` while the report said `/leads`.

```js
if (location.pathname !== "/leads") return JSON.stringify({ ABORT: location.pathname });
```

---

## 1. Does it FIT? — the check nothing else makes

```js
const wrap = document.querySelector('table')?.parentElement;
({ needs: wrap.scrollWidth, has: wrap.clientWidth, overflow: wrap.scrollWidth - wrap.clientWidth })
```

Measured on `/leads`: **needs 1,414px, has 1,247px — 167px over.** Thirteen columns did not fit,
and there was a scrollbar, so nothing looked broken.

**Overflow alone is not the finding.** Horizontal scroll is a legitimate answer for a spreadsheet.
The finding is *what* is behind the scroll — see §3.

## 1a. Is EVERY column short, or just one?

This is the question that turns "it scrolls" into "it cannot fit". For each column, compare what it
has against what its own text needs:

```js
const ths = [...document.querySelectorAll('thead th')];
const rows = [...document.querySelectorAll('tbody tr')];
const measure = (el) => { const s = document.createElement('span');
  s.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font:' + getComputedStyle(el).font;
  s.textContent = (el.textContent || '').trim(); document.body.appendChild(s);
  const w = s.getBoundingClientRect().width; s.remove(); return w; };
ths.map((th, i) => ({
  col: (th.textContent || '').trim() || '(chk)',
  has: Math.round(th.getBoundingClientRect().width),
  needs: Math.ceil(Math.max(0, ...rows.map(r => r.children[i] ? measure(r.children[i]) : 0))) + 24,
})).filter(c => c.has < c.needs);
```

On `/leads`, **every content column** came back short — Company needed 366 and had 228, Value
needed 146 and had 70, and so on for nine of them. When the list is that long the fix is not to
nudge widths; it is **fewer columns**. Say that, and say which ones are duplicating something the
row already offers (Phone was there to be read, while `tel:` already sat in the row menu).

---

## 2. Does a sticky column cover its neighbour?

`position: sticky; right: 0` pins to the scroll container's edge. When the table is only slightly
wider than the container, the pinned column does not sit in its own slot — it sits **on top of the
one before it**.

```js
const ths = [...document.querySelectorAll('thead th')];
const B = e => e.getBoundingClientRect();
const last = ths[ths.length - 2], sticky = ths[ths.length - 1];
({ overlapPx: Math.round(B(last).right - B(sticky).left) })   // > 0 is a finding
```

Measured: **50px**. The Follow-up column's header read `FOLLC` and its dates read `28 Au(` —
looking like a truncation bug, caused by a stacking one. Any overlap above a rounding pixel or two
is real.

**The fix is upstream:** make the initial fit land inside the container so the pinned column reaches
its natural position. Leave a user's own dragged widths alone — scroll is theirs to ask for.

---

## 3. Is the most actionable column the one you cannot see?

Not a mechanical check. Look at what the screen is FOR, then find where that column sits.

`/leads` exists to answer "who do I call today". The answer lives in **Follow-up** — and Follow-up
was the column pushed off the right edge, then covered by the sticky menu. Everything decorative
was visible; the one thing the screen is for was not.

```js
const ths = [...document.querySelectorAll('thead th')];
const wrap = document.querySelector('table').parentElement;
ths.map(th => ({ col: (th.textContent||'').trim(),
  offscreen: Math.round(th.getBoundingClientRect().right - wrap.getBoundingClientRect().right) }))
  .filter(c => c.offscreen > 0);
```

Report any column past the edge **by name**, and say what it is for. "Three columns scroll" is a
count; "the follow-up date scrolls" is a finding.

---

## 4. Is one width defined in two places?

`table-fixed` reads widths from a `<colgroup>`. The `<th>`/`<td>` say what the columns ARE. Two
lists, one truth, and they drift silently: remove a `<th>` without removing its `<col>` and **every
later column wears its neighbour's width**.

That has now happened **three times** in `leads/page.tsx`. The third was mine, with the warning
against it written in the file I was editing.

```js
({ cols: document.querySelectorAll('colgroup col').length,
   ths:  document.querySelectorAll('thead th').length })   // must match
```

And check the pairing, because equal counts can still be misaligned:

```js
const row = document.querySelectorAll('tbody tr')[0];
[...document.querySelectorAll('thead th')].map((th, i) => ({
  header: (th.textContent||'').trim().slice(0,12),
  cell:   (row.children[i]?.textContent||'').trim().replace(/\s+/g,' ').slice(0,24) }));
```

**And add up the percentages.** `/leads` carried a comment reading "the total is kept at exactly
100%". It was **109%**, and `table-fixed` makes up the difference by widening the table — which was
the root of §1's 167px. A comment asserting a sum is not a sum.

---

## 5. Can the identity column be empty?

The first column tells the reader whose row this is. If the field behind it is ever blank, the row
loses its name — and that happens to real records, not test ones.

On `/leads` the identity was **Company**. `leads.company` is `NOT NULL`, which reads as safe and is
not: `NOT NULL` does not stop an empty string, and the enquiry-form path writes exactly that —
`company: (p.company ?? "").toString().trim()`. A lead arriving without a company got a blank
identity cell.

```sql
select count(*) filter (where coalesce(btrim(<field>),'') = '') as blank from <table>;
```

**Zero today does not clear it.** That count was 0 of 30 — because the 30 were demo rows. The
question is not "is it blank now" but "can the path that creates these rows leave it blank".

Two rules when it can:

- **Fall back, and say so.** Show the next-best field, styled differently, with a title explaining
  why. Quietly printing a contact's name in the Company column is a lie — that name goes on to be
  read as the company, and later onto a quote.
- **Check the form agrees.** `/leads` demanded `company` (min 2) and left `contact_name` optional,
  while its own inbound path created company-less leads. The app enforced one rule and broke it
  elsewhere. Whichever field is the identity, the form should require **that** one.

---

## 6. After any reorder, LOOK at it

Swapping two columns on `/leads` left every name rendering italic-and-muted: the style branched on
`source === "company"`, and company was no longer the primary. Types passed. 5,807 tests passed.
It was obvious in the first screenshot.

A reorder is not done until it has been seen. Screenshot, and read the rows.

---

## 7. Output shape

```
layout-audit · /leads · signed in · 8 rows visible

1. [major] Table does not fit — needs 1,414px, has 1,247 (167 over)
   and every content column is short of its own text: company 228/366,
   value 70/146, owner 109/171 (+6 more)
   → fewer columns, not narrower ones

2. [major] Sticky ⋯ column covers Follow-up by 50px
   header renders "FOLLC", dates render "28 Au("
   → fit the initial layout inside the container

3. [minor] colgroup says 100%, actually sums to 109%

CLEAN: colgroup/th pairing · identity field non-empty
```

Worst first. **Name what passed.**

---

## 8. What this skill must not do

- **Not restyle.** Colours, type and spacing belong to `design-critique`. If both want to change the
  same line, `design-critique` owns it.
- **Not decide which columns matter.** That is the operator's call. Measure what does not fit, say
  what is hidden, propose — and let them choose.
- **Not report a number it did not measure this run.** The two sibling skills both went stale within
  four days of being written, and both then pointed at problems somebody had already fixed. Every
  number here is dated for the same reason. Re-run the snippet.
