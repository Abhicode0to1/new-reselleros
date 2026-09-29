"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";

export function UnsubscribeClient({ t, e, s, c }: { t: string; e: string; s: string; c: string }) {
  const [state, setState] = React.useState<"idle" | "busy" | "done" | "error">("idle");
  const [message, setMessage] = React.useState<string | null>(null);

  if (!t || !e || !s) {
    return <p className="text-ink-2">Ye link adhoora hai. Mail mein jo &ldquo;Unsubscribe&rdquo; link hai, use poora kholo.</p>;
  }

  async function confirm() {
    setState("busy");
    try {
      const res = await fetch("/api/public/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ t, e, s, c: c || undefined }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setState("error"); setMessage(j.error ?? "Kuch galat hua."); return; }
      setState("done");
    } catch {
      setState("error"); setMessage("Internet check karke dobara try karo.");
    }
  }

  if (state === "done") {
    return (
      <div className="space-y-2">
        <p className="text-lg text-ink">Ho gaya — <b>{e}</b> par ab marketing mail nahi aayenge.</p>
        <p className="text-sm text-ink-3">Invoice, renewal aur aapke order se jude zaroori mail aate rahenge.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-ink-2"><b className="text-ink">{e}</b> par offers aur marketing mail band karne hain?</p>
      <Button onClick={confirm} disabled={state === "busy"}>{state === "busy" ? "Ho raha hai…" : "Haan, unsubscribe karo"}</Button>
      {state === "error" && message && <p className="text-sm text-red-600">{message}</p>}
    </div>
  );
}
