import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import type { PathReadiness } from "@/lib/provisioning/readiness";

/**
 * "Can this deployment actually deliver what it is selling?"
 *
 * A server component — there is nothing interactive here, and the whole point is
 * that the answer is already known by the time the page renders rather than
 * fetched afterwards.
 *
 * ─── SILENT WHEN READY, ON PURPOSE ──────────────────────────────────────────
 * Renders nothing at `severity: "none"`. The same discipline as the health
 * digest: a banner that says "all good" every day stops being read within a
 * fortnight, and then it is not read on the day it says something else.
 *
 * ─── AND IT IS NOT DECORATION AT `info` EITHER ──────────────────────────────
 * `info` means the path cannot deliver but no money can be taken — worth knowing
 * while setting the deployment up, not worth alarm. `critical` means money CAN be
 * taken for something nobody will deliver, which is the one state that costs
 * real rupees, so it gets the rose treatment and the full detail.
 */
export function ProvisioningBanner({ readiness }: { readiness: PathReadiness }) {
  if (readiness.severity === "none") return null;

  const critical = readiness.severity === "critical";

  return (
    <Card
      className={
        critical
          ? "p-4 mb-5 border-rose/40 bg-rose-soft/25"
          : "p-4 mb-5 border-amber/40 bg-amber-soft/20"
      }
    >
      <p className={`text-sm font-medium inline-flex items-center gap-2 ${critical ? "text-rose-ink" : "text-ink-2"}`}>
        <Icon name="alert" size={14} />
        {readiness.headline}
      </p>
      {readiness.detail && (
        <p className="text-2xs text-ink-3 mt-1.5 leading-relaxed">{readiness.detail}</p>
      )}
    </Card>
  );
}
