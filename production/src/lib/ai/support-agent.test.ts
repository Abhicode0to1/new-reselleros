import { describe, it, expect } from "vitest";
import {
  applyEscalationRules,
  asksForCredentials,
  buildSupportAgentPrompt,
  categoryForTopic,
  looksLikeOutage,
  maskSupportIdioms,
  MIN_AUTONOMOUS_CONFIDENCE,
  MAX_CONTEXT_TURNS,
  parseSupportDecision,
  priorityForSeverity,
  resolutionStatusFor,
  verifyNoInventedRecords,
  type AuthorisedRecord,
  type SupportCustomerFacts,
  type SupportDecision,
  type SupportSubscriptionFact,
  type SupportTurn,
} from "./support-agent";

/* ─────────────────────────────────────────────────────────────────────────────
   The AI support agent's reasoning layer.

   The stakes here are different from the sales agent's, and the tests are weighted to
   match. A wrong price is embarrassing and a credit note fixes it. A wrong MX record
   stops a business receiving mail — on our written instruction, silently, until one of
   their own customers tells them. So the record guard, the credential guard and the
   outage backstop get the most cases.
   ───────────────────────────────────────────────────────────────────────────── */

const SUB: SupportSubscriptionFact = {
  plan: "Google Workspace Business Standard",
  vendor: "google",
  domain: "acme.in",
  seats: 15,
  used: 12,
  status: "active",
  renewalDate: "2026-09-14",
  mrr: 12960,
};

function customer(over: Partial<SupportCustomerFacts> = {}): SupportCustomerFacts {
  return {
    ticketId: "TKT-ABC-01",
    customerName: "Acme Traders",
    customerContact: "ravi@acme.in",
    channel: "email",
    customerId: "cus-1",
    subscriptions: [SUB],
    tier: "standard",
    ...over,
  };
}

function decision(over: Partial<SupportDecision> = {}): SupportDecision {
  return {
    issue_category: "mail_client_sync",
    severity_level: "MEDIUM",
    resolution_found: true,
    action_required: "AUTO_REPLY_AND_RESOLVE",
    confidence_score: 0.9,
    generated_response: {
      email_subject: "Re: Outlook keeps asking for the password",
      body_text:
        "Hello Ravi,\n\nThis usually happens when 2-Step Verification is on: Outlook needs an " +
        "app password rather than the account password. Your admin can generate one from the " +
        "Google Admin console under Users.\n\nRegards,\nANUTECH DIGITAL PVT LTD",
      whatsapp_summary:
        "With 2-Step Verification on, Outlook needs an app password, not the account password. " +
        "Your admin can generate one in the Google Admin console under Users.",
    },
    missing_information: null,
    ...over,
  };
}

function escalationInput(
  d: SupportDecision,
  over: {
    incoming?: string;
    allowedMoney?: number[];
    authorisedRecords?: AuthorisedRecord[];
    allowedDates?: string[];
  } = {},
) {
  return {
    decision: d,
    incoming: over.incoming ?? "Outlook keeps asking me for my password again and again.",
    allowedMoney: over.allowedMoney ?? [SUB.mrr],
    authorisedRecords: over.authorisedRecords ?? [],
    /* The customer's own renewal date, exactly as the prompt would have carried it. */
    allowedDates: over.allowedDates ?? [SUB.renewalDate ?? ""],
  };
}

/* ═══ The prompt ═══════════════════════════════════════════════════════════ */

