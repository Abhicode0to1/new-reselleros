/**
 * Cloudflare Turnstile on a public form (R-020, 2 Oct 2026).
 *
 * `const ts = useTurnstile();` → put `{ts.widget}` above the submit button, send
 * `headers: { ...ts.headers }`, keep submit off until `ts.ready`, call `ts.reset()` after a
 * refused submit (a token works once).
 *
 * With NEXT_PUBLIC_TURNSTILE_SITE_KEY unset (local, and production until the keys are
 * made) it renders nothing, `ready` is true and no header is sent — the server side is a
 * no-op until TURNSTILE_SECRET_KEY is set. docs/SECURITY-RUNBOOK.md §2 has the order:
 * site key in the build first, secret after that deploy is live.
 */
"use client";

import * as React from "react";

const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim() || "";
const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileApi {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  reset: (id?: string) => void;
  remove: (id: string) => void;
}
declare global {
  interface Window { turnstile?: TurnstileApi }
}

let loading: Promise<void> | null = null;
function loadScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.turnstile) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SCRIPT;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { loading = null; reject(new Error("turnstile script failed")); };
    document.head.appendChild(s);
  });
  return loading;
}

export function useTurnstile() {
  const [token, setToken] = React.useState<string | null>(null);
  /* A callback ref, not useRef: the box can appear later than the hook (a form inside an
     accordion or a dialog), and the widget must render when it does. */
  const [box, setBox] = React.useState<HTMLDivElement | null>(null);
  const idRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!SITE_KEY || !box) return;
    let cancelled = false;
    loadScript().then(() => {
      if (cancelled || !window.turnstile) return;
      idRef.current = window.turnstile.render(box, {
        sitekey: SITE_KEY,
        callback: (t: string) => setToken(t),
        "expired-callback": () => setToken(null),
        "error-callback": () => setToken(null),
      });
    }).catch(() => { /* blocked script: the server decides (it fails open if Cloudflare is down) */ });
    return () => {
      cancelled = true;
      if (idRef.current && window.turnstile) window.turnstile.remove(idRef.current);
      idRef.current = null;
    };
  }, [box]);

  return {
    required: Boolean(SITE_KEY),
    ready: !SITE_KEY || Boolean(token),
    headers: (token ? { "x-turnstile-token": token } : {}) as Record<string, string>,
    widget: SITE_KEY ? <div ref={setBox} className="my-1 min-h-[65px]" /> : null,
    reset: () => {
      setToken(null);
      if (idRef.current && window.turnstile) window.turnstile.reset(idRef.current);
    },
  };
}
