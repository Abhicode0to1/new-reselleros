"use client";

/**
 * "Scan a visiting card" / "Paste a signature" — the typing-saver at the top of
 * the customer form.
 *
 * ─── IT FILLS THE FORM; IT DOES NOT SUBMIT IT ───────────────────────────────
 * Every value lands in a normal, editable field that the operator reads before
 * saving. That is not caution for its own sake: OCR misreads characters, and the
 * customer record it feeds carries a tax identity onto every invoice.
 *
 * ─── WHAT IT WILL NOT FILL, AND WHY THAT IS THE POINT ───────────────────────
 * State, state code and country are never touched here. In India the state
 * decides CGST+SGST versus IGST, so it comes from the GSTIN the form verifies
 * against GSTN — a government source — not from a card a model squinted at. If a
 * GSTIN IS read, it is only accepted after passing the real checksum, and the
 * form's own verification then does the rest.
 *
 * So the honest claim is not "no typing". It is "the boring half is typed for
 * you, and the half that decides your tax is still verified properly".
 */

import * as React from "react";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { CardFields } from "@/lib/customers/card-fields";

/** 8 MB — the same cap the bill upload uses, for the same reason. */
const MAX_BYTES = 8 * 1024 * 1024;

export function ScanCardPanel({ onFields }: { onFields: (f: CardFields) => void }) {
  const [busy, setBusy]   = React.useState(false);
  const [note, setNote]   = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pasteOpen, setPasteOpen] = React.useState(false);
  const [pasted, setPasted]       = React.useState("");
  const fileRef = React.useRef<HTMLInputElement>(null);

  async function send(payload: Record<string, unknown>) {
    setBusy(true); setError(null); setNote(null);
    try {
      const res  = await fetch("/api/ai/scan-visiting-card", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json() as { fields?: CardFields; filled?: number; error?: string };
      if (!res.ok || json.error || !json.fields) {
        setError(json.error ?? "Couldn't read that.");
        return;
      }
      onFields(json.fields);
      const n = json.filled ?? 0;
      // Say how much was filled. "Done!" would let an operator assume the whole
      // form is handled and skip reading the fields that were left blank.
      setNote(
        n === 0
          ? "Nothing usable was found — please fill the form in by hand."
          : `${n} field${n === 1 ? "" : "s"} filled. Check them against the card, then add the GSTIN to verify with GSTN.`,
      );
      setPasteOpen(false); setPasted("");
    } catch {
      setError("That didn't go through. Try again, or fill the form by hand.");
    } finally {
      setBusy(false);
    }
  }

  async function onFile(file: File) {
    if (file.size > MAX_BYTES) {
      setError("That file is too big (max 8 MB) — try a smaller photo.");
      return;
    }
    const base64 = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload  = () => resolve((r.result as string).split(",")[1] ?? "");
      r.onerror = () => reject(new Error("read failed"));
      r.readAsDataURL(file);
    });
    await send({ fileBase64: base64, mimeType: file.type });
  }

  return (
    <Card className="bg-indigo-soft/30 border-indigo/30 p-3">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-paper">
          <Icon name="camera" size={15} className="text-indigo" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-ink">Save yourself the typing</p>
          <p className="text-2xs text-ink-3 leading-relaxed">
            Scan a visiting card or paste an email signature. Everything lands in the fields
            below for you to check — the GSTIN still gets verified with GSTN.
          </p>

          <div className="mt-2.5 flex flex-wrap gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/*,application/pdf"
              capture="environment"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = ""; }}
            />
            <Button
              type="button" variant="primary" className="h-8 px-2.5 text-[12px]"
              loading={busy} onClick={() => fileRef.current?.click()}
            >
              <Icon name="camera" size={13} /> Scan visiting card
            </Button>
            <Button
              type="button" variant="outline" className="h-8 px-2.5 text-[12px]"
              disabled={busy} onClick={() => setPasteOpen((v) => !v)}
            >
              <Icon name="copy" size={13} /> Paste signature
            </Button>
          </div>

          {pasteOpen && (
            <div className="mt-2.5">
              <textarea
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                rows={4}
                placeholder={"Paste the email or WhatsApp signature here —\nname, company, phone, email, address…"}
                className="w-full rounded-md border border-hairline bg-paper p-2 text-xs text-ink focus:outline-none focus:ring-2 focus:ring-amber/40"
              />
              <Button
                type="button" variant="primary" className="mt-1.5 h-8 px-2.5 text-[12px]"
                loading={busy} disabled={pasted.trim().length < 10}
                onClick={() => void send({ text: pasted.trim() })}
              >
                Read it
              </Button>
            </div>
          )}

          {note && (
            <p className="mt-2 text-2xs text-emerald leading-relaxed">{note}</p>
          )}
          {error && (
            <p className="mt-2 text-2xs text-amber-ink leading-relaxed">{error}</p>
          )}
        </div>
      </div>
    </Card>
  );
}
