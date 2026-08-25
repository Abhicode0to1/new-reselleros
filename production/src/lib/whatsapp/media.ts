/**
 * Downloading a media file WhatsApp told us about.
 *
 * Meta does not put the bytes in the webhook — it sends a `media_id`, and fetching it is two
 * hops: ask the Graph API for a short-lived URL, then fetch that URL with the SAME bearer
 * token. The second half is the part people get wrong: the returned lookaside URL looks
 * public and is not, and an unauthenticated fetch of it comes back as a 403 HTML page that
 * a careless caller will happily hand to a transcription API as if it were audio.
 *
 * Kept out of client.ts deliberately. That file is the SEND path and already carries the
 * credentials, the templates and the media upload; a download that fails must not be able to
 * take a customer send down with it.
 */
import { resolveWhatsAppCreds } from "./client";

const META_GRAPH_BASE = "https://graph.facebook.com/v18.0";

/** A media fetch must not hold a webhook open. Meta retries the webhook, not our patience. */
const TIMEOUT_MS = 20_000;

export interface DownloadedMedia {
  bytes: Uint8Array;
  /** What Meta says it is — passed to the transcriber rather than guessed from the bytes. */
  mime: string | null;
}

/**
 * Fetch one media file by its WhatsApp media id.
 *
 * Never throws: every caller is inside a webhook that must return 200, and a voice note we
 * could not download is a message that stays visible in the Inbox for a person to play. Null
 * is the honest answer and it is logged with the id so the failure is findable.
 */
export async function downloadWhatsAppMedia(
  tenantId: string,
  mediaId: string,
): Promise<DownloadedMedia | null> {
  const creds = await resolveWhatsAppCreds(tenantId);
  if (!creds) {
    console.error(`[whatsapp/media] no credentials for tenant ${tenantId} — cannot fetch ${mediaId}`);
    return null;
  }

  const auth = { authorization: `Bearer ${creds.accessToken}` };

  try {
    /* ── Hop 1: id → a short-lived URL ─────────────────────────────────────── */
    const metaRes = await fetch(`${META_GRAPH_BASE}/${encodeURIComponent(mediaId)}`, {
      headers: auth,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!metaRes.ok) {
      console.error(`[whatsapp/media] lookup failed for ${mediaId}:`, metaRes.status);
      return null;
    }

    const meta = (await metaRes.json()) as { url?: string; mime_type?: string };
    const url = meta.url?.trim();
    if (!url) {
      console.error(`[whatsapp/media] no url in the lookup response for ${mediaId}`);
      return null;
    }

    /* ── Hop 2: the URL, WITH the token ────────────────────────────────────
       See the header. Without the header this returns a 403 page, and a 403 page is still a
       200-shaped body to anything that only checks `res.ok` after following a redirect. */
    const fileRes = await fetch(url, {
      headers: auth,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!fileRes.ok) {
      console.error(`[whatsapp/media] download failed for ${mediaId}:`, fileRes.status);
      return null;
    }

    const bytes = new Uint8Array(await fileRes.arrayBuffer());
    if (bytes.byteLength === 0) {
      console.error(`[whatsapp/media] ${mediaId} downloaded as 0 bytes`);
      return null;
    }

    return {
      bytes,
      /* Meta's declared type first; the response header second. Both can be absent and the
         caller handles that — guessing from magic bytes here would be a decoder nobody asked
         this module to own. */
      mime: meta.mime_type?.trim() || fileRes.headers.get("content-type") || null,
    };
  } catch (err) {
    console.error(`[whatsapp/media] crashed fetching ${mediaId}:`, err);
    return null;
  }
}
