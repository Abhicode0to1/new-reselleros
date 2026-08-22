/**
 * Which teammates can be the workspace's sending account.
 *
 * ─── THE GAP THIS FILLS ─────────────────────────────────────────────────────
 * `PATCH /api/integrations/email-provider` has always accepted a `gmailSenderUserId`, and
 * refuses one whose account is not connected or has not granted the send scope. The card
 * never sent that field, so the sender was whoever configured email FIRST — PATCH derives
 * it as `body.gmailSenderUserId || current || the caller's own id`.
 *
 * Reported on 22 Aug 2026: mail was leaving as pardeep@anutech.in and should leave as
 * sales@anutech.in. It could not be changed from any screen. The backend was ready; the
 * choice was simply not offered.
 *
 * ─── ELIGIBILITY IS READ FROM THE TOKEN, NEVER FROM THE ROLE ────────────────
 * A teammate can be an owner and still not be able to send, and a sales rep with a
 * connected account can. `lib/email/provider.ts` already refuses at send time for the same
 * three reasons; this list exists so the UI cannot offer a choice the server will reject.
 */
import { canSendWithScopes } from "./provider";

/** Why an account cannot be chosen. Null when it can. */
export type SenderBlocker = "not_connected" | "no_send_scope";

export interface SenderCandidateInput {
  userId: string;
  /** The workspace login. Shown when there is no Google address to show. */
  email: string | null;
  role: string | null;
  /** From `user_google_tokens`, or null when the account has never connected. */
  token: { google_email: string | null; refresh_token: string | null; scopes: string | null } | null;
}

export interface SenderCandidate {
  userId: string;
  /** The address mail would actually leave from — the GOOGLE one, not the login. */
  sendsAs: string | null;
  loginEmail: string | null;
  role: string | null;
  eligible: boolean;
  blocker: SenderBlocker | null;
}

export function classifySender(input: SenderCandidateInput): SenderCandidate {
  const base = {
    userId: input.userId,
    /* The Google address, because that is what the customer sees in From. A login of
       sales@anutech.in connected to a personal Gmail would send from the personal one, and
       showing the login here would hide that. */
    sendsAs: input.token?.google_email ?? null,
    loginEmail: input.email ?? null,
    role: input.role ?? null,
  };

  if (!input.token?.refresh_token) {
    return { ...base, eligible: false, blocker: "not_connected" };
  }
  if (!canSendWithScopes(input.token.scopes)) {
    /* Connected but the send permission was left unticked. A distinct blocker because the
       fix is different — reconnect, not connect — and telling someone to redo work they
       have already done is how they stop trusting the screen. */
    return { ...base, eligible: false, blocker: "no_send_scope" };
  }
  return { ...base, eligible: true, blocker: null };
}

/**
 * Everyone in the workspace, eligible first, so the picker opens on a usable choice.
 *
 * Ineligible teammates are RETURNED, not filtered out. "sales@anutech.in is not in the
 * list" and "sales@anutech.in has not connected Google" send the operator to completely
 * different places, and only the second is true here — hiding the row would have left
 * Pardeep looking for a bug in the picker.
 */
export function listSenderCandidates(inputs: readonly SenderCandidateInput[]): SenderCandidate[] {
  return inputs
    .map(classifySender)
    .sort((a, b) => {
      if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
      return (a.loginEmail ?? "").localeCompare(b.loginEmail ?? "");
    });
}

/** Human wording for a blocker, saying what to do rather than what is wrong (§24). */
export function blockerText(blocker: SenderBlocker): string {
  return blocker === "not_connected"
    ? "has not connected Google — they need to sign in and connect it themselves"
    : "connected Google but did not allow sending — they need to reconnect and leave “Send email on your behalf” ticked";
}
