# Team protocol — the team, their Claude sessions, one repo

*27 Sep 2026. For every Claude Code session (and any other agent) working in this repo.
Read it at the start of a session; it is short on purpose.*

The humans decide **what** and **whether**. The agents do the **how**, report back, and keep
each other informed through one shared place — the board — instead of through the humans.

## The board is the shared memory

**URL:** https://claude.ai/artifact/2E442MT5zCLxm2oE1Lipos (org-shared; each person needs
"can edit"). An agent reads and writes it with the `ArtifactData` tool against that URL.
Collections:

| collection | one doc = | key fields |
|---|---|---|
| `tasks` | one piece of work, id `R-nnn` (someone asked another area) or `Snn` (roadmap) | `plain` (one Hinglish line, max 90 chars: what the work achieves, no jargon — the card headline) · `kind` request/roadmap · `owner` pardeep/abhishek/pawan/hitesh/sab · `from` · `priority` p0–p3 · `bucket` · `title` · `why` · `fix` · `where` · `doneWhen` · `status` · `commits[]` · `dependsOn[]` · `outcome` · `statusNote` · `nextStep` · `waitingOn` · `humanStep` (the ONE thing only the owner can do — a login, a key, a yes; the board shows it instead of status buttons) · `humanStepDoneAt` (set by the owner pressing “✔ Maine kar diya”; the next Claude session picks the card up from there) · `updatedAt` |
| `changes` | one thing others must know (a migration, a changed RPC signature, a new env var, a data note) | `at` · `owner` (who changed it) · `title` · `body_html` · `affects[]` (owners) · `migrations[]` · `commit` · `acked{}` |
| `messages` | a chat message | `ch` general/requests/roadmap/deploy/accounting/billing/customer/qa · `text` · `by` · `at` |

**Statuses:** `open` → `doing` → `review` → `done` (or `blocked`, `declined`). An agent may move
a task to `doing` and to `review`. **Only a human moves it to `done`** (or `declined`), after
checking the `doneWhen` line.
*Exception (Pardeep, 29 Sep 2026):* a human may give their OWN Claude sessions standing
permission to set `done` on that human's cards once every part of `doneWhen` is verified. Pardeep
has. The session then writes `statusNote: "<date>: Claude ne Done kiya — <what was checked>"`.
It never covers another owner's card, anything waiting on deploy / a prod migration / another
person, or a fix on a page Hitesh reported (his retest still decides).

Ownership of code is in [`OWNERS.json`](../OWNERS.json) (repo root). `node production/scripts/areas.mjs`
tells you whose area a branch touched.

## Testing (Hitesh, QA) — 28 Sep 2026

Hitesh Baghel tests the app's user flows on the online **test** environment (never production)
and files what he finds. His guide is [`docs/qa/README.md`](qa/README.md); his area is
`production/e2e/` and `docs/qa/` on branch `hitesh-qa` — he does not change app code.

- A bug is an `R-nnn` request: `owner` = the area owner of that page, `from: "hitesh"`,
  title `Bug: …`, with URL, steps, expected, actual, screenshot.
- The owner's agent fixes it like any request and sets `review`. Hitesh retests on the test
  environment and posts `R-nnn retest pass` / `retest fail: …` in `#qa`. A human (Pardeep)
  then sets `done`. **A fix that touches a page Hitesh reported is not `done` without his retest.**
- Agents: when you move a `from: "hitesh"` task to `review`, say in `#qa` what to retest and where.

## Session start (every time, before any code)

1. Know who you work for: the branch → owner in `OWNERS.json` (`pardeep-sir` → pardeep, …).
2. `ArtifactData query tasks where owner in [me, "sab"] and status in [open, doing, review, blocked]`
   — list them to the human, P0 first, with any `review` ones they still need to check.
3. `ArtifactData query changes` for docs whose `affects` contains me and `acked` lacks me —
   summarise them in one line each. **These are other people's changes to things you use;
   read them before touching the same code.** Mark each read by merging `acked.<me>: <iso date>`.
4. Skim the last ~20 `messages` in `#general`, `#deploy` and your area channel.
5. `git fetch` and note whether the other two branches moved (`git log --oneline HEAD..origin/<branch> | wc -l`).

Say all of that to the human in ≤10 lines, then ask nothing — continue with what they asked,
or, if they asked "what next", propose the top unblocked task.

## While working

