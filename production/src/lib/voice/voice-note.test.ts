import { describe, it, expect } from "vitest";
import {
  MIN_USEFUL_TRANSCRIPT_CHARS,
  decideVoiceNote,
  isTranscribable,
  voiceContextNote,
} from "./voice-note";
import type { SttResult } from "./stt";

const heard = (transcript: string, over: Partial<SttResult> = {}): SttResult => ({
  transcript,
  languageCode: "hi-IN",
  languageProbability: 0.98,
  ...over,
});

/** The sentence this whole feature exists for. */
const REAL_ENQUIRY = "Bhaiya 15 log ke liye Google Workspace chahiye, kitna lagega?";

describe("decideVoiceNote", () => {
  it("hands a real enquiry to the agent, with the transcript on the record", () => {
    const out = decideVoiceNote(heard(REAL_ENQUIRY));
    expect(out.kind).toBe("process");
    if (out.kind === "process") {
      expect(out.text).toBe(REAL_ENQUIRY);
      expect(out.note).toContain("15 log");
      expect(out.note, "the language belongs on the record too").toContain("hi-IN");
    }
  });

  it("files a note it could not transcribe instead of answering nothing", () => {
    /* null is every upstream failure at once — no key, provider down, clip too long. From
       here they are one situation: there are no words. */
    const out = decideVoiceNote(null);
    expect(out.kind).toBe("file_only");
    if (out.kind === "file_only") expect(out.note).toContain("could not be transcribed");
  });

  it("does not run the agent on a grunt", () => {
    /* "haan" produces a confident reply to nothing, which reads worse than silence. */
    const out = decideVoiceNote(heard("haan"));
    expect(out.kind).toBe("file_only");
    if (out.kind === "file_only") expect(out.note).toContain("too short");
  });

  it(`draws the line at ${MIN_USEFUL_TRANSCRIPT_CHARS} characters`, () => {
    expect(decideVoiceNote(heard("a".repeat(MIN_USEFUL_TRANSCRIPT_CHARS - 1))).kind).toBe("file_only");
    expect(decideVoiceNote(heard("a".repeat(MIN_USEFUL_TRANSCRIPT_CHARS))).kind).toBe("process");
  });

  it("survives a transcript that is only whitespace", () => {
    expect(decideVoiceNote(heard("   \n  ")).kind).toBe("file_only");
  });

  it("does not gate on languageProbability, because that is not word confidence", () => {
    /* A 0.4 there means "we are unsure this is Hindi", not "we are unsure of the numbers".
       Treating it as a transcription score would refuse good Hinglish — which is code-mixed
       by definition and therefore exactly where language detection is least certain. */
    const out = decideVoiceNote(heard(REAL_ENQUIRY, { languageProbability: 0.4 }));
    expect(out.kind).toBe("process");
  });

  it("copes with a provider that reports no language at all", () => {
    const out = decideVoiceNote(heard(REAL_ENQUIRY, { languageCode: null, languageProbability: null }));
    expect(out.kind).toBe("process");
    if (out.kind === "process") expect(out.note).not.toContain("[");
  });
});

describe("voiceContextNote", () => {
  it("tells the agent the numbers were HEARD, not written", () => {
    /* The correction loop. The customer is the only person who knows what they actually
       said, so the reply must read the seat count back before anything is priced. */
    const note = voiceContextNote(REAL_ENQUIRY);
    expect(note).toContain("machine transcription");
    expect(note).toContain("fifteen and fifty sound alike");
    expect(note).toContain("repeat the seat count");
  });

  it("carries the transcript itself, so the model answers the words that were said", () => {
    expect(voiceContextNote(REAL_ENQUIRY)).toContain(REAL_ENQUIRY);
  });

  it("forbids presenting a heard number as a written one", () => {
    expect(voiceContextNote("x")).toContain("Never present a transcribed number");
  });
});

describe("isTranscribable", () => {
  it("takes audio that has a media id", () => {
    expect(isTranscribable("audio", "MEDIA-1")).toBe(true);
  });

  it("ignores audio with no media id to fetch", () => {
    expect(isTranscribable("audio", null)).toBe(false);
  });

  it.each(["text", "image", "video", "document", "sticker", "reaction"])(
    "leaves %s alone",
    (type) => {
      expect(isTranscribable(type, "MEDIA-1")).toBe(false);
    },
  );
});
