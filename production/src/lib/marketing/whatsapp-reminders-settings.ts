/**
 * S28 — the WhatsApp reminders SETTINGS screen (/marketing/whatsapp/reminders): pure rules.
 *
 * The sender (whatsapp-reminders.server.ts) already decides per reminder; this file answers
 * the owner's question BEFORE the cron runs: "agar aaj reminder banta, to kya WhatsApp
 * jaata?" — per kind, in the same order the sender checks. Kept pure so the answer the page
 * shows is tested against the same gate the cron uses, not re-typed in JSX.
 */
import type { AutonomyMode } from "@/lib/ai/autonomy";
import {
  REMINDER_KINDS, REMINDER_PARAM_FIELDS, STARTER_REMINDER_TEMPLATES, parseParamMap,
  pickReminderTemplate, type ApprovedTemplate, type ReminderKind, type ReminderParamField,
  type ReminderTemplateRow, type SkipReason,
} from "./whatsapp-reminders";
import { paramCount } from "./whatsapp-broadcast";

/** One row of whatsapp_templates as the settings screen needs it. */
export interface KnownTemplate { name: string; language: string; status: string; body: string }

export type KindState =
  | "ready" | "switch_off" | "not_connected" | "dial_blocks"
  | "no_template" | "template_disabled" | "not_approved" | "bad_param_map";

export interface KindReadiness {
  state: KindState;
  /** Kind of badge the page shows. */
  tone: "success" | "warning" | "danger" | "muted";
  /** What happened + what to do next (AGENTS.md §7). */
  text: string;
}

export interface KindInput {
  kind: ReminderKind;
  switchOn: boolean;
  connected: boolean;
  dialMode: AutonomyMode;
  killSwitch: boolean;
  mapping: ReminderTemplateRow | null;
  templates: readonly KnownTemplate[];
}

/**
 * Would a reminder of this kind go out today? Same order as decideReminder(): the tenant
 * switch, then the template (mapped → switched on → approved → valid map), then the dial.
 * `connected` is checked too, because the sender logs it as `not_configured` only AFTER
 * trying — the screen can say it up front.
 *
 * The template problems are reported even while the switch is OFF, so the owner can set
 * everything up first and flip the switch last.
 */
export function kindReadiness(i: KindInput): KindReadiness {
  const approved: ApprovedTemplate[] = i.templates.map((t) => ({ name: t.name, language: t.language, status: t.status }));
  const pick = pickReminderTemplate(i.kind, i.mapping ? [i.mapping] : [], approved);

  if (!pick.ok) {
    if (pick.reason === "no_template") {
      return { state: "no_template", tone: "muted", text: "Template chuna nahi — \"Template set karo\" dabao." };
    }
    if (pick.reason === "template_disabled") {
      return { state: "template_disabled", tone: "muted", text: "Is kind ka template band hai — edit karke ON karo." };
    }
    if (pick.reason === "template_not_approved") {
      const t = i.templates.find((x) => x.name === i.mapping?.template_name && x.language === i.mapping?.language);
      return {
        state: "not_approved", tone: "warning",
        text: t
          ? `"${t.name}" (${t.language}) abhi ${t.status} hai — Meta par approve hone ke baad "Sync from Meta" dabao.`
          : `"${i.mapping?.template_name}" (${i.mapping?.language}) app ke templates me nahi hai — Meta par submit karke "Sync from Meta" dabao.`,
      };
    }
    return { state: "bad_param_map", tone: "danger", text: "Template ke {{n}} fields galat hain — edit karke theek karo." };
  }

  if (!i.connected) {
    return { state: "not_connected", tone: "warning", text: "WhatsApp Business API connect nahi hai — Settings → Integrations me jodo." };
  }
  if (i.killSwitch || i.dialMode !== "auto") {
    return {
      state: "dial_blocks", tone: "warning",
      text: i.killSwitch
        ? "Automation ka master switch band hai — /automation par chalu karo."
        : `Automation dial is kaam ke liye "${i.dialMode}" par hai — WhatsApp sirf "auto" par jaata hai. /automation par badlo.`,
    };
  }
  if (!i.switchOn) {
    return { state: "switch_off", tone: "muted", text: "Sab taiyaar hai — upar ka switch ON karte hi jaane lagega." };
  }
  return { state: "ready", tone: "success", text: "Chalu — agle cron run me reminder banta hai to WhatsApp jayega." };
}

