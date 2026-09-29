/**
 * The checkouts' quote notes are printed on the customer's bill (lib/pdf/build-props.ts reads
 * `quote.notes`), and they are written once, before payment. Until 28 Sep 2026 all three
 * checkouts wrote "Razorpay order pending", which was false on every paid order's PDF.
 * This scan fails if a checkout writes an order-status sentence into the notes again.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src");
const CHECKOUTS = [
  "lib/checkout/cart-checkout.ts",
  "app/api/public/checkout/workspace/route.ts",
];
/** Comments explain the history and may quote the old text; only code is checked. */
const code = (p: string) =>
  readFileSync(join(SRC, p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("checkout quote notes say nothing that stops being true after payment", () => {
  it.each(CHECKOUTS)("%s writes no 'order pending' into the customer's notes", (p) => {
    expect(code(p)).not.toMatch(/order pending/i);
  });
});
