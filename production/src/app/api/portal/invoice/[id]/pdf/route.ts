/**
 * GET /api/portal/invoice/[id]/pdf — a customer downloads their own GST invoice.
 *
 * This was a 503 stub telling the client to WhatsApp the owner for a copy of
 * their own tax invoice. That is a dead end on the most customer-facing surface
 * in the product, and the machinery to fix it already existed: the same
 * server-side render the /api/v1 capability-URL route uses.
 *
 * SECURITY — read before editing.
 * This uses the ADMIN client, which bypasses RLS, so the ownership check here is
 * the only thing standing between one customer and another's invoice. It is
 * deliberately enforced IN THE QUERY and matches on BOTH customer_id and
 * tenant_id — two conditions rather than one, so a mistake in either column
 * can't open the door. Never relax this to "fetch by id, then render".
 */
import { type NextRequest } from "next/server";
import { createElement } from "react";
import { createAdminClient } from "@/lib/supabase/server";
import { getPortalSession } from "@/lib/portal/session";
import { logoDataUri } from "@/lib/pdf/logo";
import { buildInvoicePdfProps, type TenantPdfInfo } from "@/lib/pdf/build-props";
import { buildInvoiceUpiQr } from "@/lib/pdf/upi-qr";
import { invoiceAmountDue } from "@/lib/payments/amount-due";
import type { Invoice, Quote, Customer } from "@/lib/supabase/database.types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function deny(status: number, msg: string) {
  return new Response(msg, { status, headers: { "content-type": "text/plain" } });
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getPortalSession();
  if (!session) return deny(401, "Please sign in to download this invoice.");

  const admin = createAdminClient();

  // Ownership is part of the query, so no code path below can be holding
  // another customer's invoice — not even briefly.
  const { data: invoice } = await admin
    .from("invoices")
    .select("*")
    .eq("id", params.id)
    .eq("customer_id", session.customerId)
    .eq("tenant_id", session.tenantId)
    .maybeSingle();

  // Same response whether it is missing or belongs to someone else: confirming
  // that an id exists for a different customer is itself a small leak.
  if (!invoice) return deny(404, "Invoice not found.");

  const inv = invoice as Invoice;
  const [{ data: quote }, { data: customer }, { data: tenant }] = await Promise.all([
    admin.from("quotes").select("*").eq("invoice_id", inv.id).maybeSingle(),
    inv.customer_id
      ? admin.from("customers").select("*").eq("id", inv.customer_id).maybeSingle()
      : Promise.resolve({ data: null }),
    admin
      .from("tenants")
      .select("name, gstin, email, phone, address, state, state_code, upi_vpa, upi_payee_name, logo_url")
      .eq("id", inv.tenant_id)
      .maybeSingle(),
  ]);

  /* Fetched here, not inside the renderer: logoDataUri carries a 4s deadline and swallows
     every failure, so a slow or missing logo costs the mark and never the document. */
  const logo = await logoDataUri((tenant as { logo_url?: string | null } | null)?.logo_url);

  const props = buildInvoicePdfProps({
    logoDataUri: logo,
    invoice:  inv,
    quote:    (quote as Quote) ?? null,
    customer: (customer as Customer) ?? null,
    tenant:   (tenant as TenantPdfInfo) ?? {
      name: inv.customer_name, gstin: null, email: null,
      phone: null, address: null, state: null, state_code: null, logo_url: null,
    },
  });

  // Scan-to-pay QR. The amount MUST come from invoiceAmountDue() — `net_payable`
  // alone ignores receipts already banked against the invoice, which on a real
  // production row would have asked a customer for ₹5,40,000 they had already
  // paid. Nothing owed → no QR at all, so a settled invoice can't be paid twice.
  const t = tenant as { name?: string; upi_vpa?: string | null; upi_payee_name?: string | null } | null;
  const upi = await buildInvoiceUpiQr({
    vpa:        t?.upi_vpa,
    payeeName:  t?.upi_payee_name ?? t?.name,
    invoiceId:  inv.id,
    amountDue:  invoiceAmountDue(inv),
  });

  // Imported lazily so @react-pdf/renderer never enters a shared bundle — it
  // loads only when a PDF is actually requested.
  const { renderToBuffer } = await import("@react-pdf/renderer");
  const { InvoicePDF } = await import("@/lib/pdf/InvoicePDF");
  const buffer = await renderToBuffer(
    createElement(InvoicePDF, {
      ...props, upiQrDataUrl: upi?.dataUrl ?? null, upiVpa: upi?.vpa ?? null,
    }) as unknown as Parameters<typeof renderToBuffer>[0],
  );

  return new Response(new Uint8Array(buffer), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${inv.id}.pdf"`,
      // private: this is one customer's tax document, never a shared cache.
      "cache-control": "private, max-age=300",
    },
  });
}
