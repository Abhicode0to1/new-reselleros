/**
 * Turn a tenant's stored logo URL into bytes the PDF renderer can actually draw.
 *
 * ─── WHY THIS IS NOT `<Image src={tenant.logo_url} />` ───────────────────────
 * Three reasons, and each one is a way the quote PDF stops being produced at all.
 *
 * 1. **The renderer draws PNG and JPEG. Nothing else.** `api/settings/logo/route.ts:18`
 *    accepts `image/webp` and `image/svg+xml` as well, and saves the public URL on
 *    `tenants.logo_url` either way. Handing an SVG to `<Image>` throws *inside* the render,
 *    which is inside `sendAutoQuote` — so a tenant uploading the wrong file type would stop
 *    every quote from going out, and the failure would name an image, not a logo choice.
 *
 * 2. **A remote `src` is a network fetch with no timeout, on the webhook's clock.** Quotes
 *    are rendered inside the inbound-mail path. Storage being slow must cost a logo, never
 *    the quote.
 *
 * 3. **The renderer is not the place to find out.** Resolving here means one `await` with a
 *    deadline, and every failure — 404, wrong type, oversized, offline — returns `null`, so
 *    the document falls back to the monogram it has always drawn.
 *
 * The content type the server reports is NOT trusted: it is whatever the browser put on the
 * File at upload time. The first bytes are the thing the decoder will actually read, so the
 * first bytes are what gets checked.
 *
 * Written 31 Aug 2026, after Pardeep asked why ANUTECH's logo was missing from a quotation.
 * `tenants.logo_url` had been populated since July; no PDF had ever read it.
 */

/** Storage can be slow; a quote going out cannot wait on it. */
export const LOGO_TIMEOUT_MS = 4_000;

/**
 * Upload allows 5 MB. Anything near that is a photo, not a logo, and base64 inflates it by a
 * third before it ever reaches the document.
 */
export const LOGO_MAX_BYTES = 1_500_000;

/**
 * What the bytes actually are — `null` for anything `<Image>` cannot decode.
 *
 * Magic numbers rather than the served `Content-Type`, which is only as good as the browser
 * that uploaded the file. An SVG saved as `image/png` would pass a header check and throw in
 * the renderer; it fails here.
 */
export function logoMimeFromBytes(bytes: Uint8Array): "image/png" | "image/jpeg" | null {
  if (bytes.length >= 8 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return "image/png";
  }
  /* JPEG: SOI marker. The third byte is the start of the first segment marker and is 0xFF on
     every real JPEG (JFIF, EXIF or raw). */
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  return null;
}

/** base64 without Buffer, so this file works in the browser download path too. */
export function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  /* String.fromCharCode(...bytes) blows the argument limit on anything above ~100 KB and
     throws a RangeError, so it is fed in chunks. */
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Fetch a logo and return it as a `data:` URI, or `null` for every failure.
 *
 * **This function never throws.** Its whole job is to make a logo optional: whatever goes
 * wrong — the URL is empty, the host is down, the file is an SVG, it is 4 MB — the caller
 * gets `null` and the document draws its monogram.
 */
export async function logoDataUri(
  url: string | null | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  if (!url || !/^https?:\/\//i.test(url)) return null;

  try {
    const res = await fetchImpl(url, {
      signal: AbortSignal.timeout(LOGO_TIMEOUT_MS),
      /* The public bucket serves a stable, content-addressed path (the upload stamps
         Date.now() into the filename), so a cached copy is always the current logo. */
      cache: "force-cache",
    });
    if (!res.ok) return null;

    /* Checked before reading the body where the server declares it, so an oversized file is
       refused without downloading it. Absent or lying headers are caught by the byte length
       below — this is the cheap check, not the real one. */
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > LOGO_MAX_BYTES) return null;

    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length === 0 || bytes.length > LOGO_MAX_BYTES) return null;

    const mime = logoMimeFromBytes(bytes);
    if (!mime) return null;

    return `data:${mime};base64,${toBase64(bytes)}`;
  } catch {
    /* Timeout, DNS, TLS, abort — all the same answer. A logo is never worth an exception on
       the path that sends a customer their price. */
    return null;
  }
}

/**
 * Is this value safe to hand `<Image src>`?
 *
 * The documents call this rather than testing truthiness, so an **unresolved** URL that
 * reached the props by another route degrades to the monogram instead of becoming a
 * render-time network fetch. Resolution happens in one place on purpose; this is the rail
 * that keeps it that way.
 */
export function isRenderableLogo(src: string | null | undefined): src is string {
  return typeof src === "string" && src.startsWith("data:image/");
}