describe("building the prompt", () => {
  it("puts the customer's own subscription facts in, so the agent can state them", () => {
    const p = buildSupportAgentPrompt({
      customer: customer(),
      history: [],
      incoming: "When does my plan renew?",
      sellerName: "ANUTECH DIGITAL PVT LTD",
      supportEmail: "support@anutech.in",
    });

    expect(p.user).toContain("Google Workspace Business Standard");
    expect(p.user).toContain("15 seat(s)");
    expect(p.user).toContain("12 in use");
    expect(p.user).toContain("renews 2026-09-14");
    /* The whole point of matching the customer: this figure is what makes the agent able to
       answer a billing question at all, and it is the ONLY money it may name. */
    expect(p.allowedMoney).toEqual([12960]);
  });

  it("tells the agent plainly when the sender matches nobody, and authorises no money", () => {
    /* The leak this prevents: answering a stranger with somebody else's plan and renewal
       date because their address looked close enough. */
    const p = buildSupportAgentPrompt({
      customer: customer({ customerId: null, subscriptions: [] }),
      history: [],
      incoming: "hi, is this the Google support desk?",
      sellerName: "ANUTECH DIGITAL PVT LTD",
      supportEmail: "support@anutech.in",
    });

    expect(p.user).toContain("does not match any customer in our records");
    expect(p.user).toContain("do not state any account facts");
    expect(p.allowedMoney).toEqual([]);
  });

  it("says NO RECORD VALUES when none are authorised — which is every case today", () => {
    const p = buildSupportAgentPrompt({
      customer: customer(),
      history: [],
      incoming: "what MX records do I need?",
      sellerName: "A",
      supportEmail: "support@anutech.in",
    });
    expect(p.user).toContain("you may not state any DNS record");
    expect(p.authorisedRecords).toEqual([]);
  });

  it("keeps the LAST turns of a long thread, not the first", () => {
    /* Ordering ascending with a limit would hand the model the opening of a long thread and
       hide the part that matters — which on a support ticket is the check the customer just
       ran. */
    const history: SupportTurn[] = Array.from({ length: MAX_CONTEXT_TURNS + 6 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "agent",
      content: `turn-${i}`,
      channel: "email",
    }));

    const p = buildSupportAgentPrompt({
      customer: customer(),
      history,
      incoming: "still broken",
      sellerName: "A",
      supportEmail: "support@anutech.in",
    });

    expect(p.user).toContain(`turn-${MAX_CONTEXT_TURNS + 5}`);
    expect(p.user).not.toContain("turn-0\n");
  });

  it("the knowledge base tells the agent where the values are, not what they are", () => {
    /* A runbook containing an MX host is correct until the vendor changes it and nobody here
       finds out. Google moved from five ASPMX hosts to one; this assertion is what stops
       somebody "helpfully" pasting the current set into the prompt. */
    const p = buildSupportAgentPrompt({
      customer: customer(),
      history: [],
      incoming: "mx setup",
      sellerName: "A",
      supportEmail: "support@anutech.in",
    });
    expect(p.system).toContain("Activate Gmail");
    expect(p.system).not.toMatch(/aspmx|smtp\.google\.com|mail\.protection\.outlook\.com/i);
  });
});

/* ═══ Parsing ══════════════════════════════════════════════════════════════ */

