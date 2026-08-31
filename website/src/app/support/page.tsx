import type { Metadata } from "next";
import { SupportBody } from "@/components/support/SupportBody";

export const metadata: Metadata = { title: "Support & knowledge base" };

export default function SupportPage() {
  return (
    <section className="section rise">
      <div className="wrap">
        <div style={{ maxWidth: 640, marginBottom: 30 }}>
          <h1 className="h1-page" style={{ marginBottom: 16 }}>Support that answers in minutes, not tiers.</h1>
          <p className="body-lg" style={{ margin: 0 }}>
            WhatsApp first — eleven-minute average first reply in working hours. The knowledge base is
            for 2 AM; the humans are for everything else.
          </p>
        </div>
        <SupportBody />
      </div>
    </section>
  );
}
