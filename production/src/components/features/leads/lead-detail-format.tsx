/**
 * Small formatting pieces shared by the lead drawer's tabs — moved verbatim out of
 * (app)/leads/page.tsx (S35, 28 Sep 2026).
 */
import type * as React from "react";
import type { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

export const ACTIVITY_META: Record<string, { icon: React.ComponentProps<typeof Icon>["name"]; label: string }> = {
  email:    { icon: "mail",    label: "Email sent" },
  email_in: { icon: "inbox",   label: "Reply received" },
  call:     { icon: "phone",   label: "Call" },
  whatsapp: { icon: "whatsapp", label: "WhatsApp" },
  note:     { icon: "edit",    label: "Note" },
  quote:    { icon: "file",    label: "Quote" },
  stage:    { icon: "refresh", label: "Stage change" },
};
export function fmtActTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
  } catch { return ""; }
}

// ============================================================
// Fact row helper for detail drawer
// ============================================================
export function Fact({ label, value, mono, big }: { label: string; value: string | null | undefined; mono?: boolean; big?: boolean }) {
  return (
    <div>
      <div className="text-2xs uppercase tracking-wider text-ink-3 mb-0.5">{label}</div>
      <div className={cn(
        "text-ink",
        mono && "font-mono",
        big && "font-serif text-xl",
        !value && "italic text-ink-3 text-sm"
      )}>
        {value || "—"}
      </div>
    </div>
  );
}
