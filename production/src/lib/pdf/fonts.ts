/**
 * Embed a font that can actually draw a rupee sign — on the server AND in the browser.
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * The base-14 PDF faces are drawn under WinAnsiEncoding, and `₹` (U+20B9) is not in WinAnsi —
 * the character was assigned in 2010, long after those encodings were fixed. So every quote,
 * invoice, receipt and payslip printed a substituted glyph where the currency should be. On
 * 31 Aug 2026 it reached a customer as `¹325/mo · ¹12,675/mo · ¹14,957/mo`.
 *
 * `pdf-money.ts` fixed that by printing "Rs", which cannot fail and needs no asset. Pardeep
 * then asked for the real symbol, and approved downloading a font for it.
 *
 * ─── A TRICK THAT DID NOT WORK, LEFT HERE ON PURPOSE ────────────────────────
 * The first attempt registered Noto Sans UNDER the built-in names — `Helvetica` and
 * `Helvetica-Bold` — so that the ~40 style declarations across the four documents would pick
 * it up untouched.
 *
 * It reported success and changed nothing. `PDF_FONT_HAS_RUPEE` came out `true`, and the
 * rendered PDF still carried `/BaseFont /Helvetica` with no `/FontFile2` and weighed 4 KB:
 * pdfkit resolves the fourteen standard names before it consults anything registered. A flag
 * saying yes while the document said no — which is the exact failure mode this whole day has
 * been about, and it was caught by reading the PDF's bytes rather than trusting the boolean.
 *
 * So the faces are registered under their OWN name and the components ask for it by constant.
 * `fonts.test.tsx` now asserts on the bytes: `/FontFile2` present, `/BaseFont /Helvetica`
 * absent. Both, because either one alone can be true while the document is still wrong.
 *
 * ─── TWO ENVIRONMENTS, AND ONE OF THEM BROKE THE BUILD ──────────────────────
 * This file first read the font from disk with `node:fs`, and the production build failed:
 *
 *     node:fs — Module build failed: UnhandledSchemeError:
 *     Reading from "node:fs" is not handled by plugins
 *
 * These documents are not server-only. `accounting/payroll/screens.tsx` is a client component
 * and reaches `PayslipPDF` through `lib/pdf/index.tsx`, so the components are compiled into a
 * browser bundle as well, and a browser bundle cannot resolve `node:fs`. (Plain `fs` is fine —
 * Next stubs it for the client.)
 *
 * That forced the better answer rather than a workaround. The two environments load a font by
 * genuinely different means, so each gets its own path:
 *
 *   SERVER   `registerPdfFonts()` — sync, a filesystem path, `existsSync` before registering.
 *   BROWSER  `ensurePdfFonts()`   — async, the public URL, a `fetch` before registering.
 *
 * The browser could have been left on "Rs". It is not, because then the PDF Pardeep downloads
 * from `/quotes` and the PDF the customer receives by mail would print the same amount two
 * different ways — a smaller version of the document-disagrees-with-itself defect that has
 * cost this project the most.
 *
 * ─── WHY A CHECK BEFORE REGISTERING, IN BOTH PATHS ──────────────────────────
 * react-pdf resolves a font's bytes at RENDER time, not at `Font.register`. So a registered-
 * but-missing file does not fail here — it fails inside the document and takes the document
 * with it. A quote that never goes out is worse than a quote with "Rs" on it. Hence
 * `existsSync` on the server and `fetch` in the browser: a missing asset degrades to the
 * built-in face, loudly, and the document still renders.
 *
 * `Dockerfile:100` copies `public/` into the runtime image, which is what puts the files where
 * both paths look — and `fonts-missing.test.ts` pins what happens the day that line changes.
 *
 * ─── AND WHY `Font` IS A PLAIN STATIC IMPORT ────────────────────────────────
 * It was `require("@react-pdf/renderer")`, to keep the 500 KB renderer out of any bundle
 * that merely touched this file. The build refused it:
 *
 *     Module not found: ESM packages (@react-pdf/renderer) need to be imported.
 *     Use 'import' to reference the package instead.
 *
 * The package is ESM-only, so `require` is not available for it — and registration has to be
 * SYNCHRONOUS, because it must finish before a document's `StyleSheet.create` reads
 * `PDF_FONT`. `await import()` cannot be used inside a sync function, so the static import
 * is the only shape left.
 *
 * The bundle argument is answered elsewhere instead: `lib/pdf/index.tsx` reaches this module
 * through `await import("./fonts")`, in the same breath as the renderer itself. So this file
 * only ever lands in the async chunk that already carries react-pdf, and the four document
 * components — the only other importers — are in that chunk too.
 *
 * Courier is deliberately NOT replaced. It renders GSTINs, document ids and IRNs — all ASCII —
 * and no money is drawn in it. Leaving it alone keeps the change to what needed changing.
 */
import { Font } from "@react-pdf/renderer";
import { setRupeeDrawable } from "./pdf-text";

