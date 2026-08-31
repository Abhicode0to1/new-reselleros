# Anutech Digital — company website

The 20-route marketing + commerce site from the design handoff (`design_handoff_anutech_site`),
rebuilt as a real Next.js 14 app with real URLs. Design fidelity target: the handoff's README —
every hex, size and radius there is authoritative, and `src/app/globals.css` carries them as
tokens.

## Run it

```bash
cd website
npm install
npm run dev        # http://localhost:3100
npm run gate       # build + typecheck + tests — run before any push
```

## How it connects to ResellerOS (the integration)

| From | To | How |
|---|---|---|
| `/quote` form → Generate | ResellerOS lead pipeline | POST `/api/enquiry` (this site) → server-side forward to the app's `/api/public/enquiry/general`. A lead lands in the ANUTECH tenant; the app's own AI sales agent / auto-quote takes over. Proxy exists because the app's public API sends no CORS headers. |
| ResellerOS page CTAs | The live app | `Start free trial` → `/signup`, demo → `/login` (see below). URLs live ONLY in `src/lib/config.ts`; a test fails if any other file carries one. |

⚠️ Submitting the quote form hits the LIVE app and creates a REAL lead — the auto-quote
pipeline emails a real quotation. Test it deliberately, not casually.

## Decisions taken (change them knowingly)

- **Demo CTA points at `/login`, not `/dashboard?preview=1`.** The handoff linked a preview
  mode that does not exist in the app. Building a public read-only demo tenant is an
  app-side task; until then the login page (with its dev demo list) is the honest target.
- **Checkout does not charge.** "Pay" records the order locally and lands on `/done`, exactly
  like the design prototype. Razorpay wiring is a launch task.
- **Client login is a demo.** The confirmation panel says so on the page. Real magic-link
  auth (or pointing at the ResellerOS customer portal) is a launch decision.
- **Cart lives in `localStorage`** (`anutech.cart.v1`) — the handoff's own caveat stands:
  production should move it server-side eventually.

## PLACEHOLDERS to replace before launch (the handoff's list, tracked)

1. **All prices** — one file: `src/lib/data/catalog.ts` (TLDs, hosting, mailboxes, licences,
   certs, margin assumptions). A test asserts prices exist only in data files.
2. **WhatsApp number** — `src/lib/config.ts` (`WHATSAPP_NUMBER`, currently fake). The floating
   button dials it; a fake number = dead button.
3. **CIN + street address** — About page / footer when available.
4. **Client logos (6), case studies (3), review quotes (3), Premier Partner badge, founder
   photo, 3 ResellerOS screenshots** — `ImageSlot` marks every spot.
5. **Legal drafts** — `src/lib/data/misc.ts`; each page still says "have your counsel review".
6. **Decide whether domains / hosting / SSL are real Anutech offerings.** If not: delete
   `app/domains`, `app/hosting`, `app/ssl`, their components, and the catalogue/footer/menu
   entries that point at them. The handoff itself flags this as an open business decision.
7. **Domain search is a deterministic placeholder** — production needs the registrar/EPP
   availability API (`src/components/home/DomainSearch.tsx` says where).

## Deploy (when decided)

Same pattern as `production/`: `output: "standalone"`, a small Node image, Cloud Run. No
Dockerfile is committed yet — deploying the website is a separate decision from building it.
