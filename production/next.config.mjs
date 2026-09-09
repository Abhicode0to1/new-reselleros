import { withSentryConfig } from "@sentry/nextjs";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // standalone output produces a self-contained server bundle that Cloud Run
  // can run with a tiny Node image — no node_modules at runtime.
  output: "standalone",
  /**
   * `next dev` aur `next build` DONO `.next` likhte hain, to gate chalane ke liye kiya
   * gaya ek build chalte dev server ka bundle mita deta hai — page apne hi chunk par 404
   * deta hai aur "toota hua" dikhta hai, jabki kuch toota nahi.
   *
   * 28 Aug 2026 ko iski keemat saaf dikhi: build karne ke liye Pardeep ka chalta dev
   * server band karna pada, aur baad me wapas chalu karna pada.
   *
   * Isliye distDir env se badla ja sakta hai. Docker aur Cloud Build ise SET NAHI karte,
   * to prod ke liye kuch nahi badla — ye sirf local gate ke liye ek alag folder hai
   * (`npm run build:check`).
   */
  distDir: process.env.NEXT_DIST_DIR || ".next",
  /**
   * Client bundle me `fs` ek khaali module ban jata hai, build fail nahi hota.
   *
   * Wajah ek asli build failure hai: `lib/pdf/fonts.ts` server par font ki file
   * `existsSync` se jaanchta hai, aur wahi module client tak pahunchta hai — kyunki
   * `accounting/payroll/screens.tsx` ek client component hai aur `lib/pdf/index.tsx`
   * ke zariye `PayslipPDF` tak jata hai. Webpack ne kaha:
   *
   *     Module not found: Can't resolve 'fs'
   *
   * `fs` ka istemaal us function ke andar `typeof window !== "undefined"` ke peeche hai,
   * to browser me wo line kabhi chalti hi nahi — sirf webpack ko module HAL karna padta hai.
   * Yahi Next ka apna suggested hal hai (`resolve.fallback`), aur sirf client build par
   * lagta hai; server build me asli `fs` waisa hi rehta hai.
   *
   * ⚠️ Iska matlab ye NAHI hai ki client code me `fs` use kiya ja sakta hai. Client par
   * module khaali hai — koi bhi call `undefined is not a function` degi, build ke waqt
   * nahi, chalte app me. Server-only kaam ko `typeof window` ke peeche rakhna hi padega.
   */
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = { ...config.resolve.fallback, fs: false };
    }
    return config;
  },
  experimental: {
    typedRoutes: true,
    // Force-enable instrumentation hook. Next 14.0.4+ enables it by default,
    // but in standalone output mode on Cloud Run we observed register() never
    // firing (boot logs proved it). Setting this explicitly makes 14.2.15
    // load instrumentation.ts reliably. Required for Sentry server init.
    instrumentationHook: true,
  },
  images: {
    formats: ["image/avif", "image/webp"],
    remotePatterns: [
      { protocol: "https", hostname: "upload.wikimedia.org" },
      { protocol: "https", hostname: "images.unsplash.com" },
      { protocol: "https", hostname: "*.supabase.co" },
      // Self-hosted data plane (Storage serves images from here). Same host the
      // CSP connect-src is derived from below — keep both in step.
      ...(() => {
        try {
          const u = new URL((process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, ""));
          if (!u.hostname || u.hostname.endsWith(".supabase.co")) return [];
          /* hostname, NOT host: a remotePattern hostname carrying ":54321" matches
             nothing, because the port is a separate field. And the protocol follows the
             URL for the same reason the CSP does — see headers() below. */
          return [{
            protocol: u.protocol === "http:" ? "http" : "https",
            hostname: u.hostname,
            ...(u.port ? { port: u.port } : {}),
          }];
        } catch {
          return [];
        }
      })(),
    ],
  },
  async headers() {
    const isDev = process.env.NODE_ENV !== "production";
    /* CSP connect-src must name the Supabase host the browser actually talks to.
       Derive it from NEXT_PUBLIC_SUPABASE_URL (baked at build) so it can never drift
       from the client again — the way it did when the data plane moved to
       api.anutech.in but this list still only allowed *.supabase.co, and every
       client-side query silently died on a CSP error ("No workspace"/"Not signed
       in"). Keep *.supabase.co too so a rollback to hosted Supabase still works. */
    const supaUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, "");
    let supaConnect = "https://*.supabase.co wss://*.supabase.co";
    try {
      if (supaUrl) {
        const u = new URL(supaUrl);
        /* Take the SCHEME from the URL, do not assume https. This line used to hardcode
           https://+wss://, which is correct for every deployed environment and wrong for
           every local one: a local stack is http://127.0.0.1:54321, the CSP then allowed
           only the https:// form of that host, and the browser refused every client-side
           Supabase call with "Refused to connect because it violates the document's
           Content Security Policy". Measured 9 Sep 2026: it made /portal/login
           unusable locally — portal_customer_exists never left the page — and because
           this CSP is applied in dev too (deliberately, see below) there was no
           environment in which the portal could be signed into by hand.
           Deployed output is unchanged: an https:// URL still yields https://+wss://. */
        const web = u.protocol === "http:" ? "http"  : "https";
        const ws  = u.protocol === "http:" ? "ws"    : "wss";
        supaConnect = `${web}://${u.host} ${ws}://${u.host} ${supaConnect}`;
      }
    } catch {
      /* malformed env → fall back to the wildcard above */
    }
    return [
      {
        source: "/(.*)",
        headers: [
          ...(isDev ? [] : [{ key: "X-Frame-Options", value: "SAMEORIGIN" }]),
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          /* ── CSP — pehli baar (audit C1, 1 Sep 2026) ─────────────────────────
             Jaan-boojh kar UDAAR script/style ('unsafe-inline'/'unsafe-eval' —
             Next ka runtime bina nonce-pipeline ke inhi par chalta hai) aur KASA
             wahan jahan asli hamla rukta hai: object-src 'none' (SVG/Flash-shailee
             embeds), base-uri (link-hijack), form-action (credential-exfil apne
             origin ke bahar form-post se), frame-src sirf Razorpay. connect-src me
             Supabase (REST+realtime), Razorpay, Sentry-ingest. Naya third-party
             jodo to yahan bhi jodna hoga — CSP-error console me saaf naam ke
             saath aata hai. Prod-only (isDev guard nahi: dev me bhi wahi niyam,
             taki todne wala badlav deploy se pehle dikhe). */
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://checkout.razorpay.com",
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              "img-src 'self' data: blob: https:",
              "font-src 'self' data: https://fonts.gstatic.com",
              `connect-src 'self' ${supaConnect} https://api.razorpay.com https://lumberjack.razorpay.com https://*.ingest.sentry.io https://*.ingest.us.sentry.io`,
              "frame-src 'self' https://api.razorpay.com https://checkout.razorpay.com",
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self'",
              "frame-ancestors 'self'",
            ].join("; "),
          },
          // camera=(self): the attendance kiosk needs the camera for check-in
          // selfies. Empty () would block getUserMedia in EVERY browser
          // regardless of OS/site settings. geolocation stays disabled.
          //
          // ── microphone: () → (self), 26 Aug 2026 ──────────────────────────
          // The leads drawer now dictates call notes (lib/voice/use-dictation.ts), and
          // `microphone=()` blocked it at the DOCUMENT level — above Chrome's own
          // permission. That produced the worst possible symptom: Chrome's site panel
          // said "Microphones — Allowed" with a live input meter, while
          // `navigator.permissions.query` returned `denied` and no prompt ever appeared.
          // Pardeep spent an hour in Chrome settings and across 11 profiles chasing a
          // block that was in this file.
          //
          // The comment above already warned that `()` blocks getUserMedia "regardless of
          // OS/site settings" — it was written for camera and was right about mic too.
          // Nothing read it, because nothing needed the mic until today.
          //
          // `(self)` — same-origin only, so an embedded third-party frame still cannot
          // reach the mic. That is the point of the header, and it is kept.
          { key: "Permissions-Policy", value: "camera=(self), microphone=(self), geolocation=()" },
        ],
      },
    ];
  },
};

// Wrap with Sentry only when the DSN+auth-token pair is available (production).
// In local dev without these env vars, `withSentryConfig` becomes a no-op
// wrapper so builds still work without Sentry credentials.
const sentryWebpackPluginOptions = {
  silent: true,                              // suppress source-map upload logs
  org:    process.env.SENTRY_ORG    || "",
  project: process.env.SENTRY_PROJECT || "",
  authToken: process.env.SENTRY_AUTH_TOKEN,  // required only for source-map upload
  // Don't upload source maps if no auth token (dev builds, fork builds).
  disableServerWebpackPlugin: !process.env.SENTRY_AUTH_TOKEN,
  disableClientWebpackPlugin: !process.env.SENTRY_AUTH_TOKEN,
  // Source maps stay private — Sentry needs them but they're not exposed.
  hideSourceMaps: true,
};

export default withSentryConfig(nextConfig, sentryWebpackPluginOptions);
