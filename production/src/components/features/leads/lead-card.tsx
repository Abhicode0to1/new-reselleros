import { Avatar } from "@/components/ui/avatar";
import { Icon } from "@/components/ui/icon";
import { rupee, initials, formatDate } from "@/lib/utils";
import { getLeadWhatsAppUrl } from "@/lib/whatsapp";
import type { Lead } from "@/lib/supabase/database.types";
import { cn } from "@/lib/utils";

interface LeadCardProps {
  lead: Lead;
  isDragging?: boolean;
  onDragStart?: (id: string) => void;
  onDragEnd?: () => void;
  onClick?: (lead: Lead) => void;
  onQuickQuote?: (lead: Lead) => void;
  dupCount?: number;
  onOpenMerge?: (lead: Lead) => void;
}

// Deals ≥ this get a green highlight so the big-money cards pop on the board.
const HIGH_VALUE = 100_000; // ₹1L+

export function LeadCard({ lead, isDragging, onDragStart, onDragEnd, onClick, onQuickQuote }: LeadCardProps) {
  const ownerInitials = lead.contact_name ? initials(lead.contact_name) : "—";
  const age = formatDate(lead.created_at, "relative");
  const isHighValue = (lead.value ?? 0) >= HIGH_VALUE;

  // Calculate age in days to flag stale deals (> 7 days untouched)
  const createdTimestamp = new Date(lead.created_at).getTime();
  const daysOld = Math.floor((Date.now() - createdTimestamp) / (1000 * 60 * 60 * 24));
  const isStale = daysOld >= 7 && lead.stage !== "won" && lead.stage !== "lost";

  // Intent score: 🔥 Hot (Quote/Trial or high value), ⚡ Warm (Demo/Contacted), ❄️ Cold
  const isHot = (lead.stage === "quote" || lead.stage === "trial" || isHighValue) && lead.priority === "high";
  const isWarm = lead.stage === "demo" || lead.priority === "medium";

  const handleWhatsApp = (e: React.MouseEvent) => {
    e.stopPropagation();
    const url = getLeadWhatsAppUrl(lead);
    window.open(url, "_blank");
  };

  return (
    <div
      data-lead-id={lead.id}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", lead.id);
        onDragStart?.(lead.id);
      }}
      onDragEnd={onDragEnd}
      onClick={() => onClick?.(lead)}
      className={cn(
        "bg-paper border rounded-lg p-3 group relative transition-all duration-150 hover:shadow-sm",
        "cursor-grab active:cursor-grabbing",
        isHighValue
          ? "border-emerald/50 ring-1 ring-emerald/15 shadow-sm"
          : "border-hairline hover:border-hairline-strong",
        isDragging && "opacity-40 -rotate-[1.5deg] shadow-md"
      )}
    >
      {/* Top row: Company name + Intent micro-badge + Owner Avatar */}
      <div className="flex justify-between items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[13px] font-semibold text-ink leading-tight truncate" title={lead.company}>
              {lead.company}
            </span>
            {isHot && (
              <span className="px-1 py-0.2 rounded text-[9px] font-bold bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300">
                🔥 Hot
              </span>
            )}
            {isWarm && !isHot && (
              <span className="px-1 py-0.2 rounded text-[9px] font-bold bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
                ⚡ Warm
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {/* 1-Click WhatsApp Quick Action */}
          {lead.contact_phone && (
            <button
              type="button"
              onClick={handleWhatsApp}
              className="p-1 text-emerald hover:bg-emerald-50 dark:hover:bg-emerald-950/40 rounded transition-colors"
              title={`WhatsApp ${lead.contact_name || lead.company}`}
            >
              <Icon name="whatsapp" size={13} />
            </button>
          )}

          {lead.contact_name && (
            <Avatar initials={ownerInitials} color="indigo" size="sm" />
          )}
        </div>
      </div>

      {/* Seats · plan */}
      <div className="text-[11px] text-ink-3 mt-1.5 truncate" title={`${lead.seats ?? "—"} seats · ${lead.plan ?? "—"}`}>
        {lead.seats ?? "—"} seats · {lead.plan ?? "—"}
      </div>

      {/* Bottom row: Value (serif) | Age & Stale Indicator */}
      <div className="flex items-center justify-between mt-2.5 pt-2 border-t border-hairline">
        <span className={cn("font-serif tabular-nums text-sm font-bold inline-flex items-center gap-1", isHighValue ? "text-emerald" : "text-amber-ink")}>
          {isHighValue && <span aria-hidden className="text-[10px]">★</span>}
          {lead.value !== null ? rupee(lead.value, { compact: true }) : "—"}
        </span>

        <div className="flex items-center gap-1 text-[10px] text-ink-3">
          {isStale && (
            <span className="px-1 py-0.2 rounded bg-amber-100 text-amber-900 font-mono font-medium" title={`${daysOld} days in stage — schedule follow-up`}>
              ⚠️ {daysOld}d
            </span>
          )}
          <span>{age}</span>
        </div>
      </div>
    </div>
  );
}
