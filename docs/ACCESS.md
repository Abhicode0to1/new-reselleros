# Access — who can get into what (S38)

*Rule (Pardeep, 27 Sep 2026): every service the business runs on has **at least two admins**, so nothing stops when one person is ill, on leave or leaves. This file lists names and roles only — **never a password, key, token or recovery code**.*

Fill each row, then both people log in once and tick "checked".

| Service | What breaks without it | Admin 1 | Admin 2 | Checked (date) |
|---|---|---|---|---|
| Google Cloud — billing account `016FCA-400F3C-38036D` | App, all cron jobs, backups stop when billing lapses | abhishek@anutech.in (Billing Account Administrator) | _pardeep@anutech.in — needs R-017_ | |
| Google Cloud — project `resellsubsos-prod` (Owner) | Deploys, Cloud Run, Scheduler, Secret Manager | | | |
| Supabase — organisation (Owner) | Production database, auth, backups, restore | | | |
| Domain registrar (anutech.in and product domains) | Site and email go down when a domain expires | | | |
| DNS provider | Site, email, verification records | | | |
| Razorpay (Owner / Admin) | Customer payments, payment links, refunds | | | |
| Google Workspace (Super Admin) | Everyone's email and logins | | | |
| GitHub — repository admin | Code, branches, Actions (integration-check) | | | |
| Google Ads (Admin) | Ad spend, API developer token | | | |
| Meta Business Manager (Admin) | Meta ads, WhatsApp Business | | | |
| WhatsApp Business API — Gupshup (`GUPSHUP_*`) | Customer WhatsApp messages, broadcasts | | | |
| Email sending — Resend (`RESEND_API_KEY`) | Invoices, reminders, OTP emails | | | |
| Google Workspace reseller — Partner Sales Console (`GOOGLE_CSP_*`) | **Core business**: customer Workspace orders, seats, renewals, provisioning | | | |
| GST e-invoice portal / IRP (`GST_IRP_*`) | IRN on B2B invoices; e-invoice mandatory above the turnover limit | | | |
| Google AI Studio — Gemini API (`GEMINI_API_KEY`) | AI Lead Finder, AI replies and drafts | | | |
| Sentry (`SENTRY_*`) | Error alerts from production | | | |
| Healthchecks.io (`HEARTBEAT_PING_URL`) | Alert when a cron job silently stops | | | |
| Plausible analytics (`NEXT_PUBLIC_PLAUSIBLE_DOMAIN`) | Website traffic numbers | | | |
| AI calling — Vapi / Retell, Sarvam (`VAPI_*`, `RETELL_*`, `SARVAM_API_KEY`) | Telecalling agent, phone numbers, voice | | | |
| DMS engine / panel (`DMS_*`) | DMS panel purchase, trial, SSO for customers | | | |
| Claude organisation (team board, artifacts) | Cross-team board and chat | pardeep@anutech.in | | |

## When someone leaves or changes role

1. Remove their admin rights on every row above the same day.
2. Put another person in their column before removing, so no row drops to one admin.
3. Rotate any shared secret they could have seen (Secret Manager, Supabase service key, Razorpay keys).
