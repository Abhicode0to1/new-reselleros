/**
 * A field that corrects as you type, formats when you leave, and says where it stands.
 *
 * ─── WHY A HOOK AND NOT A COMPONENT ─────────────────────────────────────────
 * The forms in this app are React Hook Form in some places and plain useState in others,
 * and they use three different Input wrappers. A component would have to own the value and
 * would therefore have to be adopted wholesale; a hook returns props you spread onto
 * whatever input is already there, so a form can gain this one field at a time.
 *
 * ─── THE CONTRACT IT ENFORCES ───────────────────────────────────────────────
 * The `live` rule runs on every keystroke and may only ever REMOVE characters that can
 * never belong (see lib/forms/poka-yoke.ts). The `commit` rule runs on blur and is the
 * only place a value is allowed to gain characters — spaces in a phone number, commas in
 * an amount. Formatting mid-type is what moves the caret out from under the operator's
 * finger, and it is the single most common way a "smart" field becomes a worse one.
 */
"use client";

import * as React from "react";
import type { FieldCheck } from "@/lib/forms/poka-yoke";

export interface SmartFieldRules {
  /** Safe on every keystroke. Removes only; never inserts. */
  live:    (raw: string) => string;
  /** Applied on blur — the pretty form. Optional: not every field has one. */
  commit?: (raw: string) => string;
  /** Never changes the value. Drives the pill. */
  check:   (raw: string) => FieldCheck;
}

export interface SmartField {
  value: string;
  check: FieldCheck;
  /** Spread onto the input. */
  inputProps: {
    value: string;
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    onBlur: () => void;
  };
  /** For a paste or a programmatic fill — runs `live`, skips `commit`. */
  set: (raw: string) => void;
  /** True once the value is finished and correct. */
  isValid: boolean;
}

export function useSmartField(
  initial: string,
  rules: SmartFieldRules,
  /** Called with every accepted value, so a parent form can keep its own state. */
  onValue?: (v: string) => void,
): SmartField {
  const [value, setValue] = React.useState(() => rules.live(initial));

  /* Kept in a ref so the callbacks below do not have to change identity on every render
     of a parent that passes an inline arrow — which is every parent. */
  const onValueRef = React.useRef(onValue);
  onValueRef.current = onValue;

  const apply = React.useCallback((raw: string) => {
    const next = rules.live(raw);
    setValue(next);
    onValueRef.current?.(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onChange = React.useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => apply(e.target.value),
    [apply],
  );

  const onBlur = React.useCallback(() => {
    if (!rules.commit) return;
    setValue((current) => {
      const pretty = rules.commit!(current);
      /* Only announce a real change. Blur fires on every tab-through and an unconditional
         callback would mark a form dirty for a field nobody edited. */
      if (pretty !== current) onValueRef.current?.(pretty);
      return pretty;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const check = rules.check(value);

  return {
    value,
    check,
    inputProps: { value, onChange, onBlur },
    set: apply,
    isValid: check.tone === "ok",
  };
}
