/**
 * What the checkout pop-up says when an order or a trial cannot go ahead (1 Oct 2026,
 * Pawan: "this error looks flimsy — show a modal for such a significant event, and
 * give options how to solve it").
 *
 * Pure: the server's answer in, a title, a plain explanation and the buttons that fix it
 * out. The checkout page decides what each button does; this file only decides which
 * ones make sense, so every refusal offers a way forward and never a dead end.
 */

/** A button the pop-up can show. The checkout page wires each one. */
export type ProblemAction =
  | "buy-paid-plan"     // swap the trial in the cart for the paid plan, stay on checkout
  | "ask-more-time"     // email support for a longer trial
  | "edit-details"      // close and put the cursor in the field that needs changing
  | "register-domain"   // go and register a domain first
  | "retry"             // try the same thing again
  | "email-support"     // tell us; we finish it by hand
  | "back-to-cart";

export interface CheckoutProblem {
  tone: "error" | "warning";
  title: string;
  body: string;
  /** Short reassurance shown under the body, e.g. "Nothing was charged." */
  footnote?: string;
  /** First one is the main button. */
  actions: ProblemAction[];
  /** The field "edit-details" should focus. */
  field?: "email" | "domain" | "state";
  /** What the "edit-details" button says, when not "Change my details". */
  editLabel?: string;
}

/** What the checkout API answered with, besides `error`. */
export interface ProblemFlags {
  alreadyTrialled?: boolean;
  /** "1 Oct 2026", when the earlier trial began. */
  trialStartedOn?: string;
  needDomain?: boolean;
  needState?: boolean;
}

export function checkoutProblem(
  during: "trial" | "order" | "payment",
  message: string,
  flags: ProblemFlags = {},
  planName = "Starter",
): CheckoutProblem {
  if (flags.alreadyTrialled) {
    const when = flags.trialStartedOn ? ` on ${flags.trialStartedOn}` : "";
    return {
      tone: "warning",
      title: "You've already used your free trial",
      body:
        `We found an earlier free trial${when} for the same email, mobile number or domain. ` +
        `It's one free trial per customer, so we can't start another one.`,
      footnote: "Nothing was saved and nothing was charged.",
      actions: ["buy-paid-plan", "ask-more-time", "edit-details"],
      field: "email",
      editLabel: "Not me — check my details",
    };
  }
  if (flags.needDomain) {
    return {
      tone: "warning",
      title: "Which domain should we set up?",
      body:
        "Hosting is set up on a domain, like yourcompany.in. Type the one you own, " +
        "or register a new one first and come back.",
      footnote: "Nothing was saved.",
      actions: ["edit-details", "register-domain"],
      field: "domain",
      editLabel: "Enter my domain",
    };
  }
  if (flags.needState) {
    return {
      tone: "warning",
      title: "Please choose your state",
      body:
        "Your state decides whether the GST invoice shows CGST + SGST or IGST, " +
        "and we can't issue the invoice without it.",
      footnote: "Nothing was charged.",
      actions: ["edit-details"],
      field: "state",
      editLabel: "Choose my state",
    };
  }
  if (during === "payment") {
    return {
      tone: "error",
      title: "The payment didn't go through",
      body: message.replace(/^Payment failed:\s*/i, "") || "Your bank or UPI app declined it.",
      footnote:
        "If money left your account, it is refunded by your bank automatically, usually within 5–7 working days.",
      actions: ["retry", "email-support"],
    };
  }
  return {
    tone: "error",
    title: during === "trial" ? `We couldn't start your ${planName} trial` : "We couldn't place your order",
    body: message || "Something went wrong on our side.",
    actions: ["retry", "email-support", ...(during === "order" ? (["back-to-cart"] as const) : [])],
  };
}

/** The button text for each action. */
export function actionLabel(a: ProblemAction, p: Pick<CheckoutProblem, "editLabel"> = {}, paidPlanPrice?: string, planName = "Starter"): string {
  switch (a) {
    case "buy-paid-plan": return paidPlanPrice ? `Buy ${planName} — ${paidPlanPrice}` : `Buy ${planName} instead`;
    case "ask-more-time": return "Ask for more trial time";
    case "edit-details": return p.editLabel ?? "Change my details";
    case "register-domain": return "Register a domain";
    case "retry": return "Try again";
    case "email-support": return "Email support";
    case "back-to-cart": return "Back to cart";
  }
}
