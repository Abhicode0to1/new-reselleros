/**
 * /portal/profile — read-only company info on file with the reseller.
 *
 * For v1 customers cannot edit (would need a workflow for verification).
 * They can request changes via the WhatsApp link.
 */
import Link from "next/link";
import { requirePortalSession } from "@/lib/portal/session";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { tenantWhatsAppLink } from "@/lib/portal/branding";
import { PortalPageHeader } from "../_components/portal-page";

export const dynamic = "force-dynamic";

export default async function PortalProfilePage() {
  const session  = await requirePortalSession();
  const supabase = createClient();

  const { data: customer } = await supabase
    .from("customers")
    .select("id, name, gstin, state, contact_name, contact_title, contact_email, contact_phone, since, domain, tan")
    .eq("id", session.customerId)
    .maybeSingle();

  return (
    /* 1080px, like every other content page in the portal. It was 800 with no
       reason recorded, which reads as drift rather than a decision — and next
       to the other pages it made the header start in a different place. The
       narrow measure that IS deliberate is on `support/new`, a form, where it
       is now written down. */
    <div className="max-w-[1080px] mx-auto px-6 py-8">
      <PortalPageHeader
        title="Profile"
        sub={`What we have on file. Changes? Message ${session.tenantContactName ?? session.tenantName} — we'll update and acknowledge.`}
      />

      <Card className="p-6 mb-4">
        <div className="text-2xs uppercase tracking-wider text-ink-3 font-semibold mb-4">
          Company
        </div>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-y-4 gap-x-6">
          <Row label="Company name"  value={customer?.name} />
          <Row label="Domain"        value={customer?.domain} mono />
          <Row label="GSTIN"         value={customer?.gstin} mono />
          <Row label="State"         value={customer?.state} />
          <Row label="TAN"           value={customer?.tan} mono hint="For TDS deductions" />
          <Row label="Customer since" value={customer?.since
            ? new Date(customer.since).toLocaleDateString("en-IN", { day: "2-digit", month: "long", year: "numeric" })
            : undefined} />
        </dl>
      </Card>

      <Card className="p-6 mb-4">
        <div className="text-2xs uppercase tracking-wider text-ink-3 font-semibold mb-4">
          Primary contact
        </div>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-y-4 gap-x-6">
          <Row label="Name"  value={customer?.contact_name} />
          <Row label="Title" value={customer?.contact_title} />
          <Row label="Email" value={customer?.contact_email} mono />
          <Row label="Phone" value={customer?.contact_phone} mono />
        </dl>
      </Card>

      {/* Left-aligned, like the rest of the portal. */}
      <Card className="p-6">
        <div className="text-sm text-ink-2 mb-3">
          Need to update GSTIN, address, primary contact, or any other detail?
        </div>
        {(() => {
          const reseller = session.tenantContactName ?? session.tenantName;
          const waLink = tenantWhatsAppLink(
            session.tenantPhone,
            `Hi ${reseller}, please update my profile (${customer?.name ?? "customer"}): ...`,
          );
          return waLink ? (
            <Button asChild variant="primary">
              <a href={waLink} target="_blank" rel="noopener noreferrer">
                <Icon name="whatsapp" size={14} className="mr-1.5" />
                WhatsApp {reseller}
              </a>
            </Button>
          ) : (
            <Button asChild variant="primary">
              <Link href="/portal/support">
                <Icon name="ticket" size={14} className="mr-1.5" />
                Raise a request
              </Link>
            </Button>
          );
        })()}
      </Card>

      <div className="mt-6 text-2xs text-ink-3 text-center">
        Signed in as <b className="text-ink">{session.userEmail}</b> · {session.tenantName}
      </div>
    </div>
  );
}

function Row({ label, value, mono, hint }: { label: string; value?: string | null; mono?: boolean; hint?: string }) {
  return (
    <div>
      <dt className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-0.5">
        {label}
      </dt>
      <dd className={`text-sm text-ink ${mono ? "font-mono" : ""}`}>
        {value || <span className="text-ink-3 italic">Not on file</span>}
      </dd>
      {hint && <div className="text-3xs text-ink-3 mt-0.5">{hint}</div>}
    </div>
  );
}
