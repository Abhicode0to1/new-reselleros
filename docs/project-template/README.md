# New client project — template

Copy this folder into the root of a new client repo as `docs/` (and `CLAUDE.md` to the repo root) on day one. The AI fills the files; people only do the steps marked 👤.

**Day one:** the AI replaces `<Project name>`, `<client name>` and the deploy day in every file, then searches for `<` and fills or removes every leftover placeholder before the first commit. Keep the repo path short (e.g. `C:\work\<client>`): long Windows paths break `npm test`.

| File / folder | Filled by | When |
|---|---|---|
| `CLAUDE.md` (copy to repo root) | — | Day one; tells the project's AI how to work |
| `meeting-notes/<YYYY-MM-DD>-<what>.md` | 👤 Pawan pastes raw notes (any language, unedited); the AI never rewrites them | Every call and demo |
| `REQUIREMENTS.md` | AI, from the meeting notes | Step 1, updated after every call |
| `ESTIMATE.md` | AI draft → 👤 Pardeep (scope) + 👤 Hitesh (price, GST) | Step 2 |
| `signoff/` | 👤 Pawan — the client's written yes (quote, each milestone, go-live) as a screenshot / PDF | Steps 2, 4, 6 |
| `MILESTONES.md` | AI (dates, contents, acceptance from `signoff/`) → 👤 Hitesh (invoice no., paid) | Step 2 onwards |
| `CHANGES.md` | AI — every change request with effort and price | Step 4 onwards |
| `DEMO-<M#>.md` | AI — what Pawan shows and asks at each demo | Before each demo |
| `PROGRESS.md` | AI, one entry per working day (client part + internal part) | Step 3 onwards |
| `HANDOVER.md` | AI draft → 👤 Abhishek (logins, training) | Step 6 |
| `support/T-<nnn>-<slug>.md` | AI draft reply + triage → 👤 Abhishek sends | Step 7 |

The seven steps and who does what: `docs/TEAM-PROTOCOL.md` → "Team model" in the ResellerOS repo.
