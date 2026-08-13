/**
 * GET /api/v1/documents/invoice/{id}/pdf?token=<hmac>
 *
 * Public capability URL (no Bearer — the browser opens it). The token is an
 * HMAC bound to (invoice, tenant); we fetch the invoice by its globally-unique
 * id, read its tenant, and verify the token. Then render the GST Tax Invoice
 * PDF server-side (same InvoicePDF component the app uses).
 */
import { type NextRequest } from "next/server";
import { createElement } from "react";
import { createAdminClient } from "@/lib/supabase/server";
import { verifyPdfToken } from "@/lib/pdf/pdf-token";
import { buildInvoicePdfProps, type TenantPdfInfo } from "@/lib/pdf/build-props";
import { buildInvoiceUpiQr } from "@/lib/pdf/upi-qr";
import type { Invoice, Quote, Customer } from "@/lib/supabase/database.types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function deny(status: number, msg: string) {
  return new Response(msg, { status, headers: { "content-type": "text/plain" } });
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const id = params.id;
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const admin = createAdminClient();

  const { data: invoice } = await admin.from("invoices").select("*").eq("id", id).maybeSingle();
  if (!invoice) return deny(404, "Invoice not found");
  if (!verifyPdfToken("invoice", id, (invoice as Invoice).tenant_id, token)) {
    return deny(403, "Invalid or missing token");
  }

  const inv = invoice as Invoice;
  const [{ data: quote }, { data: customer }, { data: tenant }] = await Promise.all([
    admin.from("quotes").select("*").eq("invoice_id", id).maybeSingle(),
    inv.customer_id
      ? admin.from("customers").select("*").eq("id", inv.customer_id).maybeSingle()
      : Promise.resolve({ data: null }),
    admin.from("tenants").select("name, gstin, email, phone, address, state, state_code, upi_vpa, upi_payee_name").eq("id", inv.tenant_id).maybeSingle(),
  ]);

  const props = buildInvoicePdfProps({
    invoice:  inv,
    quote:    (quote as Quote) ?? null,
    customer: (customer as Customer) ?? null,
    tenant:   (tenant as TenantPdfInfo) ?? { name: inv.customer_name, gstin: null, email: null, phone: null, address: null, state: null, state_code: null },
  });

  // Scan-to-pay QR — net_payable, not gross, so the QR asks for what is
  // actually still owed once advances are adjusted (migration 0005).
  const t = tenant as { name?: string; upi_vpa?: string | null; upi_payee_name?: string | null } | null;
  const upi = await buildInvoiceUpiQr({
    vpa:       t?.upi_vpa,
    payeeName: t?.upi_payee_name ?? t?.name,
    invoiceId: inv.id,
    amountDue: inv.net_payable ?? inv.amount,
  });

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
      "content-disposition": `inline; filename="${id}.pdf"`,
      "cache-control": "private, max-age=300",
    },
  });
}
