/**
 * AcceptQuoteButton — customer-side accept action for a project quotation.
 * Posts to the public accept API, then reloads to show the accepted state.
 */
"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";

export function AcceptQuoteButton({ projectId, token }: { projectId: string; token: string }) {
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const accept = async () => {
    setLoading(true);
    setError(null);
    try {
      /* Token ke bina accept 404 hai — page tak wahi pahunchta hai jiske paas
         token tha, to yahan se aage bhejna surakshit hai. */
      const res = await fetch(`/api/public/project-quote/${projectId}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ t: token }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? "Could not accept");
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setLoading(false);
    }
  };

  return (
    <div>
      <Button variant="primary" size="lg" icon="check" loading={loading} onClick={accept}>
        Accept quotation
      </Button>
      {error && <p className="text-sm text-rose mt-2">{error}</p>}
    </div>
  );
}