- **Claim** before you start: update the task to `status: "doing"` (pin `if_version`).
- Stay in your area. Need a change in someone else's area? **Do not make it.** Create a task:
  next free `R-nnn` (query the highest), `kind: "request"`, `owner` = the area owner, with
  `why`, `where` (file:line / RPC), `fix`, `doneWhen`. Then carry on with your own work.
- Shared files (`OWNERS.json` → `shared`: migrations, types, nav, layout, middleware…): change the
  smallest thing that works; it will need a `changes` entry.
- A migration is always a `changes` entry, with `affects` = every owner whose tables it touches.

## Session end (before the human leaves, or when a task is finished)

1. Gate: `npx tsc --noEmit`, `npx vitest run`, the SQL tests you touched. Report failures honestly.
2. `node scripts/areas.mjs` — if it names another person's area, stop and either cite the
   `R-nnn` that asked for it in the commit message or back the change out into a request.
3. Commit with the task id in the message (`S13: …`, `R-018: …`), push **to your own branch only**.
4. Board, in one `ArtifactData batch`:
   - the task → `status: "review"`, `commits: [sha…]`, `outcome` (what you did, what you did NOT
     do and why — the same honesty as the existing R-001…R-008 outcomes);
   - `nextStep`: one plain line, what happens next ("Deploy ke baad renewals cron 540s se kam")
     and `waitingOn`: who holds it now — a person key, `"deploy"`, or a task id (`"R-029"`).
     The board shows both on every card as **Agla kadam / Kiske paas** and sorts My work by them
     (karna hai / check karke Done / intezaar). Left out, the board guesses from status and note.
   - one `changes` doc if anything others must know;
   - one `messages` line in your area channel: `S13 → review (abc1234): RLS wrap on 212 policies`.

## What an agent never does on its own

Deploy · apply migrations to production · touch Cloud billing, secrets or OAuth clients ·
push to or merge another person's branch · mark a task `done` · delete board data.
These stay with the humans, however obvious they look.

## Every person's own morning digest (set up once, then nobody has to chase anyone)

Each of us runs a scheduled Claude task on our own machine that reads the board every
morning and tells **us** what is waiting — so no one has to message anyone to say "your card
is open". Set it up once in the Claude app: **Scheduled → New task**, schedule weekdays
09:30, folder = your checkout of this repo, and paste this prompt (change `<me>` to
`abhishek`, `pawan` or `hitesh`):

```
Morning digest for <me> on ResellerOS. READ AND REPORT ONLY: no code edits, no commits,
no pushes, no status changes, no messages. Reply in Hinglish.
Board: https://claude.ai/artifact/2E442MT5zCLxm2oE1Lipos (use the ArtifactData tool).
1. tasks where owner in [<me>, "sab"] and status in [open, doing, blocked, review]:
   list by priority (P0 first) with id, title and days since createdAt/statusAt.
2. tasks where from = <me> and status = review: these wait for MY check ("Done jab").
3. changes whose affects contains <me> and acked has no <me>: one line each.
4. messages from the last 24h in #general, #deploy and my area channel, and any @<Name>.
5. git fetch; how many commits pardeep-sir has that my branch does not
   (git log --oneline HEAD..origin/pardeep-sir | wc -l) — if > 0, say "merge karo".
Then suggest the one task I should pick first today. At most 15 lines.
```

Pardeep's own digest also prepares a short ready-to-send message for each person when
something of theirs is stuck, so a reminder costs one copy-paste, not a written message.

## Autonomy levels (what the human can hand over)

| level | the agent may | example |
|---|---|---|
| **A — report** | read the board + repo, summarise, propose | the daily digest |
| **B — draft** | work a task on its own branch, run the gate, push, set `review` | "S21 kar do" |
| **C — pick** | choose the next unblocked task of its owner by priority and do B | "roadmap se agla uthao" |

Level C is only for tasks with a testable `doneWhen` and no `dependsOn` still open, and only in
the owner's own area. Anything touching money calculations, GST, migrations or auth still ends
at `review`; a human reads it.

## Why it is built like this

Before 27 Sep, requests travelled as text a human pasted from one chat into another, and the
board's content lived inside its HTML — so the other two agents never saw it, and every edit
republished the whole page over whatever someone else had just changed. Tasks and changes are
now **data**: any session can query "what is mine" and "what changed that touches me", and
writes are per document, so three agents cannot overwrite each other.
