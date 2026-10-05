/**
 * AI Help — the in-app chat for people testing ResellerOS (R-158, 5 Oct 2026).
 *
 * Pardeep: "app ke testing karte koi confusion ho to AI chatbot se discuss karu, aur bug
 * mile to AI proper description bana kar Report a Bug mein us user ke naam se register kar
 * de — but AI ne create kiya after discussion, ye bhi mention ho."
 *
 * Pure functions only (prompt, parsing, the report text) so the rules are tested without a
 * model. The route (api/ai/help) calls Gemini with `responseMimeType: application/json`;
 * this file decides what a valid answer is and refuses anything else.
 *
 * What the model may do: explain, ask what happened, and — once it knows enough — propose a
 * bug report. What it may NOT do: file anything. The person sees the draft and presses
 * "File this report"; the row is written by the same insert as the Report Bug dialog, under
 * their name, marked filed_via 'ai-chat'. A report nobody looked at is worse than none.
 */
import type { FeedbackSeverity, FeedbackType } from "@/lib/feedback/triage";

export interface HelpMessage { role: "user" | "assistant"; text: string }

export interface BugDraft {
  title: string;
  type: FeedbackType;
  severity: FeedbackSeverity;
  /** What happened, in the reporter's terms. */
  actual: string;
  /** What should have happened. */
  expected: string;
  /** Steps to see it again, in order. */
  steps: string[];
  /** Two or three lines on how the chat arrived at this report. */
  chatSummary: string;
}

/** checklist (R-162): what to try next on this screen, from the page scan. */
export interface HelpAnswer { reply: string; bugDraft: BugDraft | null; checklist: string[] }

/**
 * Why AI Help was asked (R-162). "chat" = the person typed; "scan" = they pressed "Check this
 * page" and the findings come with it; "error" = the app saw something break and they tapped
 * "Report it", so the trail IS the description.
 */
export type HelpMode = "chat" | "scan" | "error";

export const HELP_MAX_MESSAGES = 20;
export const HELP_MAX_CHARS = 1500;

const TYPES: readonly FeedbackType[] = ["bug", "feature", "ui_improvement"];
const SEVERITIES: readonly FeedbackSeverity[] = ["low", "medium", "high", "critical"];

/** What the app is, in a few lines, so answers are about THIS app and not a generic CRM. */
const APP_FACTS = [
  "ResellerOS is Anutech Digital's own business app (Indian reseller of Google Workspace, Microsoft 365, Zoho, domains, hosting; also builds custom software).",
  "Main areas: Today/Dashboard; Sales & Pipeline (leads, deals Kanban, enquiries, tasks, quotes); Customers; Billing (invoices with GST, payments, renewals, subscriptions, online orders); Catalog (products, subscription catalogue, packages); Accounting (books, bank, advances, expenses); Employees & Team (staff, attendance, payroll, Academy for apprentices); Marketing Hub (campaigns, ads landing pages); Projects (custom software); Settings and Integrations (Razorpay, Gemini, email).",
  "Money rules: amounts in ₹, GST 18% (CGST+SGST inside the state, IGST outside), quotes become invoices on payment, renewals raise quotes before the renewal date.",
  "There is a 'Report Bug' button in the top bar (Ctrl+Shift+B). Reports go to Admin → Feedback, where an AI triages them.",
];

export function helpSystemPrompt(ctx: { pagePath: string | null; userName: string | null; role: string | null; mode?: HelpMode }): string {
  const mode = ctx.mode ?? "chat";
  return [
    "You are AI Help inside ResellerOS. The person is testing the app and may be confused or may have found a bug.",
    ...APP_FACTS,
    `They are on the page: ${ctx.pagePath || "unknown"}. Their role: ${ctx.role || "unknown"}. Name: ${ctx.userName || "unknown"}.`,
    "Reply in the language they write in (Hinglish if they write Hinglish), short and practical: what the screen is for, where to click, what a field means.",
    "Never invent a feature, a setting or a menu that you are not sure exists — say you are not sure and suggest filing it as a question or a bug.",
    "When what they describe sounds like a BUG (something broken, wrong number, error, button that does nothing) or a clear improvement: if you do not yet know what they did, what happened and what they expected, ask for exactly that in one message. When you know enough, write a bugDraft.",
    "A bugDraft is written for the developer: a precise title (what is wrong, where), the actual result, the expected result, numbered steps to reproduce starting from the page, type (bug | feature | ui_improvement) and severity (critical = money/data/security wrong; high = a daily task blocked; medium = wrong but has a workaround; low = cosmetic). chatSummary: 2-3 short lines on how the chat found it.",
    "You may also receive WHAT THE APP RECORDED (the person's recent clicks, pages, errors and failed API calls, oldest first; lines starting !! are problems). Use it: write the steps to reproduce FROM that trail instead of asking the person what they did, and quote the exact error or failed call. Ask only what the trail cannot tell you (usually: what they expected).",
    mode === "scan"
      ? "MODE scan: the person pressed 'Check this page'. You get AUTOMATIC FINDINGS and the PAGE OUTLINE. In reply: a one-line verdict, then what is really wrong (drop findings that are harmless and say why in a few words). If a finding is a real bug, write a bugDraft for the most serious one. Always fill checklist with 4-7 short, concrete things to test next on THIS screen, taken from the outline (which button, which edge case: empty value, 0, a huge amount, another GST state, the back button, phone width)."
      : mode === "error"
        ? "MODE error: the app caught a problem (the last !! lines of the trail) and the person tapped 'Report it'. Write the bugDraft straight away from the trail — do not ask first; give your best guess of the expected result and say it is a guess. reply: one or two lines on what broke."
        : "MODE chat: answer the person. checklist may stay empty.",
    "Do not say the report is filed — the person files it with a button after reading your draft. Say: 'Draft taiyaar hai — neeche dekh kar File karein.'",
    'Answer ONLY as JSON: {"reply": string, "checklist": string[], "bugDraft": null | {"title": string, "type": string, "severity": string, "actual": string, "expected": string, "steps": string[], "chatSummary": string}}',
  ].join("\n");
}

