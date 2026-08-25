/**
 * Turn a telephony vendor's post-call payload into something this app can reason about.
 *
 * Pure and total: it never throws, and an unrecognised body comes back as `null` rather than
 * as a half-filled object. `support-inbound.ts` is the same shape for the same reason — a
 * normaliser that partially succeeds hands the next layer a record that looks complete.
 *
 * ─── THE OUTCOME IS READ FROM STRUCTURED ANALYSIS, NEVER FROM THE TRANSCRIPT ─
 * Whether the customer asked for a quotation is decided by the vendor's own post-call analysis
 * fields, not by this app searching the transcript for the word "quote". That was considered
 * and rejected, and the reason is one sentence: "no, please don't send me a quote" contains the
 * word. A keyword match there does not produce a slightly worse decision, it produces a
 * quotation emailed to somebody who explicitly declined one — which is the single most damaging
 * thing this feature can do unattended.
 *
 * THIS MEANS THE VENDOR AGENT MUST BE CONFIGURED. In Retell that is the agent's
 * `post_call_analysis_data`; in Vapi it is the assistant's `analysisPlan.structuredDataSchema`.
 * Either way the fields must be named exactly:
 *
 *     customer_asked_for_quote     boolean
 *     customer_asked_for_callback  boolean
 *     customer_confirmed_renewal   boolean
 *     customer_not_interested      boolean
 *     seats_discussed              number
 *
 * If they are absent every signal reads false, the call is filed with `action_taken = none`,
 * and `analysisMissing` says why on the record. That is the correct failure: a call that led to
 * nothing recorded is a call a person can read, and a call that led to a quote nobody asked for
 * is one they cannot un-send.
 */
import type { PostCallSignals, TelecallType } from "@/lib/ai/telecall";

export interface NormalisedPostCall {
  provider: "retell" | "vapi";
  providerCallId: string;
  /** From the metadata WE set when placing the call — never from a top-level body field. */
  tenantId: string | null;
  leadId: string | null;
  subscriptionId: string | null;
  callType: TelecallType | null;
  signals: PostCallSignals;
  /** True when the vendor sent no structured analysis. See the header. */
  analysisMissing: boolean;
}

/* ── unknown-safe accessors. The body is somebody else's JSON. ───────────── */

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  /* Vapi sends durations as strings often enough to be worth handling. A non-numeric string
     stays null rather than becoming NaN — NaN would sail through a `> 0` check as false and
     read like "the call was zero seconds long", which is a different claim. */
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/**
 * A truthy analysis flag.
 *
 * Models emit `true`, `"true"` and `"yes"` for the same field depending on the day, so all
 * three count. Anything else is false — including `"maybe"`, which is not consent.
 */
function flag(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "true" || s === "yes";
  }
  return false;
}

function callTypeOf(v: unknown): TelecallType | null {
  const s = str(v);
  return s === "lead_qualification" || s === "renewal_reminder" ? s : null;
}

/** `""` → null, so an empty metadata string never becomes a lookup for the empty id. */
function idOrNull(v: unknown): string | null {
  const s = str(v).trim();
  return s ? s : null;
}

function buildSignals(
  disposition: string,
  durationSec: number | null,
  transcript: string,
  summary: string,
  analysis: Record<string, unknown> | null,
): { signals: PostCallSignals; analysisMissing: boolean } {
  const a = analysis ?? {};
  return {
    analysisMissing: analysis === null || Object.keys(a).length === 0,
    signals: {
      disposition,
      durationSec,
      transcript,
      summary,
      customerAskedForQuote: flag(a.customer_asked_for_quote),
      customerAskedForCallback: flag(a.customer_asked_for_callback),
      customerConfirmedRenewal: flag(a.customer_confirmed_renewal),
      customerNotInterested: flag(a.customer_not_interested),
      seatsDiscussed: num(a.seats_discussed),
    },
  };
}

/** Retell: `{ event, call: { call_id, call_status, transcript, call_analysis, metadata } }`. */
function fromRetell(body: Record<string, unknown>): NormalisedPostCall | null {
  const call = obj(body.call);
  if (!call) return null;

  const id = str(call.call_id).trim();
  if (!id) return null;

  const meta = obj(call.metadata) ?? {};
  const analysisRaw = obj(call.call_analysis);
  const custom = analysisRaw ? obj(analysisRaw.custom_analysis_data) : null;

  /* Prefer the explicit disconnection reason: `call_status` says "ended" for a voicemail beep
     and for a ten-minute conversation alike, and those are not the same call. */
  const disposition = str(call.disconnection_reason).trim() || str(call.call_status).trim();

  const start = num(call.start_timestamp);
  const end = num(call.end_timestamp);
  const durationSec =
    num(call.duration_ms) !== null
      ? Math.round((num(call.duration_ms) as number) / 1000)
      : start !== null && end !== null && end >= start
        ? Math.round((end - start) / 1000)
        : null;

  const { signals, analysisMissing } = buildSignals(
    disposition,
    durationSec,
    str(call.transcript),
    analysisRaw ? str(analysisRaw.call_summary) : "",
    custom,
  );
  return {
    provider: "retell",
    providerCallId: id,
    tenantId: idOrNull(meta.tenant_id),
    leadId: idOrNull(meta.lead_id),
    subscriptionId: idOrNull(meta.subscription_id),
    callType: callTypeOf(meta.call_type),
    signals,
    analysisMissing,
  };
}

/** Vapi: `{ message: { type, call, artifact, analysis, endedReason, durationSeconds } }`. */
function fromVapi(body: Record<string, unknown>): NormalisedPostCall | null {
  const message = obj(body.message);
  if (!message) return null;

  const call = obj(message.call);
  const id = str(call?.id).trim() || str(message.callId).trim();
  if (!id) return null;

  const meta = obj(call?.metadata) ?? obj(message.metadata) ?? {};
  const analysisRaw = obj(message.analysis);
  const structured = analysisRaw ? obj(analysisRaw.structuredData) : null;
  const artifact = obj(message.artifact);

  const { signals, analysisMissing } = buildSignals(
    str(message.endedReason).trim(),
    num(message.durationSeconds),
    str(artifact?.transcript) || str(message.transcript),
    analysisRaw ? str(analysisRaw.summary) : "",
    structured,
  );

  return {
    provider: "vapi",
    providerCallId: id,
    tenantId: idOrNull(meta.tenant_id),
    leadId: idOrNull(meta.lead_id),
    subscriptionId: idOrNull(meta.subscription_id),
    callType: callTypeOf(meta.call_type),
    signals,
    analysisMissing,
  };
}

/**
 * Normalise whichever vendor sent this.
 *
 * Chosen by SHAPE rather than by a configured provider name: the deployment may switch vendors
 * while a call is still in flight, and the webhook for that call must still be understood.
 */
export function normalisePostCall(raw: unknown): NormalisedPostCall | null {
  const body = obj(raw);
  if (!body) return null;
  if (obj(body.call)) return fromRetell(body);
  if (obj(body.message)) return fromVapi(body);
  return null;
}

/** The vendor's own read of the customer's tone, or null. Stored, never branched on. */
export function sentimentOf(raw: unknown): string | null {
  const body = obj(raw);
  if (!body) return null;

  const retell = obj(obj(body.call)?.call_analysis);
  if (retell) {
    const s = str(retell.user_sentiment).trim();
    if (s) return s;
  }

  const vapi = obj(obj(body.message)?.analysis);
  if (vapi) {
    const structured = obj(vapi.structuredData);
    const s = str(structured?.sentiment).trim() || str(vapi.sentiment).trim();
    if (s) return s;
  }

  return null;
}
