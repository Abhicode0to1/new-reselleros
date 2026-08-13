# Data reset — batches 1, 2, 5 only

**Batches 3 and 4 are deliberately NOT here.**

The source script marks them REAL: batch 3 is accounting and bank data
(bank_transactions carry real reconciliation), batch 4 is HR and payroll,
which is statutory. Deleting those is not a test-data reset, it is losing
records you are required to keep. They stay in the original file so that
running them has to be a decision somebody makes on purpose, not something
that happens because it was in the folder.

## Order

1. **Back up first.** `node scripts/backup-tenant-data.mjs` — it refuses to
   write inside the repo, so give it a path outside.
2. `batch-1.sql` — one editor run
3. `batch-2.sql` — one editor run
4. `batch-5.sql` — one editor run
5. `verify.sql` — a SEPARATE run

Never paste two batches into one run: the editor executes a script as one
transaction, so a failure in the second rolls back the first and the screen
shows an error nobody connects to "nothing was deleted".

## This is irreversible

There is no undo. The backup is the undo. Run step 1 even if you are sure —
especially if you are sure.
