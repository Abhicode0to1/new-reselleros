/**
 * Quick add lead — what is enough to save (R-099, 1 Oct 2026).
 *
 * Pardeep: "lead ki entry simplest … world class". In this market the first thing a rep
 * has is usually a PHONE NUMBER (a missed call, a WhatsApp, a card at a counter); the
 * name comes later. So any ONE way to reach or name the person is enough: a phone with
 * 10+ digits, an email, or a name of 2+ letters. Company stays optional.
 */

export interface QuickAddInput {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
}

export const phoneDigits = (p?: string | null) => (p ?? "").replace(/\D/g, "");
const emailOk = (e?: string | null) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((e ?? "").trim());

/** Null when the lead can be saved; otherwise the one sentence the form shows. */
export function quickAddProblem(v: QuickAddInput): string | null {
  const name = (v.name ?? "").trim();
  const email = (v.email ?? "").trim();
  const digits = phoneDigits(v.phone);
  if (email && !emailOk(email)) return "That email doesn't look right.";
  if (digits && digits.length < 10) return "A phone number needs at least 10 digits.";
  if (name.length >= 2 || digits.length >= 10 || email) return null;
  return "Add a phone number, an email or a name.";
}

/** What to call the lead in the toast and the list when there is no name yet. */
export function quickAddLabel(v: QuickAddInput & { company?: string | null }): string {
  return (v.name ?? "").trim() || (v.company ?? "").trim() || (v.phone ?? "").trim() || (v.email ?? "").trim() || "New lead";
}

/** wa.me wants country code + number, digits only; a bare 10-digit Indian number gets 91. */
export function whatsappNumber(p?: string | null): string | null {
  const d = phoneDigits(p);
  if (d.length < 10) return null;
  return d.length === 10 ? `91${d}` : d.replace(/^0+/, "");
}
