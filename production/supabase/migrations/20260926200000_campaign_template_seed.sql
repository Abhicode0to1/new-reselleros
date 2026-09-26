-- ============================================================================
-- System email-campaign templates.
--
-- The campaign composer's "Start from a template" list has a "System templates" group, but
-- campaign_templates was created (0224) with no rows ever seeded — so the group was empty
-- on every install (Pardeep, 26 Sep 2026: "kuch template bana do").
--
-- These are written for a Google Workspace / Microsoft 365 reseller that also builds custom
-- software. They are customer-facing, so plain English. Variables are the ones
-- /api/campaigns/send fills: {{name}} (first name), {{company}}, {{sender}} (company name),
-- and for offers {{offer_code}}, {{discount}}, {{expires}}. The unsubscribe footer is added
-- by the send route — templates must not carry their own.
--
-- System rows (tenant_id NULL, is_system true) are visible to every company and editable by
-- none (policies ctmpl_update / ctmpl_delete). A company copies one to make it its own.
-- ON CONFLICT DO UPDATE so improving the wording here reaches every install on re-run.
-- ============================================================================

insert into public.campaign_templates (id, tenant_id, name, category, subject, body_html, body_text, description, is_system)
values
(
  'sys-gws-intro', null, 'Google Workspace — introduction', 'onboarding',
  'A professional email for {{company}}',
  $h$<p>Hi {{name}},</p>
<p>Customers trust a business that writes from <b>you@yourcompany.com</b> far more than from a Gmail address. Google Workspace gives {{company}} that — plus Drive, Meet and Calendar, all under your own name.</p>
<ul>
<li>Professional email on your own domain</li>
<li>30 GB to 5 TB of storage per user</li>
<li>Video meetings, shared calendars, document collaboration</li>
</ul>
<p>We set it up end to end — domain, email migration and training — so your team is working the same day.</p>
<p>Reply to this mail and we will send you a quote for your team size.</p>
<p>Regards,<br>{{sender}}</p>$h$,
  $t$Hi {{name}},

Customers trust a business that writes from you@yourcompany.com far more than from a Gmail address. Google Workspace gives {{company}} that - plus Drive, Meet and Calendar, all under your own name.

- Professional email on your own domain
- 30 GB to 5 TB of storage per user
- Video meetings, shared calendars, document collaboration

We set it up end to end - domain, email migration and training - so your team is working the same day.

Reply to this mail and we will send you a quote for your team size.

Regards,
{{sender}}$t$,
  'First mail to a new lead interested in business email.', true
),
(
  'sys-m365-intro', null, 'Microsoft 365 — introduction', 'onboarding',
  'Microsoft 365 for {{company}} — Outlook, Teams and Office',
  $h$<p>Hi {{name}},</p>
<p>If your team lives in Excel, Word and Outlook, Microsoft 365 keeps all of it licensed, backed up and on your own email domain — with Teams for calls and chat.</p>
<ul>
<li>Business email in Outlook on your domain</li>
<li>Latest Office apps on up to 5 devices per user</li>
<li>1 TB OneDrive storage per user</li>
</ul>
<p>We handle the licences, the setup and moving your existing mail. Reply with your team size and we will send the right plan.</p>
<p>Regards,<br>{{sender}}</p>$h$,
  $t$Hi {{name}},

If your team lives in Excel, Word and Outlook, Microsoft 365 keeps all of it licensed, backed up and on your own email domain - with Teams for calls and chat.

- Business email in Outlook on your domain
- Latest Office apps on up to 5 devices per user
- 1 TB OneDrive storage per user

We handle the licences, the setup and moving your existing mail. Reply with your team size and we will send the right plan.

Regards,
{{sender}}$t$,
  'For leads who already use Office / Outlook.', true
),
(
  'sys-festival-offer', null, 'Festival offer — discount code', 'offer',
  '{{discount}}% off for {{company}} — this festive season',
  $h$<p>Hi {{name}},</p>
<p>This festive season, we are offering <b>{{discount}}% off</b> on new Google Workspace and Microsoft 365 licences.</p>
<p style="font-size:18px;margin:18px 0">Your code: <b style="letter-spacing:1px">{{offer_code}}</b></p>
<p>Valid until <b>{{expires}}</b>. Setup and email migration are included, as always.</p>
<p>Just reply to this mail with your team size to claim it.</p>
<p>Warm wishes,<br>{{sender}}</p>$h$,
  $t$Hi {{name}},

This festive season, we are offering {{discount}}% off on new Google Workspace and Microsoft 365 licences.

Your code: {{offer_code}}
Valid until {{expires}}. Setup and email migration are included, as always.

Just reply to this mail with your team size to claim it.

Warm wishes,
{{sender}}$t$,
  'Diwali / New Year offer. Turn on the offer box to fill code, discount and expiry.', true
),
(
  'sys-quote-followup', null, 'Quote follow-up', 'custom',
  'Any questions on the quote for {{company}}?',
  $h$<p>Hi {{name}},</p>
<p>Just following up on the quote we sent for {{company}}. Happy to adjust the plan, the number of users or the billing cycle if something does not fit.</p>
<p>If it helps, we can do a 15-minute call to walk through it — reply with a time that suits you.</p>
<p>Regards,<br>{{sender}}</p>$h$,
  $t$Hi {{name}},

Just following up on the quote we sent for {{company}}. Happy to adjust the plan, the number of users or the billing cycle if something does not fit.

If it helps, we can do a 15-minute call to walk through it - reply with a time that suits you.

Regards,
{{sender}}$t$,
  'For leads at "Quote sent" who have gone quiet.', true
),
(
  'sys-trial-followup', null, 'Trial follow-up', 'onboarding',
  'How is the trial going at {{company}}?',
  $h$<p>Hi {{name}},</p>
<p>Your trial has been running for a few days — how is the team finding it?</p>
<p>A few things people usually ask us at this point:</p>
<ul>
<li>Moving old emails in — we do it for you, nothing is lost</li>
<li>Setting up email on phones — takes two minutes, we can guide you</li>
<li>Which plan to pick — we will suggest one based on how you used the trial</li>
</ul>
<p>Reply to this mail and we will convert the trial without any break in email.</p>
<p>Regards,<br>{{sender}}</p>$h$,
  $t$Hi {{name}},

Your trial has been running for a few days - how is the team finding it?

A few things people usually ask us at this point:
- Moving old emails in - we do it for you, nothing is lost
- Setting up email on phones - takes two minutes, we can guide you
- Which plan to pick - we will suggest one based on how you used the trial

Reply to this mail and we will convert the trial without any break in email.

Regards,
{{sender}}$t$,
  'For leads at "Trial active".', true
),
(
  'sys-winback', null, 'Win-back — lost leads', 'winback',
  'Still looking for business email, {{name}}?',
  $h$<p>Hi {{name}},</p>
<p>We spoke a while ago about email and collaboration for {{company}}. If the timing was not right then, we would be glad to pick it up again.</p>
<p>A lot has changed since — prices, storage and plans — and we can usually find something that fits a tighter budget.</p>
<p>Reply "yes" and we will send an updated quote. No pressure either way.</p>
<p>Regards,<br>{{sender}}</p>$h$,
  $t$Hi {{name}},

We spoke a while ago about email and collaboration for {{company}}. If the timing was not right then, we would be glad to pick it up again.

A lot has changed since - prices, storage and plans - and we can usually find something that fits a tighter budget.

Reply "yes" and we will send an updated quote. No pressure either way.

Regards,
{{sender}}$t$,
  'For leads marked Lost, 2–3 months later.', true
),
(
  'sys-custom-software', null, 'Custom software — introduction', 'custom',
  'Software built around how {{company}} works',
  $h$<p>Hi {{name}},</p>
<p>Besides email and cloud, we build custom software — billing systems, ERPs, CRMs, customer portals and mobile apps — made around the way your business already runs, not the other way round.</p>
<ul>
<li>Fixed quote and milestones before we start</li>
<li>You own the code and the data</li>
<li>Support after go-live</li>
</ul>
<p>If there is a spreadsheet or a manual process slowing your team down, reply and tell us about it. We will suggest what can be automated.</p>
<p>Regards,<br>{{sender}}</p>$h$,
  $t$Hi {{name}},

Besides email and cloud, we build custom software - billing systems, ERPs, CRMs, customer portals and mobile apps - made around the way your business already runs, not the other way round.

- Fixed quote and milestones before we start
- You own the code and the data
- Support after go-live

If there is a spreadsheet or a manual process slowing your team down, reply and tell us about it. We will suggest what can be automated.

Regards,
{{sender}}$t$,
  'For custom software / project leads, or existing customers.', true
),
(
  'sys-referral-ask', null, 'Referral request — existing customers', 'custom',
  'Know a business that needs this, {{name}}?',
  $h$<p>Hi {{name}},</p>
<p>Thank you for trusting us with {{company}}'s email and IT. Most of our new customers come from recommendations like yours.</p>
<p>If you know a business that is still on Gmail addresses, struggling with Office licences, or needs software built — reply with their name and number, or just forward this mail to them.</p>
<p>We will take good care of them, and thank you for it.</p>
<p>Regards,<br>{{sender}}</p>$h$,
  $t$Hi {{name}},

Thank you for trusting us with {{company}}'s email and IT. Most of our new customers come from recommendations like yours.

If you know a business that is still on Gmail addresses, struggling with Office licences, or needs software built - reply with their name and number, or just forward this mail to them.

We will take good care of them, and thank you for it.

Regards,
{{sender}}$t$,
  'For Won customers. Pair with a referral partner record.', true
),
(
  'sys-newsletter-security', null, 'Newsletter — email security tips', 'newsletter',
  '3 quick checks to keep {{company}}''s email safe',
  $h$<p>Hi {{name}},</p>
<p>Three quick checks that stop most email problems before they start:</p>
<ol>
<li><b>Turn on 2-step verification</b> for every user — it blocks almost all password theft.</li>
<li><b>Remove ex-employees</b> the day they leave, and transfer their mail to a manager.</li>
<li><b>Watch for fake invoices</b> — confirm any change in bank details by phone, never by email.</li>
</ol>
<p>Want us to check these for your account? Reply and we will do it at no charge.</p>
<p>Regards,<br>{{sender}}</p>$h$,
  $t$Hi {{name}},

Three quick checks that stop most email problems before they start:

1. Turn on 2-step verification for every user - it blocks almost all password theft.
2. Remove ex-employees the day they leave, and transfer their mail to a manager.
3. Watch for fake invoices - confirm any change in bank details by phone, never by email.

Want us to check these for your account? Reply and we will do it at no charge.

Regards,
{{sender}}$t$,
  'Useful-first mail for all customers and warm leads.', true
)
on conflict (id) do update set
  name = excluded.name, category = excluded.category, subject = excluded.subject,
  body_html = excluded.body_html, body_text = excluded.body_text,
  description = excluded.description, is_system = true, tenant_id = null, updated_at = now();
