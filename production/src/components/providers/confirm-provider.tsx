/**
 * ConfirmProvider + useConfirm — app-wide, promise-based confirmation dialog.
 *
 * WHY THIS EXISTS: native `window.confirm()` is suppressed in some embedded
 * browsers / webviews (and the desktop app's preview pane) and silently returns
 * `false`. That made destructive actions gated on it — delete, archive, reopen,
 * salary-undo — look completely dead: the click did nothing. This replaces every
 * such prompt with the design-system <Dialog>.
 *
 * Usage (minimal swap from window.confirm):
 *
 *   const confirm = useConfirm();
 *   if (await confirm({ title: "Delete this?", danger: true })) del.mutate();
 *
 * The mutation runs AFTER the dialog closes (the promise resolves on click), so
 * feedback is via the caller's own toast / loading state, exactly as before.
 */
"use client";

import * as React from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Textarea } from "@/components/ui/textarea";

export interface ConfirmOptions {
  title: string;
  /** Supporting text. `\n` is rendered as a line break. */
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Icon registry name. Defaults to "alert" (danger) or "question". */
  icon?: string;
  /** Red destructive styling on the confirm button. */
  danger?: boolean;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

/** Same dialog with a text box — the in-app replacement for window.prompt() (R-052). */
export interface AskTextOptions extends ConfirmOptions {
  /** Label above the box, e.g. "Reason (for audit)". */
  label: string;
  placeholder?: string;
}
type AskTextFn = (opts: AskTextOptions) => Promise<string | null>;

const ConfirmContext = React.createContext<ConfirmFn | null>(null);
const AskTextContext = React.createContext<AskTextFn | null>(null);

/** Returns a `confirm(opts) => Promise<boolean>` function. */
export function useConfirm(): ConfirmFn {
  const ctx = React.useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used within <ConfirmProvider>");
  return ctx;
}

/**
 * Returns `askText(opts) => Promise<string | null>`: the trimmed text, or null when
 * cancelled. Confirm stays disabled while the box is empty — every caller needs a reason.
 */
export function useAskText(): AskTextFn {
  const ctx = React.useContext(AskTextContext);
  if (!ctx) throw new Error("useAskText must be used within <ConfirmProvider>");
  return ctx;
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [opts, setOpts] = React.useState<(ConfirmOptions & Partial<AskTextOptions>) | null>(null);
  const [text, setText] = React.useState("");
  const resolverRef = React.useRef<((v: boolean | string | null) => void) | null>(null);
  const isAsk = !!opts?.label;

  const confirm = React.useCallback<ConfirmFn>((options) => {
    setOpts(options);
    return new Promise<boolean>((resolve) => { resolverRef.current = (v) => resolve(v === true); });
  }, []);

  const askText = React.useCallback<AskTextFn>((options) => {
    setText("");
    setOpts(options);
    return new Promise<string | null>((resolve) => {
      resolverRef.current = (v) => resolve(typeof v === "string" ? v : null);
    });
  }, []);

  const settle = React.useCallback((ok: boolean) => {
    const value = ok ? (opts?.label ? text.trim() : true) : (opts?.label ? null : false);
    setOpts(null);
    resolverRef.current?.(value);
    resolverRef.current = null;
  }, [opts, text]);

  return (
    <ConfirmContext.Provider value={confirm}>
    <AskTextContext.Provider value={askText}>
      {children}
      <Dialog open={!!opts} onOpenChange={(o) => { if (!o) settle(false); }}>
        <DialogContent className="md:!max-w-[440px]">
          {opts && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Icon
                    name={opts.icon ?? (opts.danger ? "alert" : "question")}
                    size={18}
                    className={opts.danger ? "text-rose" : "text-amber"}
                  />
                  {opts.title}
                </DialogTitle>
                {opts.body && (
                  <DialogDescription className="whitespace-pre-line">{opts.body}</DialogDescription>
                )}
              </DialogHeader>
              {isAsk && (
                <div className="space-y-1.5">
                  <label htmlFor="ask-text" className="block text-xs font-medium text-ink-2">{opts.label}</label>
                  <Textarea
                    id="ask-text"
                    rows={3}
                    value={text}
                    placeholder={opts.placeholder}
                    onChange={(e) => setText(e.target.value)}
                    autoFocus
                  />
                </div>
              )}
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => settle(false)}>
                  {opts.cancelLabel ?? "Cancel"}
                </Button>
                <Button
                  type="button"
                  variant={opts.danger ? "danger" : "primary"}
                  icon={opts.icon}
                  onClick={() => settle(true)}
                  disabled={isAsk && !text.trim()}
                  autoFocus={!isAsk}
                >
                  {opts.confirmLabel ?? "Confirm"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </AskTextContext.Provider>
    </ConfirmContext.Provider>
  );
}
