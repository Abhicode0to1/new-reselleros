import type { Metadata } from "next";
import Link from "next/link";
import { LicenceCalculator } from "@/components/email/LicenceCalculator";
import { MailOptions } from "@/components/email/MailOptions";
import { SectionHead, Reveal } from "@/components/ui/bits";
import { EMAIL_FEATURES } from "@/lib/data/copy";

export const metadata: Metadata = { title: "Business email & productivity" };

export default function EmailPage() {
  return (
    <>
      <section className="section rise">
        <div className="wrap">
          <div style={{ maxWidth: 640 }}>
            <h1 className="h1-page" style={{ marginBottom: 16 }}>
              Business email on your own domain, from ₹79 a mailbox.
            </h1>
            <p className="body-lg" style={{ margin: "0 0 24px" }}>
              Anutech Mail, Google Workspace or Microsoft 365 — priced side by side, migrated free,
              with deliverability set up properly rather than left as a support article.
            </p>
            <Link href="/quote" className="btn btn-primary">Get a mailbox quote</Link>
          </div>
        </div>
      </section>

      <section className="section-tight" style={{ background: "var(--tint-2)" }}>
        <LicenceCalculator />
      </section>

      <section className="section">
        <div className="wrap">
          <SectionHead
            eyebrow="THREE WAYS TO RUN MAIL"
            title="Pick the mailbox that fits, not the dearest one"
            body="We will say when the cheap option is enough — the guidance page exists for exactly that."
          />
          <MailOptions />
        </div>
      </section>

      <section className="section" style={{ background: "var(--tint)" }}>
        <div className="wrap">
          <SectionHead eyebrow="INCLUDED" title="What every mailbox order carries" />
          <div className="grid-4" style={{ gap: 24 }}>
            {EMAIL_FEATURES.map((f) => (
              <Reveal key={f.title}>
                <div style={{ borderTop: "2px solid var(--dark)", paddingTop: 14 }}>
                  <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>{f.title}</div>
                  <p className="body" style={{ margin: 0, fontSize: 14 }}>{f.body}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
