/**
 * {{name}} in a campaign mail — the first name, keeping a professional title the reader
 * expects ("Dr. Kopal") and dropping a courtesy one ("Mr Sanjeev" → "Sanjeev"). Lead Finder
 * names came back as "Dr. Kopal Singhal Jain", and the old split(" ")[0] greeted "Dr.".
 * No name → null; see fillName for what the mail then says.
 */
export function greetingName(full: string | null | undefined): string | null {
  const parts = (full ?? "").trim().split(/\s+/).filter(Boolean);
  let title = "";
  const t = (parts[0] ?? "").replace(/\.$/, "").toLowerCase();
  if (t === "dr" || t === "ca" || t === "adv") { parts.shift(); title = { dr: "Dr. ", ca: "CA ", adv: "Adv. " }[t]; }
  else if (/^(mr|mrs|ms|shri|smt)\.?$/i.test(parts[0] ?? "")) parts.shift();
  return parts[0] ? title + parts[0] : null;
}

/** What {{name}} becomes when we do not know the person. */
export const NO_NAME = "Sir/Ma'am";

/**
 * Put the name into a template. Without a name, "Namaste {{name}} ji" must not become
 * "Namaste there ji" (29 Sep preview) or "Namaste Sir/Ma'am ji": the "ji" after it goes.
 */
export function fillName(template: string, full: string | null | undefined): string {
  const name = greetingName(full);
  if (name) return template.replace(/\{\{name\}\}/g, name);
  return template.replace(/\{\{name\}\}(\s+ji\b)?/gi, NO_NAME);
}
