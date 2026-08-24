import { describe, it, expect } from "vitest";
import { normaliseSupportEmail, parseFromAddress } from "./support-inbound";

/* ─────────────────────────────────────────────────────────────────────────────
   Normalising an inbound-parse payload for the support ingest.

   Every provider names these fields differently. The one that matters most is
   `messageId`: it is the idempotency key the route claims in `inbound_emails`, and the
   UNIQUE constraint on it is the only thing stopping a provider retry from answering the
   same customer twice.
   ───────────────────────────────────────────────────────────────────────────── */

describe("parsing the sender", () => {
  it("splits a display name from the address and lower-cases the address", () => {
    expect(parseFromAddress("Ravi Kumar <Ravi@Acme.IN>")).toEqual({
      name: "Ravi Kumar",
      email: "ravi@acme.in",
    });
  });

  it("handles a quoted display name", () => {
    expect(parseFromAddress('"Kumar, Ravi" <ravi@acme.in>').email).toBe("ravi@acme.in");
  });

  it("handles a bare address", () => {
    expect(parseFromAddress("ravi@acme.in")).toEqual({ name: "", email: "ravi@acme.in" });
  });

  it("returns an empty address rather than a guess when there is nothing to parse", () => {
    /* The route refuses an empty sender with a 400. A guessed address here would be worse
       than the refusal: the ticket would be answerable to nobody. */
    expect(parseFromAddress("Mail Delivery Subsystem").email).toBe("");
  });
});

describe("reading the fields each provider sends", () => {
  it("reads the Mailgun shape", () => {
    const p = normaliseSupportEmail({
      from: "Ravi <ravi@acme.in>",
      recipient: "support@anutech.in",
      subject: "Mail not syncing",
      "body-plain": "Outlook stopped syncing this morning.",
      "message-id": "mg-1",
    });
    expect(p.fromEmail).toBe("ravi@acme.in");
    expect(p.toAddress).toBe("support@anutech.in");
    expect(p.text).toBe("Outlook stopped syncing this morning.");
  });

  it("reads the Postmark shape", () => {
    const p = normaliseSupportEmail({
      From: "ravi@acme.in",
      OriginalRecipient: "support@anutech.in",
      Subject: "Storage full",
      TextBody: "My mailbox says it is full.",
      MessageID: "pm-1",
    });
    expect(p.fromEmail).toBe("ravi@acme.in");
    expect(p.subject).toBe("Storage full");
    expect(p.messageId).toBe("pm-1");
  });

  it("reads the SendGrid / generic shape", () => {
    const p = normaliseSupportEmail({
      from: "ravi@acme.in",
      to: "help@anutech.in",
      subject: "DNS help",
      text: "What MX records do I need?",
      messageId: "sg-1",
    });
    expect(p.toAddress).toBe("help@anutech.in");
    expect(p.messageId).toBe("sg-1");
  });

  it("prefers a real message id over the synthesised one", () => {
    const p = normaliseSupportEmail({
      from: "ravi@acme.in",
      subject: "x",
      text: "y",
      message_id: "real-id",
    });
    expect(p.messageId).toBe("real-id");
  });
});

describe("the synthesised message id", () => {
  it("is never empty, so the idempotency claim always has a key", () => {
    /* An empty key would make every retry look new, and the agent would answer the same
       customer repeatedly. */
    const p = normaliseSupportEmail({ from: "ravi@acme.in" });
    expect(p.messageId.length).toBeGreaterThan(0);
  });

  it("is the SAME for a genuine replay of one message", () => {
    const payload = { from: "ravi@acme.in", subject: "Mail down", text: "Since 9am." };
    expect(normaliseSupportEmail(payload).messageId).toBe(
      normaliseSupportEmail({ ...payload }).messageId,
    );
  });

  it("DIFFERS for two different messages under the same subject", () => {
    /* The body is in the key for exactly this. Without it, "Re: mail issue" sent twice by one
       customer with different content would collide, and the SECOND message — the one with
       the new information — would be silently dropped as a duplicate. Nobody finds out. */
    const a = normaliseSupportEmail({
      from: "ravi@acme.in",
      subject: "Re: mail issue",
      text: "I ran the check, it says SPF fails.",
    });
    const b = normaliseSupportEmail({
      from: "ravi@acme.in",
      subject: "Re: mail issue",
      text: "Actually now nobody in the office can send.",
    });
    expect(a.messageId).not.toBe(b.messageId);
  });

  it("stays inside the column's 200 characters even for a long body", () => {
    const p = normaliseSupportEmail({
      from: "ravi@acme.in",
      subject: "x".repeat(300),
      text: "y".repeat(3000),
    });
    expect(p.messageId.length).toBeLessThanOrEqual(200);
  });
});