/** Filenames, shared by both paths so they cannot drift apart. */
const REGULAR_FILE = "NotoSans-Regular.ttf";
const BOLD_FILE = "NotoSans-Bold.ttf";

/** Public URL — `public/fonts/` is served from `/fonts/`, and copied by `Dockerfile:100`. */
const URL_DIR = "/fonts";

/**
 * True when the embedded font is in use, so `₹` can be drawn.
 *
 * Exported for tests and diagnostics. Nothing in the app should branch on it — the documents
 * ask for `PDF_FONT`, and `pdf-text.ts` is TOLD by `setRupeeDrawable()` rather than reading
 * this. That direction matters: `pdf-text.ts` importing this file would pull the ~500 KB
 * renderer into every bundle that merely formats a rupee.
 */
export let PDF_FONT_HAS_RUPEE = false;

/** Our own family name. Registering under "Helvetica" is silently ignored — see the header. */
const FAMILY = "ResellerSans";
const FAMILY_BOLD = "ResellerSans-Bold";

/**
 * What the documents put in `fontFamily`.
 *
 * These are the built-in names until registration succeeds, so a missing font file changes
 * nothing about how a document renders — it just goes back to printing "Rs".
 *
 * ⚠️ Read at `StyleSheet.create` time, which runs when a document module is first imported.
 * Whichever value is set THEN is baked into that document's styles for the life of the
 * process. That is why each component calls `registerPdfFonts()` above its `StyleSheet.create`,
 * and why the browser path must be awaited BEFORE the component is imported — which is what
 * `lib/pdf/index.tsx` does.
 */
export let PDF_FONT = "Helvetica";
export let PDF_FONT_BOLD = "Helvetica-Bold";

let done = false;

/** The one place the flags move, so the two paths cannot set them differently. */
function adopt(regular: string, bold: string): void {
  Font.register({ family: FAMILY, src: regular });
  Font.register({ family: FAMILY_BOLD, src: bold });

  PDF_FONT_HAS_RUPEE = true;
  PDF_FONT = FAMILY;
  PDF_FONT_BOLD = FAMILY_BOLD;
  /* Told, not asked. `pdf-text.ts` must not import this module — see its comment. */
  setRupeeDrawable(true);
}

function missing(where: string): void {
  console.warn(
    `[pdf-fonts] Noto Sans not found in ${where} — documents will use the built-in ` +
    `Helvetica and print "Rs" instead of the rupee sign.`,
  );
}

/**
 * SERVER path. Sync, idempotent, never throws. Called at the top of each document component.
 *
 * A no-op in the browser: there is no filesystem there, and `ensurePdfFonts()` has already run
 * by the time a component is imported on that side.
 */
export function registerPdfFonts(): void {
  if (done) return;
  if (typeof window !== "undefined") return;
  done = true;

  /* Plain `fs`, not `node:fs` — see the header. And forward slashes rather than `path.join`,
     because `path` is one more module a browser bundle would have to resolve; Node accepts
     them on Windows. */
  /* `require`, static import nahi: static hone par webpack client bundle me `existsSync`
     naam ka export dhoondhta hai jo stub module me nahi hai, aur ek warning nikalti hai.
     (Aur us `eslint-disable` ki zaroorat nahi thi — us naam ka rule is repo me configure
     hi nahi hai, aur lint ne theek isi wajah se error diya: "Definition for rule
     '@typescript-eslint/no-var-requires' was not found".) */
  const { existsSync } = require("fs") as typeof import("fs");
  const dir = `${process.cwd()}/public/fonts`;
  const regular = `${dir}/${REGULAR_FILE}`;
  const bold = `${dir}/${BOLD_FILE}`;

  if (!existsSync(regular) || !existsSync(bold)) {
    missing(dir);
    return;
  }

  try {
    adopt(regular, bold);
  } catch (err) {
    /* Left as false, so money prints "Rs" and the documents keep rendering. */
    console.error("[pdf-fonts] could not register Noto Sans:", err);
  }
}

/**
 * BROWSER path, and the one every entry point in `index.tsx` awaits.
 *
 * On the server it simply delegates, so a caller never has to know which side it is on.
 *
 * The `fetch` is what makes registering by URL safe: react-pdf would not discover a 404 until
 * it renders, and by then the failure is the whole document. `HEAD` is enough — the renderer
 * fetches the bytes itself, from the browser's cache.
 */
export async function ensurePdfFonts(): Promise<void> {
  if (typeof window === "undefined") {
    registerPdfFonts();
    return;
  }
  if (done) return;
  done = true;

  const regular = `${URL_DIR}/${REGULAR_FILE}`;
  const bold = `${URL_DIR}/${BOLD_FILE}`;

  try {
    const [a, b] = await Promise.all([
      fetch(regular, { method: "HEAD" }),
      fetch(bold, { method: "HEAD" }),
    ]);
    if (!a.ok || !b.ok) {
      missing(URL_DIR);
      return;
    }
    adopt(regular, bold);
  } catch (err) {
    console.error("[pdf-fonts] could not register Noto Sans in the browser:", err);
  }
}
