/**
 * InlineCell — click a table cell, edit it, done. Built for the pipeline table
 * where a rep needs to move through 50 deals without opening a drawer each time.
 *
 * Interaction rules, chosen so a mis-click can never quietly change money:
 *   • click / Enter / F2  → edit
 *   • Enter               → save
 *   • Esc                 → cancel, value restored
 *   • blur                → save (matches every spreadsheet people already know)
 *   • invalid input       → cell stays open with the reason; nothing is written
 *   • unchanged value     → no write at all
 *
 * Parsing and validation live in lib/leads/inline-edit.ts (pure + tested); this
 * component only handles the interaction. Deal Value feeds the Open Pipeline
 * KPI, which is why the two are kept apart.
 */
"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import type { ParseResult } from "@/lib/leads/inline-edit";

interface InlineCellProps<T> {
  /** Current stored value, used to seed the editor and to detect no-ops. */
  value: T;
  /** What the cell shows when it isn't being edited. */
  display: React.ReactNode;
  /** Raw text to seed the input with (formatted for editing, not for display). */
  toInput: (v: T) => string;
  /** Parse + validate. Returning `ok: false` keeps the editor open. */
  parse: (raw: string) => ParseResult<T>;
  /** Persist. Only called when the parsed value actually differs. */
  onSave: (v: T) => void | Promise<void>;
  /** `select` renders a dropdown instead of a text input. */
  options?: readonly { value: string; label: string }[];
  inputType?: "text" | "date";
  className?: string;
  /** Screen-reader label — the column header alone isn't enough on a grid. */
  ariaLabel: string;
  disabled?: boolean;
}

export function InlineCell<T>({
  value, display, toInput, parse, onSave,
  options, inputType = "text", className, ariaLabel, disabled,
}: InlineCellProps<T>) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement | HTMLSelectElement | null>(null);
  // Esc must beat blur: blur fires first, so without this flag cancelling would
  // still save.
  const cancelledRef = React.useRef(false);

  const open = () => {
    if (disabled) return;
    setDraft(toInput(value));
    setError(null);
    cancelledRef.current = false;
    setEditing(true);
  };

  React.useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      if (inputRef.current instanceof HTMLInputElement) inputRef.current.select();
    }
  }, [editing]);

  const commit = () => {
    if (cancelledRef.current) return;
    const res = parse(draft);
    if (!res.ok) { setError(res.error); return; }      // stay open, keep the old value
    setEditing(false);
    setError(null);
    if (res.value === value) return;                    // no-op → no write
    void onSave(res.value);
  };

  const cancel = () => {
    cancelledRef.current = true;
    setEditing(false);
    setError(null);
  };

  if (!editing) {
    return (
      <button
        type="button"
        onClick={open}
        onKeyDown={(e) => { if (e.key === "F2") { e.preventDefault(); open(); } }}
        disabled={disabled}
        aria-label={`${ariaLabel} — click to edit`}
        className={cn(
          "w-full text-left rounded px-1 -mx-1 py-0.5 transition-colors",
          !disabled && "hover:bg-amber-soft/40 focus:outline-none focus-visible:ring-1 focus-visible:ring-amber",
          disabled && "cursor-default",
          className,
        )}
      >
        {display}
      </button>
    );
  }

  const shared = {
    ref: inputRef as never,
    autoFocus: true,
    "aria-label": ariaLabel,
    "aria-invalid": Boolean(error),
    onBlur: commit,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      if (e.key === "Escape") { e.preventDefault(); cancel(); }
    },
    className: cn(
      "w-full rounded border bg-paper px-1 py-0.5 text-sm text-ink",
      "focus:outline-none focus:ring-1",
      error ? "border-rose focus:ring-rose" : "border-amber focus:ring-amber",
    ),
  };

  return (
    <div className="relative">
      {options ? (
        <select {...shared} value={draft} onChange={(e) => { setDraft(e.target.value); }}>
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ) : (
        <input {...shared} type={inputType} value={draft} onChange={(e) => setDraft(e.target.value)} />
      )}
      {error && (
        // §24: say what's wrong, in place, without stealing focus from the cell.
        <p role="alert" className="absolute z-20 mt-0.5 whitespace-nowrap rounded bg-rose text-paper text-3xs px-1.5 py-0.5 shadow">
          {error}
        </p>
      )}
    </div>
  );
}
