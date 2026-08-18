/**
 * One-tap replies for the enquiry inbox.
 *
 * ─── WHY THESE ARE TEMPLATES AND NOT AN LLM CALL ────────────────────────────
 * "AI pills" in the brief. A model would produce a fresher sentence and would also
 * introduce a wait, a cost, a failure mode and — the one that matters — the chance of
 * inventing a price. These three replies are the three things a reseller actually types
 * twenty times a day, and none of them needs a model to write.
 *
 * What each pill DOES need is the enquiry's own facts, and those come from the tested
 * extractor: the sender's name, the product they asked about, the seat count. A pill that
 * says "Hi there, regarding your enquiry" is not worth a tap.
 *
 * ─── AND NOTHING IS EVER SENT BY THE PILL ITSELF ────────────────────────────
 * A pill fills the composer. The rep reads it and presses Send. One tap that both writes
 * and sends an email in the reseller's name is how a wrong name, a wrong seat count or a
 * half-finished sentence reaches a customer — and an email cannot be recalled.
 *
 * ─── NO PRICES ──────────────────────────────────────────────────────────────
 * Not one of these quotes a rupee figure, deliberately. Pricing has one home: the quote
 * builder, where the catalogue rate, the discount and the GST split are computed together.
 * A number typed into an email is a number nobody can reconcile against the invoice that
 * follows, and the customer will hold us to it.
 */

export type PillId = "quote" | "phone" | "call";

export interface PillContext {
  /** Sender's first name, when the extractor found one. */
  contactName?: string | null;
  /** The product they named, exactly as the catalogue spells it. */
  product?: string | null;
  /** Seats they asked for. */
  seats?: number | null;
  /** Whether the enquiry already carries a phone number. */
  hasPhone?: boolean;
  /** The reseller's own name, for the sign-off. */
  sellerName?: string | null;
}

export interface Pill {
  id: PillId;
  label: string;
  /** Why this pill is offered — shown as the button's title. */
  hint: string;
}

/**
 * First name only.
 *
 * "Dear Pardeep Sharma" reads like a form letter; "Hi Pardeep" reads like a person. Falls
 * back to no name at all rather than "Hi there" — a greeting that admits it does not know
 * you is worse than none.
 */
function firstName(full?: string | null): string {
  const n = (full ?? "").trim().split(/\s+/)[0] ?? "";
  return /^[A-Za-z][A-Za-z.'-]{1,}$/.test(n) ? n : "";
}

function greeting(ctx: PillContext): string {
  const n = firstName(ctx.contactName);
  return n ? `Hi ${n},` : "Hello,";
}

function signOff(ctx: PillContext): string {
  const s = (ctx.sellerName ?? "").trim();
  /* Same rule as lib/whatsapp.ts: no name beats the wrong name. */
  return s ? `\n\nBest regards,\n${s}` : "";
}

/** What they asked for, in their own terms — or nothing, never a guess. */
function whatTheyAskedFor(ctx: PillContext): string {
  const bits: string[] = [];
  if (ctx.seats) bits.push(`${ctx.seats} ${ctx.seats === 1 ? "user" : "users"}`);
  if (ctx.product) bits.push(`of ${ctx.product}`);
  return bits.join(" ");
}

/**
 * Which pills are worth offering for THIS enquiry.
 *
 * "Ask for phone number" is hidden when the enquiry already has one — a button that asks a
 * customer for something already on file makes the reseller look like they did not read
 * the email.
 */
export function pillsFor(ctx: PillContext): Pill[] {
  const pills: Pill[] = [
    {
      id: "quote",
      label: "Quote is on the way",
      hint: "Tells them the quote is coming, with what they asked for repeated back.",
    },
  ];
  if (!ctx.hasPhone) {
    pills.push({
      id: "phone",
      label: "Ask for phone number",
      hint: "No number on this enquiry — this asks for one so it can be called.",
    });
  }
  pills.push({
    id: "call",
    label: "Suggest a call",
    hint: "Offers two slots instead of asking an open question nobody answers.",
  });
  return pills;
}

/**
 * The draft this pill puts in the composer.
 *
 * Every line is a sentence a reseller would actually send — no placeholders in square
 * brackets, because a draft containing "[insert date]" is a draft that gets sent
 * containing "[insert date]".
 */
export function pillDraft(id: PillId, ctx: PillContext): string {
  const hi = greeting(ctx);
  const asked = whatTheyAskedFor(ctx);
  const end = signOff(ctx);

  switch (id) {
    case "quote":
      return `${hi}

Thank you for your enquiry${asked ? ` for ${asked}` : ""}. I am preparing the quotation now and will send it across shortly.

If the number of users changes before then, just reply here and I will adjust it.${end}`;

    case "phone":
      return `${hi}

Thank you for writing in${asked ? ` about ${asked}` : ""}. Could you share a phone number where I can reach you? A two-minute call is usually quicker than email for getting the setup details right.

If you would rather keep it on email, that is completely fine — just let me know.${end}`;

    case "call":
      /* Two concrete windows, not "let me know when suits". An open question is the most
         common way a warm enquiry goes quiet. Deliberately no exact dates: this module
         cannot know the reseller's calendar, and inventing one would put a commitment in
         their mouth. */
      return `${hi}

Thank you for your enquiry${asked ? ` for ${asked}` : ""}. Would a short call help? I can do tomorrow morning or tomorrow late afternoon — whichever is easier for you.

Please tell me which suits and I will call you then.${end}`;
  }
}

/** Subject line for the reply. Threading depends on it matching the original. */
export function replySubject(originalSubject?: string | null): string {
  const s = (originalSubject ?? "").trim();
  if (!s) return "Re: your enquiry";
  /* "Re: Re: Re:" is what happens when a client re-prefixes a subject that already has
     one, and it is the surest sign an inbox was built by somebody who never used it. */
  return /^re:\s*/i.test(s) ? s : `Re: ${s}`;
}
