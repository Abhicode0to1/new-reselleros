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
    ],
  },
  async headers() {
    const isDev = process.env.NODE_ENV !== "production";
    return [
      {
        source: "/(.*)",
        headers: [
          ...(isDev ? [] : [{ key: "X-Frame-Options", value: "SAMEORIGIN" }]),
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
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
