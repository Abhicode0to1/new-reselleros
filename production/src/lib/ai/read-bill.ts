/**
 * Reading a vendor bill (PDF or photo) with Gemini vision.
 *
 * ─── WHY THIS MOVED OUT OF THE ROUTE ────────────────────────────────────────
 * The prompt and the call lived inside /api/ai/extract-bill. A second caller
 * arrived — the billing@ inbound-email path — and the choice was to copy the
 * prompt or to share it. A copied prompt drifts: one gets the fix for negative
 * credit lines, the other does not, and the two disagree about the same PDF
 * depending on how it reached the system. One prompt, one parser, two callers.
 *
 * ─── THIS FUNCTION NEVER WRITES MONEY ───────────────────────────────────────
 * It returns what the model read and nothing else. The rule the original route
 * states is worth restating because the email path makes it easier to forget:
 * these numbers feed GST input credit and the P&L, an AI can misread a total,
 * and nothing here may become a vendor_bill row without a human confirming it.
 * An emailed bill is not more trustworthy than an uploaded one — it is less,
 * because nobody was looking when it arrived.
 */
import "server-only";
import type { ExtractedBill } from "@/app/api/ai/extract-bill/sanitize";

export const BILL_PROMPT =
  "You are reading a vendor/supplier tax invoice for a cloud reseller's books. The " +
  "supplier may be INDIAN (Google Cloud/Workspace, Microsoft, Zoho, etc.) billing in " +
  "rupees with GST (CGST+SGST or IGST), OR a FOREIGN online-service provider (e.g. " +
  "Anthropic, OpenAI, Google LLC) billing in USD/other currency — these carry an India " +
  "GST registration under state code 99 (OIDAR) and may show GST as a single line. " +
  "Extract and return ONLY JSON, no prose:\n" +
  "{\n" +
  '  "vendor_name": string|null,        // the SUPPLIER who issued the bill (the seller, NOT the buyer)\n' +
  '  "vendor_gstin": string|null,       // 15-char India GST/VAT registration of the supplier if printed\n' +
  '  "bill_no": string|null,            // the invoice/bill number\n' +
  '  "bill_date": string|null,          // invoice/issue date as YYYY-MM-DD\n' +
  '  "currency": string|null,           // ISO code of the amounts on the bill: "INR", "USD", etc.\n' +
  '  "subtotal": number|null,           // taxable value BEFORE tax, in the bill\'s currency (keep decimals)\n' +
  '  "cgst": number|null,               // CGST amount (0 if not shown)\n' +
  '  "sgst": number|null,               // SGST amount (0 if not shown)\n' +
  '  "igst": number|null,               // IGST or a single GST/tax amount (0 if not shown)\n' +
  '  "total": number|null,              // grand total INCLUDING tax, in the bill\'s currency\n' +
  '  "line_items": [                    // every product/service row on the bill (empty array if none)\n' +
  '    { "description": string, "qty": number|null, "unit_price": number|null, "amount": number }\n' +
  "  ],\n" +
  '  "category_guess": string|null      // "COGS-Workspace" Google, "COGS-M365" Microsoft, "COGS-Zoho" Zoho, else "COGS-Other" or null\n' +
  "}\n" +
  "RULES: Keep amounts in the bill's OWN currency (do NOT convert). Keep decimals (e.g. 265.50). " +
  "Never invent a value — use null (or [] for line_items) if the bill does not clearly show it. " +
  "A single foreign 'GST - India' / 'VAT' line goes in igst. " +
  "CREDIT lines are NEGATIVE: a refund / 'unused time' / proration credit / discount row must have a NEGATIVE amount (and negative unit_price), e.g. -61.41 — never 0. " +
  "The line_items amounts must sum to the pre-tax subtotal (total minus tax), so keep signs correct. " +
  "vendor_name is the SELLER, never the reseller/buyer.";

/** Types Gemini vision can read. Anything else is refused before the call. */
export const READABLE_BILL_MIME = /^(image\/(png|jpe?g|webp|heic|heif)|application\/pdf)$/i;

/**
 * Ask Gemini to read a bill. Returns null on any failure — the caller decides
 * what that means, because it means different things: a route tells the operator
 * to type it in by hand, the email path leaves the message parked for review.
 */
export async function readBillWithGemini(args: {
  apiKey:   string;
  model:    string;
  mimeType: string;
  base64:   string;
}): Promise<ExtractedBill | null> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(args.model)}:generateContent?key=${args.apiKey}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{
            role: "user",
            parts: [
              { text: BILL_PROMPT },
              { inlineData: { mimeType: args.mimeType, data: args.base64 } },
            ],
          }],
          generationConfig: { responseMimeType: "application/json", temperature: 0 },
        }),
      },
    );
    if (!res.ok) {
      console.error("[read-bill] Gemini failed:", res.status, await res.text().catch(() => ""));
      return null;
    }
    const data = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) return null;
    const cleaned = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    return JSON.parse(cleaned) as ExtractedBill;
  } catch (err) {
    console.error("[read-bill] Gemini crashed:", err);
    return null;
  }
}
