/**
 * Speech-to-text — turning a customer's WhatsApp voice note into words the agent can read.
 *
 * Provider: Sarvam AI (Saaras). NOT a new vendor and NOT a new key: `lib/voice/tts.ts` already
 * speaks to Sarvam with `SARVAM_API_KEY`, chosen there as "best Indic/Hinglish per the
 * voice-agent research". The brief offered "Sarvam AI / Deepgram Whisper"; picking the one
 * already in the stack costs nothing and avoids a second Indic-speech vendor to keep in
 * credit, in compliance, and in step. CLAUDE.md §2 — no new dependency without strong
 * justification, and there is none here.
 *
 * ─── MODE IS `codemix`, AND THAT IS THE WHOLE POINT ─────────────────────────
 * The message this exists for sounds like "Bhaiya 15 log ke liye Google Workspace chahiye,
 * kitna lagega?" — Hindi grammar, an English product name, a digit. Saaras offers several
 * output modes and they are not interchangeable downstream:
 *
 *   · `transcribe` returns native script, so the product becomes "गूगल वर्कस्पेस" and
 *     `extractEntities` — which matches catalogue names in Latin script — finds nothing.
 *   · `translate` returns English, which loses the customer's own words from the record.
 *   · `codemix` keeps English as English and Hindi as Hindi, which is how the sentence was
 *     actually spoken and what every downstream reader expects.
 *
 * STUB-FIRST, matching tts.ts and the Gemini seam: returns null when no key is set or on any
 * provider error, so the feature reports "voice not configured" instead of crashing a webhook
 * Meta is waiting on. `SARVAM_API_KEY` is NOT set on this deployment today (checked 25 Aug
 * 2026), so every voice note currently takes the null path — the message is still stored and
 * still visible, exactly as it is now.
 */

const SARVAM_STT_URL = "https://api.sarvam.ai/speech-to-text";

/** Saaras v3 — the mode parameter below is v3-only. */
const STT_MODEL = "saaras:v3";

/**
 * Longest voice note worth sending to the API.
 *
 * Sarvam's synchronous endpoint is for short clips; anything longer belongs on their batch
 * API, which is a different shape and a different failure mode. A three-minute voice note is
 * also not an enquiry — it is a conversation, and it should reach a person.
 */
export const MAX_VOICE_NOTE_BYTES = 8 * 1024 * 1024;

export interface SttResult {
  /** What was said, in the mixed script it was said in. */
  transcript: string;
  /** BCP-47 the provider detected, e.g. "hi-IN". Null when it did not say. */
  languageCode: string | null;
  /**
   * How sure the provider is about the LANGUAGE — not about the words.
   *
   * Named precisely because the difference matters and is easy to misread: a 0.99 here means
   * "this is definitely Hindi", not "these are definitely the right numbers". Nothing in this
   * codebase may treat it as transcription confidence, and lib/voice/voice-note.ts says so
   * again at the point where a seat count is read.
   */
  languageProbability: number | null;
}

function valid(key: string | null | undefined): string | null {
  const k = key?.trim();
  if (!k || k.length < 10) return null;
  return k;
}

/**
 * Transcribe one voice note. Returns null when STT is not configured or the provider failed.
 *
 * @param audio  the raw bytes as downloaded from WhatsApp (usually audio/ogg; opus)
 * @param mime   the mime WhatsApp reported, passed through so the provider can decode it
 */
export async function transcribeVoiceNote(
  audio: ArrayBuffer | Uint8Array,
  mime: string | null,
): Promise<SttResult | null> {
  const key = valid(process.env.SARVAM_API_KEY);
  if (!key) return null; // stub: not configured

  const bytes = audio instanceof Uint8Array ? audio : new Uint8Array(audio);
  if (bytes.byteLength === 0) return null;
  if (bytes.byteLength > MAX_VOICE_NOTE_BYTES) {
    console.warn(`[voice/stt] voice note is ${bytes.byteLength} bytes — too long to transcribe here`);
    return null;
  }

  try {
    const form = new FormData();
    /* WhatsApp voice notes arrive as audio/ogg with an opus codec, which Sarvam lists as
       supported. The filename is cosmetic but some multipart parsers want an extension.

       `bytes.slice()` rather than `bytes`: a Uint8Array can be backed by a SharedArrayBuffer,
       which is not a BlobPart, and TypeScript is right to refuse it. `slice` returns a copy on
       a plain ArrayBuffer. One extra copy of a few hundred kilobytes, once per voice note. */
    const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime || "audio/ogg" });
    form.append("file", blob, "voice-note.ogg");
    form.append("model", STT_MODEL);
    form.append("mode", "codemix");
    /* Auto-detect rather than assuming Hindi. An Indian B2B customer may well send the note in
       English, Tamil or Marathi, and forcing hi-IN on a Tamil clip produces confident nonsense
       rather than an error — the worst of the two failure modes. */
    form.append("language_code", "unknown");

    const res = await fetch(SARVAM_STT_URL, {
      method: "POST",
      headers: { "api-subscription-key": key },
      body: form,
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      console.error("[voice/stt] Sarvam failed:", res.status, await res.text().catch(() => ""));
      return null;
    }

    const data = (await res.json()) as {
      transcript?: string;
      language_code?: string;
      language_probability?: number;
    };

    const transcript = (data.transcript ?? "").trim();
    if (!transcript) return null;

    return {
      transcript,
      languageCode: data.language_code?.trim() || null,
      languageProbability:
        typeof data.language_probability === "number" && Number.isFinite(data.language_probability)
          ? data.language_probability
          : null,
    };
  } catch (err) {
    console.error("[voice/stt] Sarvam crashed:", err);
    return null;
  }
}
