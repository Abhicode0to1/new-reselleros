# 0002 — Three owners, one board: tasks and changes as data, not chat

- **Status:** Accepted (recorded after the fact, 28 Sep 2026)
- **Date:** 2026-09-27 (commit `69d9aef1`, `docs/TEAM-PROTOCOL.md`)
- **Decided by:** Pardeep
- **Area:** shared

## Context

Three people (Pardeep, Abhishek, Pawan) each work with their own AI agent on their own
long-lived branch (`pardeep-sir`, `abhishek-pre-merge`, `pawan-api-system`). Requests
between areas travelled as text a human pasted from one chat into another, and the old
board kept its content inside its HTML, so agents could not read it and every edit
republished the page over someone else's change. Conflicts were found on deploy day.

## Decision

- **Ownership is data:** `OWNERS.json` maps path prefixes to an owner; anything unclaimed,
  and the listed shared paths (migrations, types, nav, layout, `package.json`, the
  rulebooks), is shared. `production/scripts/areas.mjs` says whose area a change touched.
- **The board is the shared memory** (claude.ai artifact, `ArtifactData` collections
  `tasks`, `changes`, `messages`). A request to another area is a `tasks` doc, never an edit
  in their code. A migration or changed contract is always a `changes` doc naming who it
  affects.
- Agents move tasks only to `doing` / `review`; **a human moves them to `done`**. Agents
  never deploy, apply production migrations, touch secrets/billing, or push to another
  person's branch.
- A nightly `integration-check` workflow merges the three branches in a runner and reports
  conflicts, so collisions surface daily instead of on deploy day.

## Consequences

- Every session starts by reading the board and ends by writing to it — a few minutes of
  overhead per session.
- Cross-area work is slower (request → owner) but no one's code changes under them.
- Shared files still conflict; the rule is "smallest change that works + a `changes` entry".
- CI's migration-order check (`scripts/migration-order-check.mjs`, S18) catches the
  specific three-branch hazard of a migration landing behind a newer one.

## Alternatives considered

- One shared branch — one agent alone once made 39 commits in a day (cloudbuild.yaml
  header); three on one branch means constant rebases and half-finished work mixed in.
- GitHub issues/PRs as the channel — the repo lives in a personal account with limited
  admin access (`docs/ACCESS.md`), and agents already had the board.
