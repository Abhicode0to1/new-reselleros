/**
 * Google Ads conversion for the landing pages (R-139, 4 Oct 2026).
 *
 * Set GOOGLE_ADS_SEND_TO to the "send_to" value from Google Ads → Goals → Conversions →
 * (your lead conversion) → Tag setup, e.g. "AW-123456789/AbCdEfGhIj". It is public — it
 * ships in every page that fires it — so it lives here, not in a secret store.
 *
 * Empty = no tag at all. When set, gtag.js is loaded ONLY after a visitor sends the enquiry
 * form, then the conversion fires once. Nothing tracks a visitor who just reads the page.
 * The gclid is still on the landing URL at that moment (single-page form), and it is ALSO
 * stored on the lead (lib/marketing/utm.ts), so offline conversion import stays possible.
 */
export const GOOGLE_ADS_SEND_TO = "";

const SEND_TO_SHAPE = /^AW-\d{6,14}\/[A-Za-z0-9_-]{4,64}$/;

export function adsTagId(sendTo: string): string | null {
  return SEND_TO_SHAPE.test(sendTo) ? sendTo.split("/")[0] : null;
}

type Gtag = (...args: unknown[]) => void;
declare global {
  interface Window { dataLayer?: unknown[]; gtag?: Gtag }
}

/** Fire one lead conversion. Never throws; resolves either way. */
export function reportLeadConversion(sendTo: string = GOOGLE_ADS_SEND_TO, value?: number): Promise<void> {
  const tagId = adsTagId(sendTo);
  if (!tagId || typeof window === "undefined") return Promise.resolve();
  return new Promise((resolve) => {
    try {
      window.dataLayer = window.dataLayer ?? [];
      // gtag's documented shim: it pushes `arguments`, not an array.
      window.gtag = window.gtag ?? function gtag() { window.dataLayer!.push(arguments); } as Gtag;
      if (!document.getElementById("gtag-js")) {
        const sc = document.createElement("script");
        sc.id = "gtag-js";
        sc.async = true;
        sc.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(tagId)}`;
        document.head.appendChild(sc);
        window.gtag("js", new Date());
        window.gtag("config", tagId);
      }
      const done = () => resolve();
      window.gtag("event", "conversion", {
        send_to: sendTo,
        ...(value != null ? { value, currency: "INR" } : {}),
        event_callback: done,
      });
      setTimeout(done, 1500);            // never hold the thank-you screen hostage
    } catch {
      resolve();
    }
  });
}
