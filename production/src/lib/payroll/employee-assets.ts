/**
 * Company property with an employee, and the exit checklist built from it.
 *
 * Everything issued is one of a fixed set of kinds so the checklist can count in the
 * owner's words ("2 devices, 1 SIM, 3 logins abhi bhi unke paas"). A login (`access`) is
 * "returned" by revoking it — the same row, `return_condition = revoked`.
 */

export type AssetKind = "laptop" | "phone" | "sim" | "id_card" | "keys" | "access" | "vehicle" | "document" | "other";

export const ASSET_KINDS: Record<AssetKind, { label: string; group: "device" | "access" | "physical"; examples: string }> = {
  laptop:   { label: "Laptop / desktop",  group: "device",   examples: "MacBook, Dell — serial no." },
  phone:    { label: "Phone / tablet",    group: "device",   examples: "IMEI" },
  sim:      { label: "SIM / number",      group: "access",   examples: "company mobile number" },
  access:   { label: "Login / access",    group: "access",   examples: "Google Workspace, GitHub, bank portal, GST portal, WhatsApp Business" },
  id_card:  { label: "ID card",           group: "physical", examples: "employee ID, visitor / building pass" },
  keys:     { label: "Keys / cards",      group: "physical", examples: "office keys, access card, locker" },
  vehicle:  { label: "Vehicle",           group: "physical", examples: "company bike / car, RC copy" },
  document: { label: "Company document",  group: "physical", examples: "cheque book, stamp, original certificates held by them" },
  other:    { label: "Other",             group: "physical", examples: "headset, monitor, bag" },
};

export type ReturnCondition = "ok" | "damaged" | "lost" | "revoked";
export const RETURN_LABEL: Record<ReturnCondition, string> = { ok: "Wapas, theek", damaged: "Wapas, damaged", lost: "Kho gaya", revoked: "Access hataya" };

export interface EmployeeAssetLike {
  id: string;
  kind: AssetKind;
  name: string;
  identifier?: string | null;
  issued_on: string;
  returned_on?: string | null;
  return_condition?: ReturnCondition | null;
  fixed_asset_id?: string | null;
}

export function isOpen(a: EmployeeAssetLike): boolean { return !a.returned_on; }

export interface Holdings {
  open: EmployeeAssetLike[];
  returned: EmployeeAssetLike[];
  counts: { devices: number; access: number; physical: number };
  /** One line: "2 devices · 1 login · 1 keys" */
  summary: string;
}

export function holdings(rows: EmployeeAssetLike[]): Holdings {
  const open = rows.filter(isOpen).sort((a, b) => a.issued_on.localeCompare(b.issued_on));
  const returned = rows.filter((a) => !isOpen(a)).sort((a, b) => (b.returned_on ?? "").localeCompare(a.returned_on ?? ""));
  const counts = { devices: 0, access: 0, physical: 0 };
  for (const a of open) counts[ASSET_KINDS[a.kind].group === "device" ? "devices" : ASSET_KINDS[a.kind].group === "access" ? "access" : "physical"] += 1;
  const bits = [counts.devices ? `${counts.devices} device${counts.devices > 1 ? "s" : ""}` : null, counts.access ? `${counts.access} login/SIM` : null, counts.physical ? `${counts.physical} item${counts.physical > 1 ? "s" : ""}` : null].filter(Boolean);
  return { open, returned, counts, summary: bits.length ? bits.join(" · ") : "kuch nahi" };
}

export interface OffboardingInput {
  employeeName: string;
  isActive: boolean;
  assets: EmployeeAssetLike[];
  /** salary advances / loans still outstanding (₹) */
  loanOutstanding: number;
  /** payslips not yet paid (count) and their net */
  unpaidSalaries: { count: number; net: number };
  /** last salary period run (YYYY-MM) or null */
  lastPeriod: string | null;
  /** documents on file by type */
  docTypes: string[];
}

export interface ChecklistItem { key: string; title: string; detail: string; status: "done" | "todo" | "warn"; }

/** The exit list — what must be true before someone is marked inactive / paid full & final. */
export function offboardingChecklist(i: OffboardingInput): { items: ChecklistItem[]; ready: boolean } {
  const h = holdings(i.assets);
  const inr = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");
  const items: ChecklistItem[] = [];
  const devices = h.open.filter((a) => ASSET_KINDS[a.kind].group === "device");
  const access = h.open.filter((a) => ASSET_KINDS[a.kind].group === "access");
  const physical = h.open.filter((a) => ASSET_KINDS[a.kind].group === "physical");
  items.push({ key: "devices", title: "Devices wapas", status: devices.length ? "todo" : "done",
    detail: devices.length ? devices.map((a) => `${a.name}${a.identifier ? ` (${a.identifier})` : ""}`).join(", ") + " — wapas lo, condition likho." : "Koi device unke paas nahi." });
  items.push({ key: "access", title: "Logins / SIM band", status: access.length ? "todo" : "done",
    detail: access.length ? access.map((a) => a.name).join(", ") + " — password reset / account suspend, SIM company ke naam wapas." : "Koi access khula nahi." });
  items.push({ key: "physical", title: "Keys / ID / documents wapas", status: physical.length ? "todo" : "done",
    detail: physical.length ? physical.map((a) => a.name).join(", ") : "Kuch baaki nahi." });
  items.push({ key: "loan", title: "Advance / loan settle", status: i.loanOutstanding > 0 ? "todo" : "done",
    detail: i.loanOutstanding > 0 ? `${inr(i.loanOutstanding)} baaki — full & final se kaato ya wapas lo.` : "Koi advance baaki nahi." });
  items.push({ key: "salary", title: "Full & final salary", status: i.unpaidSalaries.count > 0 ? "warn" : "done",
    detail: i.unpaidSalaries.count > 0 ? `${i.unpaidSalaries.count} payslip (${inr(i.unpaidSalaries.net)}) abhi paid nahi.` : i.lastPeriod ? `Aakhri salary ${i.lastPeriod} — chhodne ke mahine ki payslip LOP ke saath bana lo.` : "Koi payslip nahi." });
  const hasRelieving = i.docTypes.includes("relieving_letter");
  items.push({ key: "relieving", title: "Relieving / experience letter", status: hasRelieving ? "done" : i.isActive ? "warn" : "todo",
    detail: hasRelieving ? "Documents mein hai." : "Documents mein 'Relieving letter' upload karo — Form 16 saal ke end par alag se." });
  const ready = items.every((x) => x.status !== "todo");
  return { items, ready };
}
