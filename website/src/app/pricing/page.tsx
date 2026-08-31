import type { Metadata } from "next";
import { SectionHead } from "@/components/ui/bits";
import { RateTable } from "@/components/ui/RateTable";
import { TLDS, HOSTING_PLANS } from "@/lib/data/catalog";
import { rupee } from "@/lib/money";
import { effectiveReg } from "@/lib/offers";

export const metadata: Metadata = { title: "Every price" };

/** Four stacked tables, identical dark-header treatment — "every rate on one page". */
export default function PricingPage() {
  return (
    <section className="section rise">
      <div className="wrap" style={{ display: "flex", flexDirection: "column", gap: 44 }}>
        <div style={{ maxWidth: 640 }}>
          <h1 className="h1-page" style={{ marginBottom: 16 }}>Every price, on one page.</h1>
          <p className="body-lg" style={{ margin: 0 }}>
            All rates exclusive of GST at 18%, stated separately on the invoice. Renewal prices sit
            next to first-year prices — the number that actually decides what a thing costs.
          </p>
        </div>

        <div>
          <SectionHead title="Domains" />
          <RateTable
            head={["EXTENSION", "REGISTER", "RENEW", "TRANSFER"]}
            rows={TLDS.slice(0, 8).map((t) => {
              const p = effectiveReg(t.tld, t.reg);
              return [
                <span key="a" className="mono" style={{ color: "var(--primary)" }}>{t.tld}</span>,
                p.offer ? (
                  <b key="b" style={{ whiteSpace: "nowrap" }}>
                    <s style={{ color: "var(--text-disabled)", fontWeight: 400 }}>{rupee(p.offer.was)}</s>{" "}
                    <span style={{ color: "var(--success)" }}>{rupee(p.reg)}</span>
                  </b>
                ) : (
                  <b key="b">{rupee(t.reg)}</b>
                ),
                rupee(t.renew),
                rupee(t.transfer),
              ];
            })}
          />
        </div>

        <div>
          <SectionHead title="Hosting" />
          <RateTable
            head={["PLAN", "YEARLY /MO", "MONTHLY", "WHAT IT SUITS"]}
            rows={HOSTING_PLANS.map((p) => [
              <b key="a">{p.name}</b>,
              rupee(p.yearly),
              rupee(p.monthly),
              <span key="d" className="meta">{p.who}</span>,
            ])}
          />
        </div>

        <div>
          <SectionHead title="Mailboxes" />
          <RateTable
            head={["PRODUCT", "PER MAILBOX", "MINIMUM", "STORAGE"]}
            rows={[
              [<b key="a">Anutech Mail</b>, "₹79/mo", "1 mailbox", "5 GB"],
              [<b key="a">Google Workspace</b>, "₹165/mo", "1 seat", "30 GB + Drive"],
              [<b key="a">Microsoft 365</b>, "₹185/mo", "1 seat", "50 GB + 1 TB"],
            ]}
          />
        </div>

        <div>
          <SectionHead title="Certificates" />
          <RateTable
            head={["CERTIFICATE", "PRICE", "VALIDATION", "COVERS"]}
            rows={[
              [<b key="a">Free DV</b>, "₹0", "Domain", "One site, auto-renewed"],
              [<b key="a">Positive SSL</b>, "₹899/yr", "Domain", "One domain"],
              [<b key="a">Wildcard</b>, "₹4,499/yr", "Domain", "*.yourdomain.in"],
              [<b key="a">OV / EV</b>, "₹6,999/yr", "Organisation", "Company name on cert"],
            ]}
          />
        </div>
      </div>
    </section>
  );
}