/**
 * The chat as one user turn for the model: last HELP_MAX_MESSAGES, each capped — plus, when
 * the panel sent them (R-162), what the app recorded and what the page scan found.
 */
export function helpUserTurn(
  messages: readonly HelpMessage[],
  extra: { trail?: string | null; findings?: string | null; outline?: string | null } = {},
): string {
  const chat = messages
    .slice(-HELP_MAX_MESSAGES)
    .map((m) => `${m.role === "user" ? "PERSON" : "AI HELP"}: ${m.text.slice(0, HELP_MAX_CHARS)}`)
    .join("\n\n");
  const blocks = [chat];
  if (extra.trail) blocks.push(`WHAT THE APP RECORDED (oldest first):\n${extra.trail.slice(0, 6000)}`);
  if (extra.findings) blocks.push(`AUTOMATIC FINDINGS on this page:\n${extra.findings.slice(0, 5000)}`);
  if (extra.outline) blocks.push(`PAGE OUTLINE:\n${extra.outline.slice(0, 1500)}`);
  return blocks.join("\n\n---\n\n");
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/**
 * Validate the model's JSON. A reply is required; a bugDraft is kept only when it is
 * complete — a half report (no title, no actual result) is dropped, never filed.
 */
export function parseHelpAnswer(raw: unknown): HelpAnswer | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const reply = str(o.reply, 2000);
  if (!reply) return null;
  const checklist = Array.isArray(o.checklist) ? o.checklist.map((c) => str(c, 200)).filter(Boolean).slice(0, 8) : [];
  const d = o.bugDraft as Record<string, unknown> | null | undefined;
  if (!d || typeof d !== "object") return { reply, bugDraft: null, checklist };
  const title = str(d.title, 160);
  const actual = str(d.actual, 1200);
  if (!title || !actual) return { reply, bugDraft: null, checklist };
  const type = TYPES.includes(d.type as FeedbackType) ? (d.type as FeedbackType) : "bug";
  const severity = SEVERITIES.includes(d.severity as FeedbackSeverity) ? (d.severity as FeedbackSeverity) : "medium";
  const steps = Array.isArray(d.steps) ? d.steps.map((s) => str(s, 300)).filter(Boolean).slice(0, 12) : [];
  return {
    reply,
    checklist,
    bugDraft: { title, type, severity, actual, expected: str(d.expected, 1200), steps, chatSummary: str(d.chatSummary, 600) },
  };
}

/** The tag every AI-filed report carries — short, as asked. */
export const AI_FILED_TAG = "🤖 AI-drafted after chat";

/**
 * The text the feedback row gets: the first line is the title (that is how the Report Bug
 * dialog's rows are read), then the developer's sections, then the short AI tag with whose
 * report it is.
 */
export function bugReportText(d: BugDraft, ctx: { pagePath: string | null; reporterName: string | null; recorded?: string | null }): string {
  const lines = [
    d.title,
    "",
    `Page: ${ctx.pagePath || "—"}`,
    "",
    "What happened:",
    d.actual,
  ];
  if (d.expected) lines.push("", "What should happen:", d.expected);
  if (d.steps.length) lines.push("", "Steps to see it:", ...d.steps.map((s, i) => `${i + 1}. ${s}`));
  /* R-162: the app's own record of the last moves and errors — the developer's best clue,
     and the part no reporter writes down. */
  if (ctx.recorded) lines.push("", "What the app recorded (last steps):", ctx.recorded.slice(0, 2500));
  lines.push("", `${AI_FILED_TAG} with ${ctx.reporterName || "the reporter"}.`);
  return lines.join("\n");
}
