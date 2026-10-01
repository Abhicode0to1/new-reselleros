# <Project name> — instructions for the AI (copy to the repo root)

Client: <client name> · Builder: Pardeep (+ this AI) · Client & demos: Pawan · Money: Hitesh · Delivery & support: Abhishek.
Team board: https://claude.ai/artifact/2E442MT5zCLxm2oE1Lipos — every card for this project carries `project: "<Project name>"`.

## How you work here
1. **One branch.** All code goes on `main` (or the one branch named here). Nobody else writes app code; never create parallel feature branches that live longer than a day.
2. **Start of every session:** read `docs/REQUIREMENTS.md`, `docs/MILESTONES.md`, the last 3 entries of `docs/PROGRESS.md`, and this project's open board cards. Tell Pardeep in ≤8 lines what is next.
3. **Every change:** code + test together; run the project's checks (typecheck, tests, lint) before saying done; open it on localhost and check it the way the client would use it — real-looking data, every number and date read like a business owner. Report what you verified and what you could not.
4. **End of every working day:** add one entry to `docs/PROGRESS.md` — done today (plain words), next, anything waiting on a person. Short enough to forward to the client.
5. **Scope:** if a request is not in `REQUIREMENTS.md`, write it there as "proposed", estimate it, and put a card for Pardeep (scope) + Hitesh (price). Don't build it before Pardeep says yes.

## What only a person does — ask, never do
- Talking to the client, price, invoices, discounts → card for Pawan / Hitesh.
- Any login (server, domain, payment gateway, the client's accounts), entering passwords / keys, deploying to live, touching the client's live data → card for Abhishek; you prepare the steps, he logs in and says yes.
- Never put passwords, keys or the client's personal data in code, docs, chat or the board.

## Testing
- Local / test environment only, with clearly fake data (names starting "AITEST", emails @example.test). Never the client's live system.

## Deploy
- One fixed day a week: <day, time IST>. Order: backup → database changes in order → app → check the live version → Abhishek runs the client's main flow once on live.
