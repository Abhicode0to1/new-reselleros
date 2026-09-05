# Multi-stage Dockerfile for Next.js 14 (App Router) on Cloud Run.
#
# Outputs a ~150 MB final image using Next.js `output: "standalone"` mode,
# which bundles only the runtime files the production server needs (no
# node_modules, no source maps, no dev deps).
#
# Stages:
#   1. deps     — install npm packages (cached by package-lock.json)
#   2. builder  — run `next build`, produces .next/standalone
#   3. runner   — minimal node:alpine image running server.js
#
# Build args (set via cloudbuild.yaml or `docker build --build-arg`):
#   NEXT_PUBLIC_APP_URL — public base URL, baked into client bundle.
#
# Runtime env (set via `gcloud run deploy --set-secrets`):
#   SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET, RESEND_API_KEY, RESEND_FROM_DEFAULT

# syntax=docker/dockerfile:1.7

# ── Stage 1: install dependencies ───────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app

# Alpine doesn't ship libc — Next.js needs this for some binaries
RUN apk add --no-cache libc6-compat

COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

# ── Stage 2: build the Next.js app ──────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Public env vars — designed to be exposed in the client bundle.
# Supabase URL and anon key are PUBLIC by design (RLS protects the data).
ENV NEXT_PUBLIC_SUPABASE_URL="https://ontpnqjoysjgrlsukecm.supabase.co"
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY="sb_publishable_M1d2SCgCNq5QXLVAOsBPUA_UwLutFUK"

# App URL — must be a valid URL (Next.js metadataBase calls `new URL(...)` at build).
# NOTE: this is baked into the bundle at build time. It defaults to the live
# Cloud Run URL so email/notification links actually resolve. `resellersos.app`
# was NOT live and produced dead links. Override via --build-arg once a real
# custom domain is mapped. (Customer-facing quote links now derive from the
# request host instead — see /api/quotes/[id]/send — so they're domain-agnostic.)
# The real custom domain, bound to whichever Cloud Run service is live. Baked in
# at build (NEXT_PUBLIC_* is inlined by `next build`, so a runtime env can't set
# it). Using the domain — not a run.app host — means OAuth redirects, email links
# and the Razorpay webhook URL survive a region move (asia-south1 →
# asia-southeast1, 5 Sep 2026). Override via --build-arg for a preview build.
ARG NEXT_PUBLIC_APP_URL="https://anutech.in"
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL

# Web-push VAPID PUBLIC key. Public by design — the browser sends it to the push
# service when subscribing, so it ends up in the client bundle either way (RFC 8292).
#
# It has to be HERE and not a Cloud Run env var, and the difference is not cosmetic:
# NEXT_PUBLIC_* is substituted into the bundle by `next build`, so a value supplied only
# at runtime arrives as undefined in the browser. The Notifications card reads exactly
# this variable to decide whether push is configured — so setting it the obvious way
# would have shipped a production app telling every user "Push is not set up on the
# server yet" while the server held both keys and worked fine.
#
# The matching VAPID_PRIVATE_KEY is a real secret and is a Cloud Run runtime env var.
# It must never appear in this file. The pair must stay together: a public key that does
# not match the private one produces subscriptions the server cannot ever push to.
ENV NEXT_PUBLIC_VAPID_PUBLIC_KEY="BD4DQzE6L6cSqpFJH8_409BbMpIZ4tyQ6PpToNVqviGN2v5uWUO5T4WU99Z7eIL3vJXK8Z3axZrV3iMS6SmP2Qk"

ENV NEXT_TELEMETRY_DISABLED=1

# ── THE BUILD RAN OUT OF MEMORY — 31 Aug 2026 ────────────────────────────────
# Build bf623310 died with "FATAL ERROR: Ineffective mark-compacts near heap limit
# Allocation failed - JavaScript heap out of memory", and the deploy simply did not happen.
# The same commit had built locally minutes earlier in 201s — a laptop has more headroom, so
# nothing in the gate could see this coming.
#
# It is NOT a shortage of machine. `cloudbuild.yaml` is E2_HIGHCPU_8, which is 8 vCPU and
# 8 GB, and the comment there already records that 32 cores bought 11% and was reverted. The
# shortage is Node's own heap: it sizes old-space from a fraction of what it detects and, in a
# container, that lands near 2 GB — a quarter of the RAM sitting there unused.
#
# 6 GB leaves ~2 GB for the OS, npm and the compiler's own child processes. Raising the
# machine instead would cost money for RAM Node was never going to ask for.
#
# If this returns, the next lever is real: 128 pages and 152 API routes type-checked in one
# pass. Splitting that is work, and buying heap first is the cheap half.
ENV NODE_OPTIONS=--max-old-space-size=6144

RUN npm run build

# ── Stage 3: minimal production image ───────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=8080
ENV HOSTNAME=0.0.0.0

# Non-root user
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

# Copy only the standalone runtime + static assets
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# ─── Which build is this? ─────────────────────────────────────────────────────
# 26 Aug 2026. "Kya deploy aa gaya?" ka jawab aaj TEEN baar kahin se nahi mila:
# `gcloud` ka auth expire tha (aur `gcloud auth login` interactive hai), Cloud Build
# GitHub par commit status report nahi karta, aur app ke andar kuch nahi batata tha ki
# wo kaun sa commit chala rahi hai. Do baar timer par bharosa karna pada, jo naap nahi
# hai — aur ek baar wo andaza galat bhi nikla.
#
# `cloudbuild.yaml` pehle se image ko `$SHORT_SHA` se tag karta hai, aur uska comment
# kehta hai: "which build is live should never be a guess." Ye us iraade ko poora karta
# hai — tag repo me dikhta tha, chalti hui app me nahi.
#
# ⚠️ JAGAH SOCH KAR CHUNI HAI: ye COPY ke BAAD aur runner stage ke andar hai. Har commit
# par SHA badalta hai; upar rakhne par `npm install` aur `npm run build` ka cache har baar
# tootta aur deploy minute se badh kar bahut lamba ho jata. Yahan sirf ye do chhoti layer
# banti hain.
#
# NEXT_PUBLIC_ jaan-boojh kar NAHI — ye sirf server par chahiye. NEXT_PUBLIC_ hone par
# poore client bundle me chala jata, bina kisi faayde ke.
ARG BUILD_SHA="dev"
ARG BUILD_ID=""
ENV BUILD_SHA=$BUILD_SHA
ENV BUILD_ID=$BUILD_ID

USER nextjs
EXPOSE 8080

# server.js is generated by Next.js standalone build
CMD ["node", "server.js"]
