/**
 * Label — accessible form label (Radix-based).
 *
 * @example
 * <Label htmlFor="email">Email address</Label>
 * <Input id="email" {...register("email")} />
 *
 * <Label required>Company name</Label>  // adds red asterisk
 */
"use client";

import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";
import { cn } from "@/lib/utils";

const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root> & {
    required?: boolean;
  }
>(({ className, children, required, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    className={cn(
      "text-xs font-medium leading-none text-ink-2 select-none",
      "peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
      className
    )}
    {...props}
  >
    {children}
    {required && (
      <span className="text-rose ml-0.5" aria-label="required">
        *
      </span>
    )}
  </LabelPrimitive.Root>
));
Label.displayName = LabelPrimitive.Root.displayName;

/**
 * Form field wrapper — Label + Input + error/helper.
 * Combines our Label + the Input's error/helper for a clean API.
 */
function FormField({
  label,
  required,
  children,
  htmlFor,
  className,
  hint,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
  htmlFor?: string;
  /** Applied to the field wrapper — e.g. grid column spans. */
  className?: string;
  /**
   * Optional right-aligned slot on the label row, for the one thing somebody reaches for
   * while looking AT this field — "Forgot?" beside Password being the case it was added
   * for. Omitted, the label row is exactly as it was.
   */
  hint?: React.ReactNode;
}) {
  return (
    <div className={className ? `space-y-1.5 ${className}` : "space-y-1.5"}>
      {hint ? (
        <div className="flex items-baseline justify-between gap-2">
          <Label htmlFor={htmlFor} required={required}>
            {label}
          </Label>
          <span className="text-xs">{hint}</span>
        </div>
      ) : (
        <Label htmlFor={htmlFor} required={required}>
          {label}
        </Label>
      )}
      {children}
    </div>
  );
}

export { Label, FormField };
