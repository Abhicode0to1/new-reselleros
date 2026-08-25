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

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  /** Show a leading colored dot */
  dot?: boolean;
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