describe("parsing what the model returned", () => {
  const raw = {
    issue_category: "dns_records",
    severity_level: "MEDIUM",
    resolution_found: true,
    action_required: "AUTO_REPLY_AND_RESOLVE",
    confidence_score: 0.82,
    generated_response: { email_subject: "s", body_text: "b", whatsapp_summary: "w" },
    missing_information: null,
  };

  it("accepts a well-formed decision", () => {
    const r = parseSupportDecision(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.decision.issue_category).toBe("dns_records");
  });

  it("clamps a confidence the model overshot", () => {
    const r = parseSupportDecision({ ...raw, confidence_score: 1.4 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.decision.confidence_score).toBe(1);
  });

  it("REJECTS a category we did not define rather than rounding it to `other`", () => {
    /* A category outside the contract means the model ignored the contract, and the rest of
       its answer deserves the same suspicion. Coercing to `other` would let a decision
       through whose action and severity nothing has vouched for. */
    const r = parseSupportDecision({ ...raw, issue_category: "printer_on_fire" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("issue_category");
  });

  it("names the missing field in a sentence a non-engineer can act on", () => {
    const r = parseSupportDecision({
      ...raw,
      generated_response: { email_subject: "s", body_text: "", whatsapp_summary: "w" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("generated_response.body_text");
  });
});

/* ═══ The record guard — the one this file exists for ══════════════════════ */

describe("refusing invented record values", () => {
  it("catches a Google mail host", () => {
    const r = verifyNoInventedRecords("Add an MX record pointing to aspmx.l.google.com", []);
    expect(r.ok).toBe(false);
    expect(r.violations).toContain("aspmx.l.google.com");
  });

  it("catches the newer single-host form too", () => {
    expect(verifyNoInventedRecords("point MX at smtp.google.com", []).ok).toBe(false);
  });

  it("catches a Microsoft 365 host derived from the customer's domain", () => {
    expect(
      verifyNoInventedRecords("MX: acme-in.mail.protection.outlook.com", []).ok,
    ).toBe(false);
  });

  it("catches a Zoho host in any region", () => {
    expect(verifyNoInventedRecords("use mx.zoho.in", []).ok).toBe(false);
    expect(verifyNoInventedRecords("use mx.zoho.com", []).ok).toBe(false);
  });

  it("catches an SPF record and a bare include", () => {
    expect(verifyNoInventedRecords("publish v=spf1 include:_spf.google.com ~all", []).ok).toBe(false);
    expect(verifyNoInventedRecords("just add include:zoho.in to it", []).ok).toBe(false);
  });

  it("catches DKIM and DMARC bodies", () => {
    expect(verifyNoInventedRecords("v=DKIM1; k=rsa; p=MIGf...", []).ok).toBe(false);
    expect(verifyNoInventedRecords("set v=DMARC1; p=none; rua=mailto:x@y.in", []).ok).toBe(false);
  });

  it("catches a mail-client port instruction", () => {
    expect(verifyNoInventedRecords("IMAP, SSL, port 993", []).ok).toBe(false);
    expect(verifyNoInventedRecords("SMTP on port: 587", []).ok).toBe(false);
  });

  it("ALLOWS the answer we actually want — a console path", () => {
    /* If this ever fails, the guard has started firing on the correct answer, and a guard
       that fires on the correct answer gets switched off. */
    const good =
      "Open the Google Admin console → Account → Domains → Manage domains → Activate Gmail. " +
      "That page shows the exact MX records for your domain; copy them from there into your " +
      "DNS host. Note that only one SPF TXT record may exist per domain.";
    expect(verifyNoInventedRecords(good, []).ok).toBe(true);
  });

  it("allows a value that WAS authorised, verbatim", () => {
    const authorised: AuthorisedRecord[] = [{ type: "MX", value: "smtp.google.com" }];
    expect(verifyNoInventedRecords("point MX at smtp.google.com", authorised).ok).toBe(true);
  });

  it("still refuses a NEAR-match of an authorised value", () => {
    /* aspmx2 and aspmx are different hosts. A fuzzy match here would defeat the entire guard:
       publishing the wrong one of those breaks mail just as thoroughly as nonsense. */
    const authorised: AuthorisedRecord[] = [{ type: "MX", value: "aspmx.l.google.com" }];
    const r = verifyNoInventedRecords("point MX at aspmx2.l.google.com", authorised);
    expect(r.ok).toBe(false);
    expect(r.violations).toContain("aspmx2.l.google.com");
  });

  it("reports one violation per distinct value, not one per mention", () => {
    const r = verifyNoInventedRecords(
      "use mx.zoho.in — again, mx.zoho.in — and mx.zoho.in",
      [],
    );
    expect(r.violations).toEqual(["mx.zoho.in"]);
  });
});

/* ═══ The credential guard ═════════════════════════════════════════════════ */

describe("refusing to ask for a secret", () => {
  it("catches a plain request for a password", () => {
    expect(asksForCredentials("Please share your password so we can check.")).toBe(true);
  });

  it("catches a request for an OTP or a 2FA code", () => {
    expect(asksForCredentials("Reply with the OTP you received.")).toBe(true);
    expect(asksForCredentials("Can you send the verification code?")).toBe(true);
  });

  it("catches a request for an API key", () => {
    expect(asksForCredentials("Please provide your API key and we will configure it.")).toBe(true);
  });

  it("does NOT fire on legitimate reset instructions", () => {
    /* "your password" appears in every correct answer about a reset. A keyword match would
       hold the right answer, and the guard would be deleted within a week. */
    expect(
      asksForCredentials(
        "Your administrator can reset your password from the Admin console under Users. " +
          "You will be asked to set a new password at the next sign-in.",
      ),
    ).toBe(false);
  });

  it("does NOT fire on asking for the ERROR MESSAGE, which the runbook requires", () => {
    expect(asksForCredentials("Could you send the exact error message Outlook shows?")).toBe(false);
  });
});

/* ═══ The outage backstop ══════════════════════════════════════════════════ */

describe("recognising an outage from the customer's own words", () => {
  it("catches a calmly-described whole-office failure", () => {
    /* The case that costs something: an outage described without panic, read as MEDIUM, and
       answered with a troubleshooting checklist while fifteen people cannot work. */
    expect(looksLikeOutage("Since this morning nobody in the office is receiving mail.")).toBe(true);
  });

  it("catches 'all users' and 'the entire domain'", () => {
    expect(looksLikeOutage("All users are affected.")).toBe(true);
    expect(looksLikeOutage("The entire domain has the problem.")).toBe(true);
  });

  it("catches a service stated as down", () => {
    expect(looksLikeOutage("Our email is completely down.")).toBe(true);
    expect(looksLikeOutage("Nothing is working.")).toBe(true);
  });

  it("does NOT fire on one user with one fault", () => {
    /* Escalating every individual fault would empty the feature out — the agent exists to
       answer exactly these. */
    expect(looksLikeOutage("I cannot send mail from my laptop since yesterday.")).toBe(false);
    expect(looksLikeOutage("My Outlook keeps asking for a password.")).toBe(false);
  });
});

/* ═══ The escalation rules ═════════════════════════════════════════════════ */

describe("the happy path", () => {
  it("lets a confident, well-guarded answer through untouched", () => {
    const r = applyEscalationRules(escalationInput(decision()));
    expect(r.overruled).toBe(false);
    expect(r.decision.action_required).toBe("AUTO_REPLY_AND_RESOLVE");
    expect(r.reason).toBe("");
  });

  it("lets a request for more information through", () => {
    const r = applyEscalationRules(
      escalationInput(
        decision({
          action_required: "REQUEST_MORE_INFO",
          resolution_found: false,
          missing_information: "which mail client, and the exact error text",
        }),
      ),
    );
    expect(r.overruled).toBe(false);
    expect(r.decision.action_required).toBe("REQUEST_MORE_INFO");
  });
});

describe("severity and the outage backstop", () => {
  it("overrules a MEDIUM read when the customer described an outage, and raises it to CRITICAL", () => {
    const r = applyEscalationRules(
      escalationInput(decision({ severity_level: "MEDIUM" }), {
        incoming: "Since 9am nobody in the office is receiving mail. Please help urgently.",
      }),
    );
    expect(r.overruled).toBe(true);
    expect(r.decision.action_required).toBe("ESCALATE_TO_HUMAN");
    expect(r.decision.severity_level).toBe("CRITICAL");
    expect(r.reason).toContain("outage");
  });

  it("raises severity even when the model ALREADY chose to escalate", () => {
    /* Severity is what decides whether this is looked at now or after lunch, so the backstop
       has to run even on a decision that needed no action change. */
    const r = applyEscalationRules(
      escalationInput(
        decision({ action_required: "ESCALATE_TO_HUMAN", severity_level: "LOW" }),
        { incoming: "All users are unable to log in." },
      ),
    );
    expect(r.decision.severity_level).toBe("CRITICAL");
  });

  it("never lets a CRITICAL be answered automatically", () => {
    const r = applyEscalationRules(escalationInput(decision({ severity_level: "CRITICAL" })));
    expect(r.overruled).toBe(true);
    expect(r.decision.action_required).toBe("ESCALATE_TO_HUMAN");
  });

  it("leaves a CRITICAL escalation the model chose itself alone", () => {
    const r = applyEscalationRules(
      escalationInput(
        decision({ severity_level: "CRITICAL", action_required: "ESCALATE_TO_HUMAN" }),
        { incoming: "our mail server is unreachable" },
      ),
    );
    expect(r.overruled).toBe(false);
  });
});

describe("confidence", () => {
  it("escalates below the floor and says the number", () => {
    const r = applyEscalationRules(escalationInput(decision({ confidence_score: 0.6 })));
    expect(r.decision.action_required).toBe("ESCALATE_TO_HUMAN");
    expect(r.reason).toContain("0.60");
    expect(r.reason).toContain(String(MIN_AUTONOMOUS_CONFIDENCE));
  });

  it("allows exactly the floor", () => {
    /* The boundary, asserted so a later `<=` typo is caught rather than silently narrowing
       the feature. */
    const r = applyEscalationRules(
      escalationInput(decision({ confidence_score: MIN_AUTONOMOUS_CONFIDENCE })),
    );
    expect(r.overruled).toBe(false);
  });

  it("is stricter than the sales agent's floor", () => {
    /* A half-understood sales enquiry produces a clumsy reply; a half-understood support
       answer produces instructions somebody follows. 0.72 is fine for sales, not for this. */
    const r = applyEscalationRules(escalationInput(decision({ confidence_score: 0.72 })));
    expect(r.decision.action_required).toBe("ESCALATE_TO_HUMAN");
  });
});

describe("the model contradicting itself", () => {
  it("escalates 'resolve the ticket' with resolution_found false", () => {
    /* The shape of a fluent non-answer. Without this the ticket would be CLOSED on it. */
    const r = applyEscalationRules(
      escalationInput(decision({ resolution_found: false })),
    );
    expect(r.decision.action_required).toBe("ESCALATE_TO_HUMAN");
    expect(r.reason).toContain("had not actually found the resolution");
  });

  it("always clears resolution_found when it escalates", () => {
    /* An escalation has resolved nothing, whatever the model claimed. Leaving it true would
       let the ticket be closed on the strength of an answer nobody sent. */
    const r = applyEscalationRules(escalationInput(decision({ severity_level: "CRITICAL" })));
    expect(r.decision.resolution_found).toBe(false);
  });
});

describe("the guards, applied to both customer-visible surfaces", () => {
  it("escalates a draft that names an unauthorised record", () => {
    const r = applyEscalationRules(
      escalationInput(
        decision({
          generated_response: {
            email_subject: "MX setup",
            body_text: "Add an MX record for aspmx.l.google.com with priority 1.",
            whatsapp_summary: "Check your admin console for the MX records.",
          },
        }),
      ),
    );
    expect(r.decision.action_required).toBe("ESCALATE_TO_HUMAN");
    expect(r.reason).toContain("aspmx.l.google.com");
  });

  it("escalates when ONLY the WhatsApp summary carries the invented value", () => {
    /* The summary is a separate piece of text the model wrote separately — and it is the one
       a customer reads on a phone and acts on immediately. Checking only the email body would
       miss exactly the surface that gets pasted into a DNS panel. */
    const r = applyEscalationRules(
      escalationInput(
        decision({
          generated_response: {
            email_subject: "MX setup",
            body_text: "Your admin console shows the exact records — copy them from there.",
            whatsapp_summary: "Quick version: set MX to mx.zoho.in",
          },
        }),
      ),
    );
    expect(r.decision.action_required).toBe("ESCALATE_TO_HUMAN");
    expect(r.reason).toContain("WhatsApp summary");
  });

  it("escalates a draft that asks for a password", () => {
    const r = applyEscalationRules(
      escalationInput(
        decision({
          generated_response: {
            email_subject: "Access issue",
            body_text: "To check this, please reply with your password.",
            whatsapp_summary: "Please share your password so we can check.",
          },
        }),
      ),
    );
    expect(r.decision.action_required).toBe("ESCALATE_TO_HUMAN");
    expect(r.reason).toContain("phishing");
  });

  it("escalates a draft naming money that is not on this customer's account", () => {
    const r = applyEscalationRules(
      escalationInput(
        decision({
          issue_category: "storage_quota",
          generated_response: {
            email_subject: "Storage",
            body_text: "Extra storage is ₹2,400 per year — shall I add it?",
            whatsapp_summary: "Extra storage costs a little more; a colleague will confirm.",
          },
        }),
      ),
    );
    expect(r.decision.action_required).toBe("ESCALATE_TO_HUMAN");
    expect(r.reason).toContain("₹2,400");
  });

  it("ALLOWS the customer's own subscription figure", () => {
    const r = applyEscalationRules(
      escalationInput(
        decision({
          issue_category: "subscription_or_seats",
          generated_response: {
            email_subject: "Your plan",
            body_text: "Your Business Standard runs at ₹12,960 per month and renews on 14 Sep.",
            whatsapp_summary: "Business Standard, ₹12,960 per month.",
          },
        }),
      ),
    );
    expect(r.overruled).toBe(false);
  });

  it("ALLOWS a percentage, because a diagnosis is not a concession", () => {
    /* "your mailbox is at 95%" is a fact about their account. findPromises flags every
       percentage for the acknowledgement path; applied unchanged here it would hold the most
       useful sentence in a storage answer. */
    const r = applyEscalationRules(
      escalationInput(
        decision({
          issue_category: "storage_quota",
          generated_response: {
            email_subject: "Storage",
            body_text: "The console shows your mailbox at 95% of its quota.",
            whatsapp_summary: "Your mailbox is at 95% of its quota.",
          },
        }),
      ),
    );
    expect(r.overruled).toBe(false);
  });
});

describe("promises nobody authorised", () => {
  it("escalates a committed date", () => {
    const r = applyEscalationRules(
      escalationInput(
        decision({
          generated_response: {
            email_subject: "Re: sync",
            body_text: "We will have this fixed by Friday.",
            whatsapp_summary: "Fixed soon.",
          },
        }),
      ),
    );
    expect(r.decision.action_required).toBe("ESCALATE_TO_HUMAN");
    expect(r.reason).toContain("Friday");
  });

  it("escalates a guarantee", () => {
    const r = applyEscalationRules(
      escalationInput(
        decision({
          generated_response: {
            email_subject: "Re: sync",
            body_text: "I guarantee this will not happen again.",
            whatsapp_summary: "It will not happen again.",
          },
        }),
      ),
    );
    expect(r.decision.action_required).toBe("ESCALATE_TO_HUMAN");
  });

  it("escalates a giveaway", () => {
    const r = applyEscalationRules(
      escalationInput(
        decision({
          generated_response: {
            email_subject: "Storage",
            body_text: "We can add the extra storage free of charge.",
            whatsapp_summary: "Extra storage at no cost.",
          },
        }),
      ),
    );
    expect(r.decision.action_required).toBe("ESCALATE_TO_HUMAN");
  });

  it("does NOT escalate 'free up space', which is the right answer to a full mailbox", () => {
    /* The exemption that keeps the discount rule usable on this path. If this fails, every
       storage ticket escalates and somebody deletes the rule — see maskSupportIdioms. */
    const r = applyEscalationRules(
      escalationInput(
        decision({
          issue_category: "storage_quota",
          generated_response: {
            email_subject: "Storage full",
            body_text:
              "To free up space, start with large mail attachments and then empty Trash — " +
              "Trash still counts towards the quota until it is emptied.",
            whatsapp_summary: "Free up space: large attachments first, then empty Trash.",
          },
        }),
      ),
    );
    expect(r.overruled).toBe(false);
  });

  it("ALLOWS the customer's own renewal date, in whatever form the model wrote it", () => {
    /* "When does my plan renew" is one of the commonest support questions, and the answer is a
       row in `subscriptions`. Unexempted, findPromises' date rule escalates every correct
       answer to it — and then somebody deletes the rule. Same allow-list shape as money. */
    for (const written of [
      "renews on 14 Sep",
      "renews on 14 September 2026",
      "renews on 14/09/2026",
      "renews on 2026-09-14",
      "renews on 14th September",
      "renews on 14 sep",
    ]) {
      const r = applyEscalationRules(
        escalationInput(
          decision({
            issue_category: "subscription_or_seats",
            generated_response: {
              email_subject: "Your renewal",
              body_text: `Your Business Standard ${written}.`,
              whatsapp_summary: "Your plan renews next month.",
            },
          }),
        ),
      );
      expect(r.overruled, `"${written}" should have been allowed`).toBe(false);
    }
  });

  it("still escalates a date that is NOT on the account", () => {
    /* The boundary. A renewal date is a fact; "by Friday" is a commitment; and somebody
       else's date is neither. All three must not collapse into one. */
    const r = applyEscalationRules(
      escalationInput(
        decision({
          issue_category: "subscription_or_seats",
          generated_response: {
            email_subject: "Your renewal",
            body_text: "Your plan renews on 3 Oct and I will have this sorted by tomorrow.",
            whatsapp_summary: "Renews soon.",
          },
        }),
      ),
    );
    expect(r.decision.action_required).toBe("ESCALATE_TO_HUMAN");
  });

  it("authorises nothing when the customer has no renewal date on record", () => {
    /* An empty allow-list means every date is a promise — the strict direction, and the one a
       missing row must fail in. */
    const r = applyEscalationRules(
      escalationInput(
        decision({
          generated_response: {
            email_subject: "Your renewal",
            body_text: "Your plan renews on 14 Sep.",
            whatsapp_summary: "Renews soon.",
          },
        }),
        { allowedDates: [] },
      ),
    );
    expect(r.decision.action_required).toBe("ESCALATE_TO_HUMAN");
  });

  it("the exemption is three phrases wide, not a hole", () => {
    expect(maskSupportIdioms("free up space")).not.toContain("free");
    expect(maskSupportIdioms("free storage")).not.toContain("free");
    /* Still a giveaway, still held. */
    expect(maskSupportIdioms("the first month is free")).toContain("free");
    expect(maskSupportIdioms("free of charge")).toContain("free");
  });
});

describe("the direction of travel", () => {
  it("can never turn an escalation back into an answer", () => {
    /* Nothing in these rules may relax the action. A later rule that "recovered" an
       escalation because some other check passed would undo the model's own decision to be
       careful — the one judgement it is best placed to make. */
    const escalated = decision({
      action_required: "ESCALATE_TO_HUMAN",
      severity_level: "LOW",
      confidence_score: 1,
      resolution_found: true,
    });
    const r = applyEscalationRules(escalationInput(escalated, { incoming: "one small question" }));
    expect(r.decision.action_required).toBe("ESCALATE_TO_HUMAN");
  });
});

/* ═══ Mapping onto the columns the dashboard already reads ═════════════════ */

describe("mapping the decision onto the existing ticket vocabulary", () => {
  it("maps severity to the priority values the schema already has", () => {
    expect(priorityForSeverity("CRITICAL")).toBe("urgent");
    expect(priorityForSeverity("HIGH")).toBe("high");
    expect(priorityForSeverity("MEDIUM")).toBe("normal");
    expect(priorityForSeverity("LOW")).toBe("low");
  });

  it("maps every topic into the five categories the Support screen filters on", () => {
    expect(categoryForTopic("invoice_or_billing")).toBe("billing");
    expect(categoryForTopic("subscription_or_seats")).toBe("billing");
    expect(categoryForTopic("dns_records")).toBe("tech");
    expect(categoryForTopic("service_outage")).toBe("tech");
    expect(categoryForTopic("password_or_access")).toBe("tech");
    expect(categoryForTopic("other")).toBe("other");
  });

  it("never chooses plan_change or feature", () => {
    /* A plan change is a commercial conversation the agent escalates, and a feature request is
       not a support incident. A ticket carrying either was categorised by a person, and this
       assertion is what keeps that readable. */
    const topics = [
      "dns_records",
      "workspace_admin",
      "mail_client_sync",
      "password_or_access",
      "storage_quota",
      "subscription_or_seats",
      "invoice_or_billing",
      "service_outage",
      "other",
    ] as const;
    for (const t of topics) {
      expect(["billing", "tech", "other"]).toContain(categoryForTopic(t));
    }
  });

  it("records what the turn did, which is not the ticket's status", () => {
    expect(resolutionStatusFor("AUTO_REPLY_AND_RESOLVE")).toBe("resolved");
    expect(resolutionStatusFor("REQUEST_MORE_INFO")).toBe("more_info_needed");
    expect(resolutionStatusFor("ESCALATE_TO_HUMAN")).toBe("escalated");
  });
});

describe("console URLs are the answer, not the mistake", () => {
  /* Measured 24 Aug 2026 on the first real message this agent answered: it did exactly what
     the knowledge base says — sent the customer to their own console — and the guard refused
     the draft for naming `admin.google.com`. The guard was blocking the one reply it exists to
     encourage. See CONSOLE_HOSTS. */

  it("allows the Google Admin console, which the KB tells the agent to name", () => {
    const r = verifyNoInventedRecords(
      "Open the Google Admin console at admin.google.com → Account → Domains → Activate Gmail. " +
        "That page lists the exact MX records for your domain.",
      [],
    );
    expect(r.ok, `violations: ${r.violations.join(", ")}`).toBe(true);
  });

  it("allows the account pages the runbooks need", () => {
    expect(
      verifyNoInventedRecords(
        "Generate an app password at myaccount.google.com, then use it in Outlook.",
        [],
      ).ok,
    ).toBe(true);
    expect(verifyNoInventedRecords("See support.google.com for the steps.", []).ok).toBe(true);
    expect(verifyNoInventedRecords("Open mailadmin.zoho.com to check.", []).ok).toBe(true);
  });

  it("does NOT allow a mail host that merely looks like a console", () => {
    /* The boundary, and the reason the exemption is a fixed list rather than "anything under
       google.com". A wrong value here is where the damage happens. */
    expect(verifyNoInventedRecords("point MX at mail.google.com", []).ok).toBe(false);
    expect(verifyNoInventedRecords("point MX at mail.zoho.com", []).ok).toBe(false);
    expect(verifyNoInventedRecords("point MX at aspmx.l.google.com", []).ok).toBe(false);
    expect(verifyNoInventedRecords("MX: acme-in.mail.protection.outlook.com", []).ok).toBe(false);
  });

  it("still catches a record value in a draft that ALSO names a console", () => {
    /* The realistic bad draft: the right instruction plus a helpfully invented record. The
       exemption must not launder the rest of the sentence. */
    const r = verifyNoInventedRecords(
      "Open admin.google.com → Domains. The records you need are aspmx.l.google.com (priority 1).",
      [],
    );
    expect(r.ok).toBe(false);
    expect(r.violations).toEqual(["aspmx.l.google.com"]);
  });

  it("the escalation rules agree — a console-only DNS answer is sendable", () => {
    /* The end-to-end version of the case that failed live: a good DNS answer must clear
       applyEscalationRules, not merely clear the sub-guard. */
    const r = applyEscalationRules(
      escalationInput(
        decision({
          issue_category: "dns_records",
          generated_response: {
            email_subject: "Re: MX records for your domain",
            body_text:
              "Hello,\n\nOpen the Google Admin console at admin.google.com → Account → Domains → " +
              "Manage domains → Activate Gmail. That page shows the exact MX records for your " +
              "domain; copy them from there into your DNS host. Only one SPF TXT record may " +
              "exist per domain. DNS changes can take up to 48 hours to propagate.\n\nRegards,\n" +
              "ANUTECH DIGITAL PVT LTD",
            whatsapp_summary:
              "Your exact MX records are shown in the Google Admin console under Domains → " +
              "Activate Gmail. Copy them from there. DNS can take up to 48 hours.",
          },
        }),
        { incoming: "Which MX records do I need to add at our DNS host?" },
      ),
    );
    expect(r.overruled, `reason: ${r.reason}`).toBe(false);
    expect(r.decision.action_required).toBe("AUTO_REPLY_AND_RESOLVE");
  });
});