/**
 * The {{n}} field list for the editor. In order:
 *   1. what was saved, if it still fits the body's slot count — the owner chose it;
 *   2. a starter template's own map, when the name is a starter and the count fits;
 *   3. the saved list padded / cut to the slot count.
 * Nothing is guessed for a MONEY or DATE slot: padding uses customer_name, which the owner
 * then changes, and the save is refused while the count is wrong (mappingProblem).
 */
export function defaultParamMap(
  kind: ReminderKind,
  templateName: string,
  body: string | null,
  saved: readonly ReminderParamField[] = [],
): ReminderParamField[] {
  const n = body ? paramCount(body) : null;
  if (saved.length > 0 && (n === null || saved.length === n)) return [...saved];
  const starter = STARTER_REMINDER_TEMPLATES.find((s) => s.kind === kind && s.name === templateName)
    ?? STARTER_REMINDER_TEMPLATES.find((s) => s.name === templateName);
  if (starter && (n === null || n === starter.param_map.length)) return [...starter.param_map];
  if (n === null) return [...saved];
  return Array.from({ length: n }, (_, i) => saved[i] ?? "customer_name");
}

export function isStarterReminderName(name: string): boolean {
  return STARTER_REMINDER_TEMPLATES.some((s) => s.name === name);
}

/** Why this mapping cannot be saved, or null. Body is the approved text when the app has it. */
export function mappingProblem(templateName: string, language: string, paramMap: unknown, body: string | null): string | null {
  if (!/^[a-z0-9_]+$/.test(templateName) || templateName.length > 512) {
    return "Template ka naam sirf chhote a-z, 0-9 aur _ ho sakta hai (jaise invoice_due_v1) — Meta par jo naam hai wahi likho.";
  }
  if (language.length < 2 || language.length > 10) return "Language 2–10 akshar ki ho (jaise en, hi, en_US).";
  const map = parseParamMap(paramMap);
  if (!map) return "Har {{n}} ke liye list me se ek field chuno.";
  if (body !== null) {
    const n = paramCount(body);
    if (map.length !== n) return `Template me ${n} jagah ({{n}}) hain, par ${map.length} field chune hain — dono barabar karo.`;
  }
  return null;
}

export const REMINDER_KIND_ORDER = Object.keys(REMINDER_KINDS) as ReminderKind[];
export const REMINDER_FIELD_ORDER = Object.keys(REMINDER_PARAM_FIELDS) as ReminderParamField[];

/* ─── Log ─────────────────────────────────────────────────────────────────── */

export type ReminderLogStatus = "sent" | "delivered" | "read" | "failed" | "skipped";

export const LOG_STATUS: Record<ReminderLogStatus, { label: string; tone: "success" | "info" | "warning" | "danger" | "muted" }> = {
  sent:      { label: "Sent",      tone: "info" },
  delivered: { label: "Delivered", tone: "success" },
  read:      { label: "Read",      tone: "success" },
  failed:    { label: "Failed",    tone: "danger" },
  skipped:   { label: "Skipped",   tone: "muted" },
};

export function logStatus(s: string): { label: string; tone: "success" | "info" | "warning" | "danger" | "muted" } {
  return (LOG_STATUS as Record<string, (typeof LOG_STATUS)[ReminderLogStatus]>)[s] ?? { label: s, tone: "muted" };
}

/** Why a reminder was skipped, in words the owner can act on. */
export const SKIP_REASON_TEXT: Record<SkipReason, string> = {
  disabled:              "WhatsApp reminders OFF the",
  automation_off:        "Automation dial ne roka (/automation)",
  no_template:           "Is kind ka template set nahi tha",
  template_disabled:     "Template band tha",
  template_not_approved: "Template Meta se approved nahi tha",
  bad_param_map:         "Template ke {{n}} fields galat the",
  no_phone:              "Customer ka mobile number nahi mila",
  opted_out:             "Customer ne STOP likha tha",
  already_sent:          "Ye step pehle hi bheja ja chuka",
  missing_value:         "Template ki kisi jagah ke liye value nahi thi",
  not_configured:        "WhatsApp API connect nahi thi",
};

export function skipReasonText(r: string | null): string | null {
  if (!r) return null;
  return (SKIP_REASON_TEXT as Record<string, string>)[r] ?? r;
}
