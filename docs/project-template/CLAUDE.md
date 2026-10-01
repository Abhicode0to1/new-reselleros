# <Project name> — instructions for the AI (copy to the repo root)

Client: <client name> · Builder: Pardeep (+ this AI) · Client & demos: Pawan · Money: Hitesh · Delivery & support: Abhishek.
Repo lives at: <short path>. Team board: https://claude.ai/artifact/2E442MT5zCLxm2oE1Lipos — every card for this project carries `project: "<Project name>"`.

## How you work here
1. **One branch.** All code goes on `main` (or the one branch named here). Nobody else writes app code; never keep parallel feature branches longer than a day.
2. **Start of every session:** read `docs/REQUIREMENTS.md`, `docs/MILESTONES.md`, `docs/CHANGES.md`, the last 3 entries of `docs/PROGRESS.md`, and any `docs/meeting-notes/` file newer than the last REQUIREMENTS update — turn new notes into REQUIREMENTS / CHANGES first. Then tell Pardeep in ≤8 lines what is next.
3. **Every change:** code + test together; run the project's checks (typecheck, tests, lint) before saying done; run it the way the client will use it (web page on localhost, CLI, or phone emulator) with real-looking data, and read every number and date like the business owner. Report what you verified and what you could not.
4. **End of every working day:** one entry in `docs/PROGRESS.md`, written in the client's language (from REQUIREMENTS → "The client"), without requirement IDs in the client part; internal notes go under "Internal (don't forward)".
5. **Scope:** anything not `agreed` in REQUIREMENTS goes into `docs/CHANGES.md` as a row with effort; a card for Pardeep (scope) and Hitesh (price). It becomes `agreed` only when the row has Pardeep's yes, Hitesh's price and the client's yes (file in `docs/signoff/`). Don't build it before then.
6. **Milestone accepted:** when Pawan saves the client's written yes in `docs/signoff/`, tick "Client accepted" in MILESTONES with the date + file name and open an "Invoice M#" card for Hitesh. Never tick "Paid".

## Board cards for this project (and nothing else)
- 👤 Pawan: open questions for the client (one card, as a list), each demo ("Demo M1 Fri — get the yes"), each sign-off to upload.
- 👤 Hitesh: price the estimate; price each change request; "Invoice M#" after acceptance; payment follow-up.
- 👤 Abhishek: each deploy day; each login needed; each support reply to send.
- 🤖 AI line: what is being built now (milestone + requirement IDs). Daily progress text stays in PROGRESS.md, not on the board.

## What only a person does — ask, never do
- Talking to the client, price, invoices, discounts → card for Pawan / Hitesh.
- Any login (server, domain, payment gateway, the client's accounts), entering passwords / keys, deploying to live, touching the client's live data → card for Abhishek; you prepare the steps, he logs in and says yes.
- Never put passwords, keys or the client's personal data in code, docs, chat or the board.

## Testing
- Local / test environment only, with clearly fake data (names starting "AITEST", emails @example.test). Never the client's live system.

## Deploy
- One fixed day a week: <day, time IST>. Order: backup → database changes in order → app → check the live version → Abhishek runs the client's main flow once on live.
