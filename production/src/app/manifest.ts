/**
 * Web App Manifest — Next.js TS metadata convention.
 *
 * This file is auto-served at `/manifest.webmanifest` by Next.js, and the
 * Metadata API automatically injects the `<link rel="manifest">` tag into
 * the <head>. No client work needed.
 *
 * Effects of installing as a PWA (Add to Home Screen):
 *   - Phone shows the Anutech Digital logo on the home screen
 *   - Tapping it opens the app in `standalone` display mode — no Safari
 *     / Chrome address bar, full screen like a native app
 *   - On iOS the splash screen uses theme_color while loading
 *   - The app remembers its session (auth cookies survive)
 *
 * Icons:
 *   - 192x192 + 512x512 PNGs are static files in public/ — the Anutech Digital
 *     logo, resized from the 1254px original (30 Sep 2026; until then route
 *     handlers drew an amber "R" from the old ResellerOS branding)
 *   - 180x180 apple-touch-icon is app/apple-icon.png, the same logo
 *
 * Theme:
 *   - Warm cream paper background, amber brand accent — matches the
 *     in-app design tokens defined in globals.css
 */
import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name:             "ResellerOS — Reseller business, operated.",
    short_name:       "ResellerOS",
    description:      "The complete operating system for Indian cloud resellers. Manage leads, quotes, GST invoices, renewals — all in one app.",
    start_url:        "/dashboard",
    scope:            "/",
    display:          "standalone",
    orientation:      "portrait",
    background_color: "#FAF8F2", // matches --paper
    theme_color:      "#C2410C", // brand amber
    lang:             "en-IN",
    categories:       ["business", "productivity", "finance"],
    icons: [
      {
        src:     "/icon-192.png",
        sizes:   "192x192",
        type:    "image/png",
        purpose: "any",
      },
      {
        src:     "/icon-512.png",
        sizes:   "512x512",
        type:    "image/png",
        purpose: "any",
      },
    ],
  };
}
