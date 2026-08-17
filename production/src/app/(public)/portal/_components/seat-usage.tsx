/**
 * SeatUsage — how many of the customer's seats are actually in use.
 *
 * ─── "0 of 10" WAS A LIE, AND IT WAS BEING TOLD TO THE CUSTOMER ─────────────
 * `subscriptions.used` is written as 0 by every insert path and NOTHING ever updates
 * it. This component received `used ?? 0` and drew an empty bar, so a customer paying
 * for ten seats was shown "0 of 10 in use" — reading as "nobody at your company has
 * touched this", when the truth is that nobody has ever measured it.
 *
 * That is worse here than anywhere else in the app: the reseller's own screens are
 * read by people who know the system, and this one is read by the customer, who has
 * no way to know the number is unmeasured. It invites them to cut seats they are
 * using.
 *
 * The rule lives in lib/subscriptions/utilisation.ts and is shared with the reseller's
 * subscriptions list, so the two can never disagree about what a zero means. A
 * measured zero IS shown, and is genuinely alarming; an unmeasured one says so.
 */
import { assessUtilisation } from "@/lib/subscriptions/utilisation";

export function SeatUsage({ used, seats, usedSyncedAt }: {
  /** Assigned users. Pass the raw column — do NOT coerce null to 0 here. */
  used: number | null | undefined;
  seats: number;
  /** When assignment was last measured. Null/absent = never. */
  usedSyncedAt?: string | null;
}) {
  const u = assessUtilisation({ seats, used, usedSyncedAt });
  const safeSeats = Math.max(seats, 0);

  if (u.level === "unknown") {
    return (
      <div>
        <div className="mb-1 flex items-baseline justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">
            Seats in use
          </span>
          <span className="text-xs font-medium text-ink-3">
            Not tracked
          </span>
        </div>
        {/* A neutral, striped bar rather than an empty one. An empty bar is read as
            "zero", which is the very claim this branch exists to avoid making. */}
        <div
          className="h-2 rounded-full bg-paper-2"
          style={{
            backgroundImage:
              "repeating-linear-gradient(45deg, transparent, transparent 4px, rgba(0,0,0,0.06) 4px, rgba(0,0,0,0.06) 8px)",
          }}
          role="img"
          aria-label={`Seat usage is not tracked on this plan. You are billed for ${safeSeats} seats.`}
        />
        <p className="mt-1 text-[10px] leading-snug text-ink-3">
          You have {safeSeats} {safeSeats === 1 ? "seat" : "seats"}. We don&apos;t currently
          track how many are assigned, so this isn&apos;t a sign they&apos;re unused.
        </p>
      </div>
    );
  }

  const safeUsed = Math.max(0, Math.min(u.pct != null ? Math.round((u.pct / 100) * safeSeats) : 0, safeSeats));
  const pct = u.pct ?? 0;
  const near = pct >= 90;

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">
          Seats in use
        </span>
        <span className="text-xs font-medium text-ink-2">
          {safeUsed} of {safeSeats}
          {near && <span className="text-amber-ink"> · near limit</span>}
        </span>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-paper-2"
        role="progressbar"
        aria-valuenow={safeUsed}
        aria-valuemin={0}
        aria-valuemax={safeSeats}
        aria-label={`${safeUsed} of ${safeSeats} seats in use`}
      >
        <div
          className={`h-full rounded-full ${near ? "bg-amber" : "bg-emerald"}`}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
    </div>
  );
}
