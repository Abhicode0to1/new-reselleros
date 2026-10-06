import type { Metadata } from "next";
import { Suspense } from "react";
import { TrialForm } from "@/site/components/trial/TrialForm";
import { fetchLiveWorkspace, mergeEditions } from "@/site/lib/live-catalog";

export const metadata: Metadata = {
  title: "Start a free trial",
  description:
    "Try Google Workspace, Microsoft 365 or Zoho on your own domain — mailboxes set up by us, no card and nothing charged during the trial — keep it only if you want it.",
};

export const revalidate = 600;

/**
 * The trial editions are the same live-merged catalogue the home and quote use, so a trial
 * never quotes a rate the app would then contradict. Suspense because TrialForm reads
 * useSearchParams (?ed=…, deep-linked from the home edition cards).
 */
export default async function TrialPage() {
  const editions = mergeEditions(await fetchLiveWorkspace());
  return (
    <section className="section rise">
      <div className="wrap">
        <div style={{ maxWidth: 660, marginBottom: 30 }}>
          <h1 className="h1-page" style={{ marginBottom: 16 }}>Try it on your own domain — before you pay for it.</h1>
          <p className="body-lg" style={{ margin: 0 }}>
            Pick a suite, tell us how many mailboxes, and we set the vendor&apos;s own trial up on your
            domain — DNS and all. No card, nothing charged during the trial; when it ends you decide
            whether to buy at the published rate.
          </p>
        </div>
        <Suspense fallback={null}>
          <TrialForm editions={editions} />
        </Suspense>
      </div>
    </section>
  );
}
