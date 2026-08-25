# Telephony partner enquiry — AI voice agent, outbound, India

Written 25 Aug 2026. Send this before doing any more work on AI telecalling: the answers to
questions 1 and 2 decide whether the feature can run at all, and question 3 is a one-line
config change either way.

**Who to send it to.** Send the same body to two providers and compare — one India-first
(Exotel or Ozonetel, who handle DLT themselves) and one global-with-India-presence (Plivo,
who publish Retell/Vapi SIP integration docs). Change only the greeting line.

- Exotel — https://exotel.com/contact-us/
- Plivo — https://www.plivo.com/contact/
- Ozonetel — https://ozonetel.com/contact/

**Why two.** An India-first provider doing the DLT paperwork for us collapses most of the
problem, but usually costs more and may not support a third-party AI platform over SIP. Plivo
documents the Retell/Vapi SIP path but states plainly that it does not handle DLT. The answers
tell us which trade we are actually making, and one quote alone cannot.

**Do not skip the volume paragraph, and do not inflate it.** Our real numbers are small. A
provider who onboards us on an inflated forecast will price and prioritise accordingly, and
the conversation gets worse later, not better.

---

## Subject

AI voice agent — DLT-compliant outbound calling for an IT reseller (India)

## Body

Hello [Exotel / Plivo / Ozonetel] team,

I am writing from ANUTECH DIGITAL PVT LTD, a Delhi-based IT reseller. We sell Google
Workspace, Microsoft 365 and Zoho subscriptions to Indian businesses. GSTIN 07ABDCA0298H1ZP.

We have built an AI voice agent into our own sales software and are now looking for the
telephony and compliance layer to run it on. Before we choose a platform I would like clear
answers to three things, because two of them decide whether we proceed at all.

**1. DLT registration and the number.**
Can you provide a DLT-compliant outbound number that an automated AI voice agent may call
from? Specifically: would you handle the Principal Entity / DLT registration and the number
provisioning on our behalf, or is that something we must complete ourselves before you can
provision? We already hold the company PAN and GSTIN.

**2. Which number series applies to us.**
This is the question I most need answered correctly.

We understand from TRAI's July 2026 clarification that the 1600 series is restricted to
entities regulated by RBI, SEBI, IRDAI or PFRDA, and to government-to-citizen communication.
We are none of those, so I assume 1600 is not available to us — please correct me if that is
wrong.

That leaves two call types we want to make, and I would like your view on each:

  a. **Renewal reminder to an existing paying customer** — we call a customer who already
     buys from us, to tell them their subscription renews on a given date. Does this fall
     under the 140 promotional series with DND scrubbing, or can it be treated as a service
     or transactional communication?

  b. **Follow-up to an inbound enquiry** — someone submits an enquiry on our website or
     emails us asking for pricing, and we call them back to ask how many seats they need.
     Does the prior enquiry establish consent for TCCCPR purposes, and does this still
     require a 140-series number?

If both must run on 140 with DND scrubbing, please say so plainly — we would rather know now
than discover it after building on the assumption that (a) is a service call.

**3. Compatibility with our AI platform.**
Our software drives the call through a third-party voice AI platform (Retell AI or Vapi).
Does your number work with those over SIP trunking or elastic SIP, with our own number shown
as the outbound caller ID? If you have customers already running Retell or Vapi on your
trunks, that is useful to know.

**Volume, honestly stated.**
We are small today and I would rather tell you that upfront than have it come as a surprise.
Currently we receive around 27 enquiries a month, hold 7 active subscriptions, and have no
renewals falling due in the next 90 days. So realistically this starts at well under 50
outbound calls a month.

The reason it is worth your time: the software this runs inside is a multi-tenant product we
sell to other Indian resellers, so if it works for us it becomes the default telephony path
for every reseller on the platform.

**What I need to decide.**
Pricing for the number and per-minute outbound, any one-time DLT or onboarding cost, and the
realistic timeline from signing to first compliant call.

Thank you,

Pardeep Sharma
Director, ANUTECH DIGITAL PVT LTD
pardeep@anutech.in

---

## What to do with the replies

- **If question 2(a) comes back as "140, with DND scrubbing"** — the renewal-reminder call is
  a promotional call to our own customer, and a customer on DND simply will not receive it.
  That is worth knowing before anybody moves the `telecall.place` dial: it means the feature
  cannot be relied on for renewals, and the existing email cadence stays the primary channel.
- **If a provider says they will do the DLT registration for us** — that is the deciding
  factor, not the per-minute rate. The paperwork is the slow part.
- **If question 3 comes back as no** — the AI platform changes, not our code.
  `lib/telecall/provider.ts` already speaks both Retell and Vapi behind one interface, and a
  third vendor is one function there.

Either way, get a written answer to 2(a) and 2(b) before the first real call. Nothing in our
code can make an unregistered call legal, and the penalty lands on the caller, not on the
vendor.
