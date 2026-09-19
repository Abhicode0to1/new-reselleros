/**
 * Badge — inline status pill.
 *
 * @example
 * <Badge kind="success" dot>Paid</Badge>
 * <Badge kind="danger" dot>Overdue 14d</Badge>
 * <Badge kind="info">Trial · D5</Badge>
 */
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full text-xs font-medium border whitespace-nowrap",
  {
    variants: {
      kind: {
        muted:   "bg-paper-2 text-ink-3 border-transparent",
        success: "bg-emerald-soft text-emerald border-transparent",
        warning: "bg-amber-soft text-amber-ink border-transparent",
        danger:  "bg-rose-soft text-rose-ink border-transparent",
        info:    "bg-indigo-soft text-indigo-ink border-transparent",
        outline: "bg-transparent text-ink border-hairline-strong",
      },
      size: {
        sm: "px-1.5 py-0.5 text-3xs",
        md: "px-2 py-0.5 text-xs",
      },
    },
    defaultVariants: {
      kind: "muted",
      size: "md",
    },
  }
);

const dotVariants = cva("inline-block rounded-full flex-shrink-0", {
  variants: {
    kind: {
      muted:   "bg-ink-3",
      success: "bg-emerald",
      warning: "bg-amber",
      danger:  "bg-rose",
      info:    "bg-indigo",
      outline: "bg-ink",
    },
    size: {
      sm: "w-1 h-1",
      md: "w-1.5 h-1.5",
    },
  },
  defaultVariants: {
    kind: "muted",
    size: "md",
  },
});

/** The six looks a badge has. */
export type BadgeKind = NonNullable<VariantProps<typeof badgeVariants>["kind"]>;

/**
 * A colour name from elsewhere in the app, turned into a `kind`.
 *
 * ─── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * Several screens keep a `Record<status, "rose" | "amber" | …>` map because
 * some OTHER component on the same page takes a `tone` in that vocabulary. Those
 * maps are fine and stay. What was not fine was feeding them straight to
 * `<Badge color={…}>` — see the note on `color` below. This translates at the
 * boundary so the maps keep one definition and the badge gets a real `kind`.
 *
 * An unknown tone becomes `muted`, which is the same grey the bug produced — but
 * now it is a decision rather than an accident, and `toneToKind` is tested.
 */
export function toneToKind(tone: string | null | undefined): BadgeKind {
  switch (tone) {
    case "rose":
    case "red":
      return "danger";
    case "amber":
    case "orange":
    case "yellow":
      return "warning";
    case "emerald":
    case "green":
      return "success";
    case "indigo":
    case "info":
    case "sky":
    case "blue":
    case "violet":
      return "info";
    case "outline":
      return "outline";
    /* "slate", "grey", undefined — and anything unrecognised. */
    default:
      return "muted";
  }
}

export interface BadgeProps
  extends Omit<React.HTMLAttributes<HTMLSpanElement>, "color">,
    VariantProps<typeof badgeVariants> {
  /** Show a leading colored dot */
  dot?: boolean;
  /**
   * NOT A PROP — typed as `never` so passing it fails the build.
   *
   * ─── THE BUG THIS CLOSES ─────────────────────────────────────────────────
   * `color` is a legacy HTML attribute, so `React.HTMLAttributes<HTMLSpanElement>`
   * accepted `<Badge color="rose">` with no complaint, spread it onto the
   * `<span>` where the browser ignores it, and left `kind` undefined — which
   * defaults to `muted`. The result: **every status pill on that screen rendered
   * grey**, on ten files, for as long as the code had existed. Paid, overdue and
   * disputed all looked identical, which is the opposite of a status pill's job.
   *
   * It survived because it type-checked, so the ban is a type. Use `kind`, or
   * `toneToKind()` if you are holding a colour name.
   */
  color?: never;
}

function Badge({ className, kind, size, dot, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ kind, size }), className)} {...props}>
      {dot && <span className={dotVariants({ kind, size })} aria-hidden="true" />}
      {children}
    </span>
  );
}

export { Badge, badgeVariants };
