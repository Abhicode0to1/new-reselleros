/**
 * Public project quotation — the customer-facing page for a one-time project
 * quote (custom software etc.). Opened via the link the operator shares, jo
 * id KE SAATH `?t=public_token` bhi rakhta hai — id akela kaafi nahi (wo
 * URL/email/log me dikhta hai; audit 1 Sep 2026, wahi niyam jo 0115 ne
 * /quote/[id]/accept par lagaya tha).
 *
 * Server Component: reads via the admin client (customer isn't authenticated).
 */
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/server";
import { rupee, formatDate } from "@/lib/utils";
import { quoteTokenMatches } from "@/lib/quotes/accept-token";
import { AcceptQuoteButton } from "./accept-button";
import type { ProjectQuoteLine } from "@/lib/supabase/database.types";

export const dynamic = "force-dynamic";

export default async function ProjectQuotePage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { t?: string };
}) {
  const supabase = createAdminClient();

  const { data: project } = await supabase
    .from("project_sales")
    .select("*")
    .eq("id", params.id)
    .maybeSingle();

  /* Galat id aur galat token dono ek hi notFound() dete hain. */
  if (!project || !quoteTokenMatches(searchParams.t, project.public_token)) {
    notFound();
  }
  if (!["quoted", "active", "completed"].includes(project.status)) {
    notFound();
  }

  const { data: milestones } = await supabase
    .from("project_milestones")
    .select("seq, label, total_amount, due_date")
    .eq("project_id", params.id)
    .order("seq", { ascending: true });

  const { data: tenant } = await supabase
    .from("tenants")
    .select("name, logo_url")
    .eq("id", project.tenant_id)
    .maybeSingle();

  const lines = (project.line_items ?? []) as ProjectQuoteLine[];
  const accepted = project.status !== "quoted";

  return (
    <main className="min-h-screen bg-paper-2/40 py-8 px-4">
      <div className="max-w-[720px] mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            {tenant?.logo_url && (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img src={tenant.logo_url} alt={tenant?.name ?? "Logo"} className="h-11 max-w-[140px] object-contain" />
            )}
            <div>
              <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold">{tenant?.name ?? "Quotation"}</p>
              <h1 className="font-serif text-3xl text-ink leading-tight mt-1">Quotation</h1>
            </div>
          </div>
          {accepted && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-soft text-emerald text-sm font-semibold px-3 py-1">
              ✓ Accepted
            </span>
          )}
        </div>

        <div className="rounded-lg border border-hairline bg-paper p-5 md:p-7 shadow-sm">
          <div className="mb-5">
            <p className="text-2xs uppercase tracking-wider text-ink-3 font-semibold">For</p>
            <p className="text-lg font-semibold text-ink">{project.customer_name}</p>
            <p className="text-sm text-ink-2 mt-1">{project.title}</p>
            {project.description && <p className="text-sm text-ink-3 mt-1">{project.description}</p>}
          </div>

          {/* Line items — phone par cards (§20, audit B5: customer-facing page
              phone par khulta hai; scroll wali table wahan padhne layak nahi). */}
          <ul className="sm:hidden divide-y divide-hairline border border-hairline rounded-md">
            {lines.map((l, i) => (
              <li key={i} className="p-3">
                <p className="text-sm text-ink">{l.name}</p>
                <div className="mt-1 flex items-center justify-between text-sm">
                  <span className="text-2xs text-ink-3">{l.qty} × {rupee(l.rate)}</span>
                  <span className="tabular-nums font-medium text-ink">{rupee(l.amount)}</span>
                </div>
              </li>
            ))}
          </ul>

          <div className="overflow-x-auto hidden sm:block">
            <table className="w-full text-sm min-w-[420px]">
              <thead>
                <tr className="border-b border-hairline text-2xs uppercase tracking-wider text-ink-3">
                  <th className="text-left py-2">Item</th>
                  <th className="text-right py-2">Qty</th>
                  <th className="text-right py-2">Rate</th>
                  <th className="text-right py-2">Amount</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i} className="border-b border-hairline/60">
                    <td className="py-2 text-ink">{l.name}</td>
                    <td className="py-2 text-right tabular-nums text-ink-2">{l.qty}</td>
                    <td className="py-2 text-right tabular-nums text-ink-2">{rupee(l.rate)}</td>
                    <td className="py-2 text-right tabular-nums text-ink">{rupee(l.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Totals */}
          <div className="mt-4 ml-auto max-w-[280px] space-y-1.5 text-sm">
            <Row label="Taxable value" value={rupee(project.taxable_amount)} />
            <Row label={`GST @ ${project.gst_rate}% ${project.inter_state ? "(IGST)" : "(CGST+SGST)"}`} value={rupee(project.gst_amount)} />
            <div className="border-t border-ink pt-1.5">
              <Row label="Total" value={rupee(project.total_amount)} strong />
            </div>
          </div>

          {/* Milestone schedule */}
          {(milestones?.length ?? 0) > 0 && (
            <div className="mt-6">
              <p className="text-2xs uppercase tracking-wider text-ink-3 font-semibold mb-2">Payment schedule</p>
              <ul className="divide-y divide-hairline border border-hairline rounded-md">
                {milestones!.map((m) => (
                  <li key={m.seq} className="flex items-center justify-between px-3 py-2 text-sm">
                    <span className="text-ink">{m.seq}. {m.label}{m.due_date ? ` · ${formatDate(m.due_date)}` : ""}</span>
                    <span className="font-mono text-ink">{rupee(m.total_amount)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Accept */}
          <div className="mt-7 pt-5 border-t border-hairline">
            {accepted ? (
              <p className="text-sm text-emerald font-medium">
                You&apos;ve accepted this quotation. {tenant?.name ?? "The team"} will be in touch about next steps.
              </p>
            ) : (
              <>
                <p className="text-sm text-ink-3 mb-3">
                  Accepting confirms you&apos;d like to proceed with this project on the terms above.
                </p>
                <AcceptQuoteButton projectId={project.id} token={project.public_token} />
              </>
            )}
          </div>
        </div>

        <p className="text-center text-2xs text-ink-3 mt-5">
          Powered by ResellerOS · This is a quotation, not a tax invoice.
        </p>
      </div>
    </main>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className={strong ? "text-ink font-semibold" : "text-ink-3"}>{label}</span>
      <span className={`font-mono ${strong ? "text-ink font-semibold text-base" : "text-ink-2"}`}>{value}</span>
    </div>
  );
}
