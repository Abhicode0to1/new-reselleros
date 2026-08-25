/**
 * What a transcribed voice note may and may not be used for.
 *
 * Pure. The fetching is in stt.ts and whatsapp/media.ts; the rule is here, where it can be
 * argued about against a table of cases instead of a live customer.
 *
 * ─── THE ONE THING THIS MODULE IS FOR ───────────────────────────────────────
 * A transcript is a MACHINE'S READING OF WHAT SOMEBODY SAID. It is not the customer's own
 * words the way a typed message is, and the difference is worth money on the very first
 * sentence this feature will ever see:
 *
 *     "Bhaiya 15 log ke liye Google Workspace chahiye"
 *
 * Heard as "50 log" instead of "15 log" that is 3.3× the quote — and since 25 Aug it also
 * moves the deal across a band of the volume rate card, from 0% to 3%. So one mis-heard
 * syllable changes both the quantity AND the price per seat, in a document the customer can
 * reasonably hold us to.
 *
 * `decideAutoSend` already refuses to send a quote whose TERM the app assumed rather than
 * read. A seat count the app HEARD rather than read is the same class of fact, and it gets
 * the same answer: draft it, price it, and let a person or the customer confirm the number
 * before it goes out. That is the entire safety design — there is no confidence threshold to
 * tune, because there is no confidence score worth tuning against (see `languageProbability`).
 */
import type { SttResult } from "./stt";

/**
 * Shortest transcript worth handing to the sales agent.
 *
 * Below this it is a greeting, a misfire, or the customer's dog. Running the agent on "haan"
 * produces a confident reply to nothing, which reads worse than silence — and the message is
 * still stored and still visible either way.
 */
export const MIN_USEFUL_TRANSCRIPT_CHARS = 8;

export type VoiceNoteOutcome =
  /** Hand this text to the sales agent, flagged as heard-not-written. */
  | { kind: "process"; text: string; note: string }
  /** Store it, show it, do not run the agent. */
  | { kind: "file_only"; note: string };

/**
 * Decide what to do with a voice note once it has (or has not) been transcribed.
 *
 * `null` covers every upstream failure identically on purpose — no key, provider down, clip
 * too long, empty result. From here they are the same situation: there are no words, so
 * there is nothing to answer, and a person opens the Inbox and plays the note. Splitting them
 * into different customer-facing behaviours would be inventing distinctions the customer
 * cannot see.
 */
export function decideVoiceNote(stt: SttResult | null): VoiceNoteOutcome {
  if (!stt) {
    return {
      kind: "file_only",
      note:
        "Voice note received — it could not be transcribed, so nothing was answered " +
        "automatically. Play it from the Inbox and reply by hand.",
    };
  }

  const text = stt.transcript.trim();
  if (text.length < MIN_USEFUL_TRANSCRIPT_CHARS) {
    return {
      kind: "file_only",
      note: `Voice note transcribed as "${text}" — too short to act on. Play it and reply by hand.`,
    };
  }

  const lang = stt.languageCode ? ` [${stt.languageCode}]` : "";
  return {
    kind: "process",
    text,
    note: `Voice note, transcribed${lang}: "${text}"`,
  };
}

/**
 * The line that goes on the lead's timeline and into the agent's context.
 *
 * The agent is TOLD the enquiry was spoken, and told to read the numbers back. That is not
 * decoration: restating "15 seats of Business Starter — have I got that right?" is both
 * ordinary good selling and the only correction loop that exists here. The customer is the
 * one person who knows what they actually said.
 */
export function voiceContextNote(transcript: string): string {
  return (
    "THIS ENQUIRY ARRIVED AS A VOICE NOTE and the text below is a machine transcription, " +
    "not the customer's typing. It can mishear a number — fifteen and fifty sound alike. " +
    "Before anything is priced, repeat the seat count and the product back in your reply and " +
    "ask them to confirm. Never present a transcribed number as though they wrote it.\n" +
    `Transcript: "${transcript}"`
  );
}

/**
 * Is this a WhatsApp message type worth transcribing?
 *
 * `audio` covers both a recorded voice note and a forwarded music file, and Meta does not
 * reliably distinguish them in the webhook payload. Transcribing a song wastes one API call
 * and produces a `file_only` outcome; refusing all audio would miss the actual feature. The
 * cheap mistake is the right one to make.
 */
export function isTranscribable(type: string, mediaId: string | null): boolean {
  return type === "audio" && Boolean(mediaId);
}
