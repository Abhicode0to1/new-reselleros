#!/usr/bin/env node
/**
 * Refuses a commit that touches the "Billing & Subscriptions" part of ResellerOS.
 *
 * Owner instruction, 24 Sep 2026: that section "cannot be edited or touched by
 * our any edits … that part is being worked on by my colleague and can cause
 * massive conflict." This is the mechanical half of that rule; the written
 * half is AGENTS.md §13.
 *
 * Installed as THIS clone's local pre-commit hook (.git/hooks/pre-commit),
 * deliberately not committed as a shared hook: the colleague doing the work
 * must not be blocked by it. Run by hand: `node scripts/guard-billing-section.mjs`.
 *
 * Override only when the owner explicitly allows it for that commit:
 *   ALLOW_BILLING_SECTION_EDIT=1 git commit ...
 */
import { execFileSync } from "node:child_process";

const PROTECTED_DIRS = [
  "production/src/app/(app)/customers/",
  "production/src/app/(app)/quotes/",
  "production/src/app/(app)/subscriptions/",
  "production/src/app/(app)/renewals/",
  "production/src/app/(app)/invoices/",
  "production/src/app/(app)/payments/",
  "production/src/app/(app)/projects/",
  "production/src/components/features/customers/",
  "production/src/components/features/quotes/",
  "production/src/components/features/subscriptions/",
  "production/src/components/features/invoices/",
  "production/src/components/features/projects/",
  // Shared money logic behind those pages — blocked too (owner, 24 Sep 2026):
  // "block it for now. If need to edit, ask me and I will ask my colleague".
  "production/src/lib/quotes/",
  "production/src/lib/subscriptions/",
  "production/src/lib/invoices/",
  "production/src/lib/renewals/",
];

const NAV = "production/src/lib/nav.ts";

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** The menu block for the section, plus its "Billing" breadcrumb lines. */
function billingPartOfNav(src) {
  if (!src) return "";
  const text = src.replace(/\r\n/g, "\n");
  const start = text.indexOf('section: "Billing & Subscriptions"');
  let block = "";
  if (start !== -1) {
    const next = text.indexOf("section:", start + 10);
    block = text.slice(start, next === -1 ? undefined : next);
  }
  const crumbs = text.split("\n").filter((l) => /\[\s*"Billing"/.test(l)).join("\n");
  return `${block}\n${crumbs}`;
}

function show(ref) {
  try {
    return git(["show", ref]);
  } catch {
    return "";
  }
}

if (process.env.ALLOW_BILLING_SECTION_EDIT === "1") {
  console.warn("⚠️  ALLOW_BILLING_SECTION_EDIT=1 — Billing & Subscriptions guard skipped for this commit.");
  process.exit(0);
}

const staged = git(["diff", "--cached", "--name-only", "-z"]).split("\0").filter(Boolean);
const hits = staged.filter((f) => PROTECTED_DIRS.some((d) => f.startsWith(d)));

if (staged.includes(NAV) && billingPartOfNav(show(`HEAD:${NAV}`)) !== billingPartOfNav(show(`:${NAV}`))) {
  hits.push(`${NAV} (the "Billing & Subscriptions" menu block or its breadcrumbs)`);
}

if (hits.length) {
  console.error(
    [
      "",
      "❌ Commit refused: it touches ResellerOS's Billing & Subscriptions section.",
      "",
      "   Why: the owner has reserved this section for a colleague who is working on it,",
      "   and an edit from here would cause merge conflicts (AGENTS.md §13).",
      "",
      "   Files:",
      ...hits.map((h) => `     - ${h}`),
      "",
      "   What to do: unstage them (git restore --staged <file>) and ask the owner, who will",
      "   check with the colleague. Do not work round this by moving the code elsewhere.",
      "   If the owner has explicitly allowed this commit: ALLOW_BILLING_SECTION_EDIT=1 git commit ...",
      "",
    ].join("\n")
  );
  process.exit(1);
}
process.exit(0);
