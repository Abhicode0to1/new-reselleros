/**
 * {{name}} in a campaign mail — the first name, keeping a professional title the reader
 * expects ("Dr. Kopal") and dropping a courtesy one ("Mr Sanjeev" → "Sanjeev"). Lead Finder
 * names came back as "Dr. Kopal Singhal Jain", and the old split(" ")[0] greeted "Dr.".
 */
export function greetingName(full: string | null | undefined): string {
  const parts = (full ?? "").trim().split(/\s+/).filter(Boolean);
  let title = "";
  const t = (parts[0] ?? "").replace(/\.$/, "").toLowerCase();
  if (t === "dr" || t === "ca" || t === "adv") { parts.shift(); title = { dr: "Dr. ", ca: "CA ", adv: "Adv. " }[t]; }
  else if (/^(mr|mrs|ms|shri|smt)\.?$/i.test(parts[0] ?? "")) parts.shift();
  return parts[0] ? title + parts[0] : "there";
}
