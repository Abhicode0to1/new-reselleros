/**
 * The deal page's Quotes box — subscription quotes (`quotes.lead_id`) and project quotations
 * (`project_sales`, linked on `leads.project_id`) as one list, newest first (1 Oct 2026,
 * Pardeep: "project quote bhi dikhao").
 *
 * A project's status is read in quote language by lib/projects/quotation-view.ts, the same
 * mapping Customer 360 uses — nothing is copied into `quotes`.
 */
import { projectQuotationView } from "@/lib/projects/quotation-view";

export type DealQuoteBadge = "muted" | "warning" | "success" | "info" | "danger";

export interface DealQuoteRow {
  key: string;
  kind: "subscription" | "project";
  /** Quote id, or the project's title. */
  ref: string;
  /** Secondary line: plan for a quote; "Project" for a project quotation. */
  sub: string | null;
  statusLabel: string;
  badge: DealQuoteBadge;
  amount: number;
  createdAt: string | null;
  href: string;
}

const QUOTE_BADGE: Record<string, DealQuoteBadge> = {
  draft: "muted", sent: "warning", viewed: "info", accepted: "success", rejected: "danger", expired: "danger",
};

export function dealQuoteRows(
  quotes: ReadonlyArray<{ id: string; status?: string | null; amount?: number | null; created_at?: string | null; plan?: string | null }>,
  projects: ReadonlyArray<{ id: string; title?: string | null; status?: string | null; total_amount?: number | null; created_at?: string | null; accepted_at?: string | null }>,
): DealQuoteRow[] {
  const rows: DealQuoteRow[] = [
    ...quotes.map((q): DealQuoteRow => ({
      key: `q:${q.id}`, kind: "subscription", ref: q.id, sub: q.plan ?? null,
      statusLabel: q.status ?? "—", badge: QUOTE_BADGE[q.status ?? ""] ?? "muted",
      amount: q.amount ?? 0, createdAt: q.created_at ?? null, href: `/quotes/${q.id}`,
    })),
    ...projects.map((p): DealQuoteRow => {
      const v = projectQuotationView(p.status, p.accepted_at);
      return {
        key: `p:${p.id}`, kind: "project", ref: p.title || "Project quotation", sub: "Project",
        statusLabel: v.label, badge: v.kind, amount: p.total_amount ?? 0,
        createdAt: p.created_at ?? null, href: `/projects/${p.id}`,
      };
    }),
  ];
  const t = (s: string | null) => (s ? Date.parse(s) || 0 : 0);
  return rows.sort((a, b) => t(b.createdAt) - t(a.createdAt) || a.key.localeCompare(b.key));
}
