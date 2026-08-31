/**
 * Shrink a logo in the BROWSER, before it is ever uploaded.
 *
 * ─── THE MEASUREMENT THAT ASKED FOR THIS ────────────────────────────────────
 * ANUTECH's logo is a 940 KB PNG — an image generated at full resolution and uploaded as-is,
 * which is what anybody would do. Rendered into a quotation on 31 Aug 2026:
 *
 *     quote PDF with that logo   938,046 bytes
 *     the same PDF without it      4,540 bytes
 *
 * So every quote this app emails was about to carry a megabyte, all of it a header image
 * roughly 150pt wide. The document only ever draws it at `brandLogo`'s 36pt height.
 *
 * ─── AND IT FIXES A SECOND THING ────────────────────────────────────────────
 * `api/settings/logo/route.ts:18` accepts `image/webp` and `image/svg+xml`. The PDF renderer
 * draws **PNG and JPEG only** — `lib/pdf/logo.ts` sniffs the bytes and refuses the rest, so
 * today a tenant who uploads an SVG gets a monogram and no explanation. Re-encoding through a
 * canvas makes every accepted upload a PNG, so the file that reaches storage is one the
 * document can actually draw.
 *
 * ─── WHY IT NEVER FAILS THE UPLOAD ──────────────────────────────────────────
 * Shrinking is an optimisation, not a requirement. A browser without canvas, an image the
 * decoder rejects, a file that somehow grows — every one of those returns the ORIGINAL file
 * and lets the upload proceed. The worst case is the behaviour we already have.
 */

/** The long edge, in pixels. The PDF draws the logo 36pt tall; 512px is ~4x that at 300dpi. */
export const LOGO_MAX_EDGE = 512;

/** Below this, re-encoding is not worth the loss — the file is already small. */
export const LOGO_SHRINK_FLOOR_BYTES = 60_000;

/**
 * The renderer's two formats. Anything else has to be re-encoded to survive
 * `lib/pdf/logo.ts`'s byte check, whatever its size.
 */
const PDF_SAFE = new Set(["image/png", "image/jpeg"]);

/** Scale to fit inside a square of `maxEdge`, keeping the aspect ratio. Never scales UP. */
export function fitWithin(
  width: number, height: number, maxEdge: number = LOGO_MAX_EDGE,
): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 };
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  /* At least 1px on the short edge — a 2000x3 banner must not round to zero height, which
     canvas rejects outright. */
  return {
    width:  Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Is this file worth re-encoding at all?
 *
 * Two independent reasons, and either is enough:
 *   - the renderer cannot draw this type (webp, svg) — size is irrelevant
 *   - it is large enough that the PDF would carry it
 */
export function shouldReencode(type: string, bytes: number, longEdge: number): boolean {
  /* The document cannot draw it at any size — converting is the whole point. */
  if (!PDF_SAFE.has(type)) return true;
  /* More pixels than the document will ever use. */
  if (longEdge > LOGO_MAX_EDGE) return true;
  /* Right dimensions, heavy file — an uncompressed or 16-bit PNG. Re-encoding still pays. */
  return bytes > LOGO_SHRINK_FLOOR_BYTES;
}

/** Swap the extension so the stored filename matches what the bytes now are. */
export function asPngName(name: string): string {
  return `${name.replace(/\.[a-z0-9]+$/i, "") || "logo"}.png`;
}

/** The two browser steps, injectable so the logic above can be tested without a canvas. */
export interface ShrinkDeps {
  /** Decode a file to its pixel dimensions plus something drawable. */
  decode(file: File): Promise<{ width: number; height: number; source: CanvasImageSource }>;
  /** Draw `source` at w×h and return PNG bytes. */
  encode(source: CanvasImageSource, width: number, height: number): Promise<Blob>;
}

/**
 * Return a smaller PNG version of `file`, or `file` itself if that is not possible or not
 * worth it. **Never throws** — see the header.
 */
export async function shrinkLogo(file: File, deps: ShrinkDeps = browserDeps()): Promise<File> {
  try {
    const { width, height, source } = await deps.decode(file);
    if (!shouldReencode(file.type, file.size, Math.max(width, height))) return file;

    const target = fitWithin(width, height);
    if (target.width === 0) return file;

    const blob = await deps.encode(source, target.width, target.height);

    /* A tiny PNG logo can legitimately come out BIGGER than a well-compressed source, and an
       SVG almost always will. Keep whichever is smaller — unless the original is a type the
       document cannot draw, in which case bigger-but-renderable wins. */
    if (blob.size >= file.size && PDF_SAFE.has(file.type)) return file;

    return new File([blob], asPngName(file.name), { type: "image/png" });
  } catch {
    return file;
  }
}

/** The real canvas implementation. Only reachable in a browser. */
function browserDeps(): ShrinkDeps {
  return {
    decode: (file) => new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        /* An SVG with no intrinsic size decodes as 0x0 in some browsers; fall back to the
           box the document draws so it still rasterises to something usable. */
        const width  = img.naturalWidth  || LOGO_MAX_EDGE;
        const height = img.naturalHeight || LOGO_MAX_EDGE;
        URL.revokeObjectURL(url);
        resolve({ width, height, source: img });
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("decode failed")); };
      img.src = url;
    }),

    encode: (source, width, height) => new Promise((resolve, reject) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) { reject(new Error("no 2d context")); return; }
      ctx.imageSmoothingQuality = "high";
      /* No white fill: PNG keeps the alpha channel, and a logo drawn onto white would show a
         box on any document that is not white. */
      ctx.drawImage(source, 0, 0, width, height);
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob returned null"))), "image/png");
    }),
  };
}
