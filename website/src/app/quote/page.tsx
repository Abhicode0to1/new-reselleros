import type { Metadata } from "next";
import { QuoteBuilder } from "@/components/quote/QuoteBuilder";
import { fetchLiveWorkspace, liveGwMonthlyRate } from "@/lib/live-catalog";

export const metadata: Metadata = { title: "Get a quote" };

export const revalidate = 600;

export default async function QuotePage() {
  const gwMonthly = liveGwMonthlyRate(await fetchLiveWorkspace());
  return (
    <section className="section rise">
      <div className="wrap">
        <div style={{ maxWidth: 640, marginBottom: 30 }}>
          <h1 className="h1-page" style={{ marginBottom: 16 }}>A priced answer, the same working day.</h1>
          <p className="body-lg" style={{ margin: 0 }}>
            Pick the product, slide the headcount, and the estimate builds itself. Generate sends the
            requirement to our sales system — the formal GST quotation follows by email.
          </p>
        </div>
        <QuoteBuilder gwMonthlyRate={gwMonthly} />
      </div>
    </section>
  );
}
