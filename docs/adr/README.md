# Architecture Decision Records

One file per decision that is expensive to reverse or that a newcomer would otherwise
re-argue: where the database lives, how three people coordinate, what may never be edited.
Not for everyday code choices — those belong in the code and its tests.

## How

1. Copy [`0000-template.md`](0000-template.md) to `NNNN-short-title.md` (next free number;
   numbers are never reused).
2. Status starts as **Proposed**. It becomes **Accepted** when the owner of the area
   (OWNERS.json) agrees — for shared or infra decisions, Pardeep.
3. An accepted ADR is not rewritten when the decision changes. Write a new ADR that
   **supersedes** it and set the old one's status to `Superseded by NNNN`. The history of
   why is the point.
4. Keep it to one screen. Link the migration, commit, incident or doc that proves a claim
   instead of repeating it.

## Index

| # | Decision | Status |
|---|---|---|
| [0001](0001-database-on-cloud-sql.md) | Production database on Cloud SQL behind a self-hosted Supabase data plane | Accepted |
| [0002](0002-team-protocol-board.md) | Three owners, one board: tasks and changes as data, not chat | Accepted |
| [0003](0003-books-lock.md) | Books lock: closed periods are enforced by a database trigger | Accepted |

## Comment convention (S25, 28 Sep 2026)

This repo's comments grew into long incident diaries — useful once, then noise on every
later read. From now on, for NEW comments:

- **A comment says WHY, in short plain English.** One to three lines. What the code does
  is the code's job; a comment explains the reason a reader would otherwise "fix" away:
  a trap, a constraint, a number that looks wrong but is right.
- **The story goes in an ADR or the commit message, not the code.** Dates, measurements,
  "on 26 Aug we found…", tables of timings — write them once in `docs/adr/` (a decision) or
  the commit body (a fix), and leave a one-line pointer: `// Why: see docs/adr/0003.`
- **Warn only where a mistake is expensive** — money, tenant isolation, auth, deploy.
  Prefix `⚠️` sparingly; if everything is a warning, nothing is.
- **Name the test that proves it** when a comment states a guarantee
  (`// Proved by books_lock.test.sql`). A guarantee nobody tests is a wish.
- **Delete a comment that is no longer true** in the same change that makes it untrue.
- Language: English for code comments, so all three teams and every agent read the same
  thing. Hinglish is fine in docs meant for Pardeep, UI copy and error messages
  (CLAUDE.md §24).

Existing long comments are **not** being rewritten wholesale — that would be a huge diff in
everyone's files. Shorten one when you are already changing the code around it.
