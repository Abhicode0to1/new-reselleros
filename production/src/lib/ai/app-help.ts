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

export interface HelpAnswer { reply: string; bugDraft: BugDraft | null }

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

export function helpSystemPrompt(ctx: { pagePath: string | null; userName: string | null; role: string | null }): string {
  return [
    "You are AI Help inside ResellerOS. The person is testing the app and may be confused or may have found a bug.",
    ...APP_FACTS,
    `They are on the page: ${ctx.pagePath || "unknown"}. Their role: ${ctx.role || "unknown"}. Name: ${ctx.userName || "unknown"}.`,
    "Reply in the language they write in (Hinglish if they write Hinglish), short and practical: what the screen is for, where to click, what a field means.",
    "Never invent a feature, a setting or a menu that you are not sure exists — say you are not sure and suggest filing it as a question or a bug.",
    "When what they describe sounds like a BUG (something broken, wrong number, error, button that does nothing) or a clear improvement: if you do not yet know what they did, what happened and what they expected, ask for exactly that in one message. When you know enough, write a bugDraft.",
    "A bugDraft is written for the developer: a precise title (what is wrong, where), the actual result, the expected result, numbered steps to reproduce starting from the page, type (bug | feature | ui_improvement) and severity (critical = money/data/security wrong; high = a daily task blocked; medium = wrong but has a workaround; low = cosmetic). chatSummary: 2-3 short lines on how the chat found it.",
    "Do not say the report is filed — the person files it with a button after reading your draft. Say: 'Draft taiyaar hai — neeche dekh kar File karein.'",
    'Answer ONLY as JSON: {"reply": string, "bugDraft": null | {"title": string, "type": string, "severity": string, "actual": string, "expected": string, "steps": string[], "chatSummary": string}}',
  ].join("\n");
}

/** The chat as one user turn for the model: last HELP_MAX_MESSAGES, each capped. */
export function helpUserTurn(messages: readonly HelpMessage[]): string {
  return messages
    .slice(-HELP_MAX_MESSAGES)
    .map((m) => `${m.role === "user" ? "PERSON" : "AI HELP"}: ${m.text.slice(0, HELP_MAX_CHARS)}`)
    .join("\n\n");
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
  const d = o.bugDraft as Record<string, unknown> | null | undefined;
  if (!d || typeof d !== "object") return { reply, bugDraft: null };
  const title = str(d.title, 160);
  const actual = str(d.actual, 1200);
  if (!title || !actual) return { reply, bugDraft: null };
  const type = TYPES.includes(d.type as FeedbackType) ? (d.type as FeedbackType) : "bug";
  const severity = SEVERITIES.includes(d.severity as FeedbackSeverity) ? (d.severity as FeedbackSeverity) : "medium";
  const steps = Array.isArray(d.steps) ? d.steps.map((s) => str(s, 300)).filter(Boolean).slice(0, 12) : [];
  return {
    reply,
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
export function bugReportText(d: BugDraft, ctx: { pagePath: string | null; reporterName: string | null }): string {
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
  lines.push("", `${AI_FILED_TAG} with ${ctx.reporterName || "the reporter"}.`);
  return lines.join("\n");
}
