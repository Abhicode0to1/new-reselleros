/**
 * /unsubscribe — the page a campaign mail's "Unsubscribe" link opens.
 *
 * Shows the address and one button. Nothing is written on page load: mail scanners open
 * every link, so the opt-out happens only on the button's POST (api/public/unsubscribe).
 */
import type { Metadata } from "next";
import { PublicShell } from "../_components/public-shell";
import { UnsubscribeClient } from "./unsubscribe-client";

export const metadata: Metadata = {
  title: "Unsubscribe",
  robots: { index: false, follow: false },
};

export default function UnsubscribePage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  return (
    <PublicShell title="Unsubscribe" subtitle="Marketing mail band karna">
      <UnsubscribeClient t={one(searchParams.t)} e={one(searchParams.e)} s={one(searchParams.s)} c={one(searchParams.c)} />
    </PublicShell>
  );
}
