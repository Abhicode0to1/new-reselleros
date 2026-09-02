import type { Metadata } from "next";
import { HostingPlans } from "@/site/components/hosting/HostingPlans";
import { SectionHead } from "@/site/components/ui/bits";
import { RateTable } from "@/site/components/ui/RateTable";
import { HOSTING_SPECS } from "@/site/lib/data/catalog";

export const metadata: Metadata = { title: "cPanel web hosting" };

export default function HostingPage() {
  return (
    <>
      <section className="section rise">
        <div className="wrap">
          <div style={{ maxWidth: 640 }}>
            <h1 className="h1-page" style={{ marginBottom: 16 }}>
              cPanel on NVMe, in Mumbai and Bengaluru.
            </h1>
            <p className="body-lg" style={{ margin: 0 }}>
              LiteSpeed, free SSL, backups you can actually restore — and a 99.9% SLA that credits
              itself when a month falls short.
            </p>
          </div>
        </div>
      </section>

      <section className="section-tight" style={{ background: "var(--tint)" }}>
        <div className="wrap">
          <HostingPlans />
        </div>
      </section>

      <section className="section" id="specs">
        <div className="wrap">
          <SectionHead
            eyebrow="FULL SPECIFICATION"
            title="All fourteen rows, nothing hidden"
            body="An em-dash means the plan does not include it — greyed, not omitted."
          />
          <RateTable
            head={["", "STARTER", "BUSINESS", "AGENCY"]}
            minWidth={760}
            rows={HOSTING_SPECS.map(([label, a, b, c]) => [
              <span key="l" style={{ fontWeight: 600 }}>{label}</span>,
              <Cell key="a" v={a} />,
              <Cell key="b" v={b} />,
              <Cell key="c" v={c} />,
            ])}
          />
        </div>
      </section>
    </>
  );
}

function Cell({ v }: { v: string }) {
  return <span style={{ color: v === "—" ? "var(--text-disabled)" : "var(--text)" }}>{v}</span>;
}
