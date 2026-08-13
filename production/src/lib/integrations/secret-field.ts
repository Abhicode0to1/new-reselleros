/**
 * What to do with a secret field a settings form just submitted.
 *
 * ─── THE BUG THIS EXISTS TO FIX ──────────────────────────────────────────────
 * The Razorpay dialog deliberately does not prefill secrets — it shows a mask, and
 * that is correct: a server that hands a live key secret back to the browser has
 * already lost. But the save route then wrote whatever the form sent:
 *
 *     razorpay_webhook_secret: v.webhook_secret ?? null
 *
 * So opening the dialog just to look at the mode, and pressing Save, wrote NULL
 * over the webhook secret. That lands the workspace in the exact state the money
 * health check calls critical: Razorpay keeps taking payments, its confirmation is
 * rejected because the signature can no longer be verified, and the app never
 * learns money arrived. Silent, and caused by a button that looked harmless.
 *
 * ─── THE RULE ────────────────────────────────────────────────────────────────
 * An untouched field means UNCHANGED, never "delete". Removing a secret has to be
 * asked for explicitly, with its own flag, because "I left a box empty" and "I want
 * this gone" are different intentions and only one of them is destructive.
 *
 * This is separated from the route so the decision is testable on its own. It is a
 * handful of branches, and every one of them either preserves or destroys a live
 * credential.
 */

export interface SecretFieldInput {
  /** What the form sent. `undefined`, `null` or blank all mean "not typed". */
  incoming: string | null | undefined;
  /** Is there already a stored value for this field? */
  hasExisting: boolean;
  /** Explicit "remove this credential" request — a separate control, not a blank box. */
  clear?: boolean;
  /** The integration cannot work without it. */
  required?: boolean;
  /** Reject anything shorter than this. Guards against a truncated paste. */
  minLength?: number;
  /** Field name, for the error message. */
  label?: string;
}

export type SecretFieldOutcome =
  /** Write this value. */
  | { action: "write"; value: string }
  /** Leave the stored value alone — omit the column from the update entirely. */
  | { action: "keep" }
  /** Explicitly remove it. */
  | { action: "clear" }
  /** Refuse the save and tell the user why. */
  | { action: "error"; reason: string };

export function resolveSecretField(input: SecretFieldInput): SecretFieldOutcome {
  const label = input.label ?? "This field";
  const typed = typeof input.incoming === "string" ? input.incoming.trim() : "";

  // An explicit clear wins, but not when the field is required — otherwise the UI
  // could ask for an integration to be broken and the server would oblige.
  if (input.clear) {
    if (input.required) {
      return { action: "error", reason: `${label} cannot be removed — the integration needs it.` };
    }
    return { action: "clear" };
  }

  if (typed.length === 0) {
    // The whole point. Nothing typed and something stored → do not touch it.
    if (input.hasExisting) return { action: "keep" };
    if (input.required) return { action: "error", reason: `${label} is required.` };
    // Nothing typed, nothing stored, not required — there is simply nothing to do.
    return { action: "keep" };
  }

  const min = input.minLength ?? 0;
  if (typed.length < min) {
    // A short value is far more often a truncated paste than a real short secret,
    // and writing it would break the integration while looking like a successful
    // save.
    return { action: "error", reason: `${label} looks too short (${typed.length} characters, expected at least ${min}).` };
  }

  return { action: "write", value: typed };
}

/**
 * Build the column patch for a set of secret fields.
 *
 * Returns only the columns that should actually change, so an untouched field is
 * absent from the update rather than present as null. `errors` is non-empty when
 * the save must be refused — callers must check it before writing anything.
 */
export function buildSecretPatch(
  fields: Record<string, SecretFieldInput>,
): { patch: Record<string, string | null>; errors: string[]; unchanged: string[] } {
  const patch: Record<string, string | null> = {};
  const errors: string[] = [];
  const unchanged: string[] = [];

  for (const [column, input] of Object.entries(fields)) {
    const outcome = resolveSecretField({ ...input, label: input.label ?? column });
    switch (outcome.action) {
      case "write": patch[column] = outcome.value; break;
      case "clear": patch[column] = null; break;
      case "keep":  unchanged.push(column); break;
      case "error": errors.push(outcome.reason); break;
    }
  }

  return { patch, errors, unchanged };
}
