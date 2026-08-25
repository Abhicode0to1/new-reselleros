/**
 * AddLeadForm — modal dialog to create OR edit a lead.
 *
 * - When `editingLead` is null/undefined → creates a new lead
 * - When `editingLead` is a Lead object  → pre-fills + updates that lead
 *
 * Validates via Zod + React Hook Form.
 *
 * @example
 * // create
 * <AddLeadForm open={open} onOpenChange={setOpen} />
 *
 * // edit
 * <AddLeadForm open={open} onOpenChange={setOpen} editingLead={lead} />
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { useForm } from "react-hook-form";
import { FieldPill } from "@/components/ui/field-pill";
import { SmartPaste } from "@/components/shared/smart-paste";
import {
  liveGstin, checkGstin, livePhone, commitPhone, checkPhone, liveEmail, checkEmail,
  liveMoney, commitMoney, parseMoney, checkMoney, gstinState,
} from "@/lib/forms/poka-yoke";
import { useDraftGuard } from "@/lib/hooks/useDraftGuard";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useCreateLead, useUpdateLead, useLeads } from "@/lib/queries/leads";
import { normPhone, normCompany } from "@/lib/leads/duplicates";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import type { Lead, LeadPriority } from "@/lib/supabase/database.types";

const STAGES = [
  { value: "new",     label: "New" },
  { value: "contact", label: "Contacted" },
  { value: "demo",    label: "Demo Done" },
  { value: "trial",   label: "Trial Active" },
  { value: "quote",   label: "Quote Sent" },
  { value: "won",     label: "Won" },
  { value: "lost",    label: "Lost" },
] as const;

// Quote-first funnel. A lead lives in the Leads inbox (pre-quote) until a
// quotation is sent; only then does it become a deal and unlock Demo/Trial/Won.
//   Pre-quote (Leads):  New, Contacted, Lost
//   Post-quote (Deals): Quote Sent, Demo Done, Trial Active, Won, Lost
const RAW_LEAD_STAGE_VALUES   = ["new", "contact", "lost"] as const;
const POST_QUOTE_STAGE_VALUES = ["quote", "demo", "trial", "won", "lost"] as const;

const SOURCES = [
  { value: "manual",            label: "Added manually" },
  { value: "buy-workspace-v2",  label: "Buy Workspace page" },
  { value: "csv",               label: "CSV import" },
  { value: "whatsapp",          label: "WhatsApp" },
  { value: "referral",          label: "Referral" },
  { value: "tele-calling",      label: "Tele calling" },
  { value: "google-ads",        label: "Google Ads" },
] as const;

const PLANS = [
  "Google Workspace Business Starter",
  "Google Workspace Standard",
  "Google Workspace Plus",
  "Google Workspace Enterprise",
  "Microsoft 365 Business Basic",
  "Microsoft 365 Business Standard",
  "Microsoft 365 Business Premium",
  "Zoho Workplace Standard",
  "Zoho Workplace Professional",
  "Plus + Voice add-on",
  "Custom / Mixed",
] as const;

/**
 * Typical Indian reseller MRP per seat per month (INR).
 * Used to auto-calculate annual deal value = price × seats × 12.
 * Plans not in this map (e.g. Custom) skip auto-calculation.
 */
const PLAN_PRICE_PER_SEAT_PM: Record<string, number> = {
  "Google Workspace Business Starter":          136,
  "Google Workspace Standard":         736,
  "Google Workspace Plus":            1380,
  "Google Workspace Enterprise":      2000,
  "Microsoft 365 Business Basic":      145,
  "Microsoft 365 Business Standard":   735,
  "Microsoft 365 Business Premium":   1470,
  "Zoho Workplace Standard":           105,
  "Zoho Workplace Professional":       315,
  "Plus + Voice add-on":              1800,
};

// Plan + seats + value are OPTIONAL on the lead schema.
//   • Filled → the lead enters the Deal Pipeline as a qualified deal.
//   • Empty  → the lead lives in the Lead Inbox awaiting qualification.
// This matches the conceptual split: raw inquiries (Inbox) vs qualified
// opportunities (Pipeline). Same DB table, different filter cuts.
/**
 * The three steps, and which fields each one owns.
 *
 * `STEP_FIELDS` drives per-step validation. Running the whole schema on "Next" would
 * red-flag a field two steps ahead that nobody has reached — the same "shouting at an
 * untouched field" that the validation pills exist to prevent.
 */
const STEP_LABELS = ["Contact", "Product & seats", "Review"] as const;
const STEP_FIELDS = [
  ["company", "contact_name", "contact_email", "contact_phone", "gstin"],
  ["plan", "seats", "value", "stage", "source", "priority", "subscription_type",
   "follow_up_date", "owner_id", "notes"],
] as const;

/** A step's fields, or nothing. Kept as a component so the wrapper div is consistent. */
function Step({ show, children }: { show: boolean; children: React.ReactNode }) {
  if (!show) return null;
  return <div className="space-y-4">{children}</div>;
}

/**
 * One line on the review step.
 *
 * An unset field SAYS "not set" rather than showing a gap — a blank row reads as a
 * rendering fault, and an operator cannot tell it apart from a value that failed to load.
 */
function Review({ label, value, mono, note }: {
  label: string; value?: string | null; mono?: boolean; note?: string;
}) {
  const v = (value ?? "").trim();
  return (
    <div className="min-w-0">
      <dt className="text-3xs uppercase tracking-wider text-ink-3">{label}</dt>
      {v ? (
        <dd className={cn("break-words text-[13px] font-medium text-ink", mono && "font-mono")}>
          {v}{note && <span className="ml-1 font-sans text-2xs font-normal text-ink-3">· {note}</span>}
        </dd>
      ) : (
        <dd className="text-[12px] italic text-ink-3">not set</dd>
      )}
    </div>
  );
}

const PRIORITY_OPTIONS: { value: LeadPriority; label: string; dot: string }[] = [
  { value: "low",    label: "Low",    dot: "bg-slate"   },
  { value: "medium", label: "Medium", dot: "bg-amber"   },
  { value: "high",   label: "High",   dot: "bg-rose"    },
];

// Helper: build an optional integer field that treats empty string / null /
// NaN as undefined. Raw leads leave seats / value blank; without this
// preprocess, Zod's `coerce.number()` turns "" into NaN and fails validation
// even though the field is .optional().
const optionalIntField = (max: number) =>
  z.preprocess(
    (v) => {
      if (v === "" || v === null || v === undefined) return undefined;
      if (typeof v === "number" && Number.isNaN(v)) return undefined;
      /* Commas, spaces and a rupee sign stripped before coercion. Two reasons, and the
         second is the one that bites: a value pasted straight out of a spreadsheet reads
         "₹1,76,640", and `z.coerce.number()` turns that into NaN and rejects a number the
         operator can plainly see in the box. It also lets the field format itself with
         Indian grouping on blur without the formatting breaking its own validation. */
      if (typeof v === "string") {
        const digits = v.replace(/[^0-9.-]/g, "");
        return digits === "" ? undefined : digits;
      }
      return v;
    },
    z.coerce.number().int().min(0).max(max).optional(),
  );

const schema = z.object({
  company:       z.string().min(2, "Company name is required"),
  contact_name:  z.string().optional(),
  contact_email: z.string().email("Invalid email").optional().or(z.literal("")),
  contact_phone: z.string().optional(),
  gstin:         z.string().optional().or(z.literal("")),
  plan:          z.string().optional().or(z.literal("")),
  seats:         optionalIntField(10000),
  value:         optionalIntField(100_000_000),
  stage:         z.enum(["new", "contact", "demo", "trial", "quote", "won", "lost"]),
  source:        z.string(),
  priority:      z.enum(["low", "medium", "high"]),
  follow_up_date: z.string().optional().or(z.literal("")),
  owner_id:      z.string().optional().or(z.literal("")),
  subscription_type: z.enum(["fresh", "switch"]).optional().or(z.literal("")),
  notes:         z.string().optional(),
});

type FormData = z.infer<typeof schema>;

interface AddLeadFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When provided, the form pre-fills + updates this lead instead of creating new. */
  editingLead?: Lead | null;
  /** Default stage for a NEW record. Passed as a deal stage (e.g. "quote") when
   *  invoked from the Deal Pipeline so "Add Deal" actually lands in the pipeline. */
  defaultStage?: FormData["stage"];
}

export function AddLeadForm({ open, onOpenChange, editingLead, defaultStage }: AddLeadFormProps) {
  const router    = useRouter();
  const createLead = useCreateLead();
  const updateLead = useUpdateLead();
  const isEditing  = !!editingLead;
  const { data: me } = useCurrentUser();

  // Active users in the current tenant — drives the Owner dropdown so sales
  // teams can hand off / claim leads. RLS scopes to caller's tenant.
  const { data: tenantUsers } = useQuery({
    enabled: open,
    queryKey: ["tenant", "active-users", me?.tenantId],
    queryFn: async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("users")
        .select("id, full_name, email, role")
        .eq("is_active", true)
        .order("full_name");
      if (error) throw error;
      return data ?? [];
    },
    staleTime: 5 * 60 * 1000,
  });

  const [stage, setStage] = React.useState<FormData["stage"]>(
    (editingLead?.stage as FormData["stage"]) ?? "new",
  );
  const [source, setSource]     = React.useState<string>(editingLead?.source ?? "manual");
  const [plan, setPlan]         = React.useState<string>(editingLead?.plan ?? "");
  const [priority, setPriority] = React.useState<LeadPriority>((editingLead?.priority as LeadPriority) ?? "medium");
  const [ownerId, setOwnerId]   = React.useState<string>(editingLead?.owner_id ?? "");

  // Contacts Picker API support detection. Currently Android Chrome / Edge
  // mobile only; iOS Safari + Firefox + desktop all fall back to manual.
  // Spec: https://w3c.github.io/contact-picker/
  const [contactsApiAvailable, setContactsApiAvailable] = React.useState(false);
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    setContactsApiAvailable(
      // @ts-expect-error — Contacts Picker not in lib.dom.d.ts yet
      Boolean(navigator.contacts && typeof navigator.contacts.select === "function" && window.ContactsManager),
    );
  }, []);

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    getValues,
    trigger,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: editingLead
      ? {
          company:        editingLead.company,
          contact_name:   editingLead.contact_name  ?? "",
          contact_email:  editingLead.contact_email ?? "",
          contact_phone:  editingLead.contact_phone ?? "",
          gstin:          editingLead.gstin         ?? "",
          plan:           editingLead.plan          ?? "",
          // Display null seats/value as blank (not 1/0) so raw leads being
          // edited don't suddenly look like real deals with phantom numbers.
          seats:          editingLead.seats         ?? undefined,
          value:          editingLead.value         ?? undefined,
          stage:         (editingLead.stage  as FormData["stage"]) ?? "new",
          source:         editingLead.source        ?? "manual",
          priority:      (editingLead.priority as LeadPriority) ?? "medium",
          follow_up_date: editingLead.follow_up_date ?? "",
          owner_id:       editingLead.owner_id      ?? "",
          subscription_type: editingLead.subscription_type ?? "",
          notes:          editingLead.notes         ?? "",
        }
      : {
          stage:    defaultStage ?? "new",
          source:   "manual",
          priority: "medium",
          // Seats/value intentionally left blank for raw leads. They get
          // pre-filled with sensible defaults (10 seats + auto-calc) only
          // when the user picks a plan — see the useEffect below.
        },
  });

  // Flags the workspace tab while this form holds unsaved input, so closing
  // it asks first and the 8-tab limit cannot evict it silently. isDirty is
  // React Hook Form's own comparison against defaultValues, so re-typing the
  // original value correctly counts as clean.
  useDraftGuard(isDirty && !isSubmitting);

  /* ── Progressive disclosure ──────────────────────────────────────────────
     Steps are for CREATING a lead only. Somebody who opened this sheet to correct one
     phone number should not be walked through a wizard to reach it, so an edit keeps
     the single long form it has always had. */
  const useSteps = !isEditing;
  const [step, setStep] = React.useState(1);
  React.useEffect(() => { if (open) setStep(1); }, [open]);

  const watchedSeats = watch("seats");

  /* The money box's DISPLAY string, kept apart from the form's numeric value — see the
     comment on the field itself. Seeded from the form so an edit opens with the existing
     amount already grouped, and re-seeded whenever the auto-calculation writes one. */
  const watchedValue = watch("value");
  const [valueText, setValueText] = React.useState("");
  React.useEffect(() => {
    setValueText((current) =>
      /* Only when they disagree, so this never fights the operator mid-keystroke: while
         typing "1766" the form already holds 1766 and the two agree. */
      parseMoney(current) === (watchedValue ?? null) ? current
        : watchedValue == null ? "" : commitMoney(String(watchedValue)),
    );
  }, [watchedValue]);

  // ── Duplicate warning ──────────────────────────────────────────────
  // As the operator types company / phone, surface any EXISTING lead that
  // already matches — so they open it instead of creating a second record.
  // Prevention beats cleanup. Skips the lead being edited. Non-blocking:
  // it's a heads-up with a link, never a hard stop.
  const { data: allLeads } = useLeads();
  const wCompany = watch("company");
  const wPhone   = watch("contact_phone");
  const dupMatch = React.useMemo(() => {
    if (!allLeads || allLeads.length === 0) return null;
    const p = normPhone(wPhone);
    const c = normCompany(wCompany);
    if (!p && !c) return null;
    return allLeads.find(
      (l) =>
        l.id !== editingLead?.id &&
        ((p && normPhone(l.contact_phone) === p) || (c && normCompany(l.company) === c)),
    ) ?? null;
  }, [allLeads, wPhone, wCompany, editingLead?.id]);

  /**
   * Open the native Contacts Picker (Android Chrome / Edge Mobile only).
   * User selects ONE contact → we autofill name + phone + email into the
   * form. On iOS Safari / unsupported browsers the button is hidden by
   * the contactsApiAvailable gate, so this never runs.
   */
  const pickContact = React.useCallback(async () => {
    try {
      const props = ["name", "tel", "email"] as const;
      // @ts-expect-error — Contacts Picker not in lib.dom.d.ts yet
      const contacts = await navigator.contacts.select(props, { multiple: false }) as Array<{
        name?:  string[];
        tel?:   string[];
        email?: string[];
      }>;
      if (!contacts || contacts.length === 0) return;  // user cancelled

      const c     = contacts[0];
      const name  = c.name?.[0]  ?? "";
      const phone = c.tel?.[0]   ?? "";
      const email = c.email?.[0] ?? "";

      if (name)  setValue("contact_name",  name,  { shouldDirty: true });
      if (phone) setValue("contact_phone", phone, { shouldDirty: true });
      if (email) setValue("contact_email", email, { shouldDirty: true });
    } catch (err) {
      // User denied permission, or browser bailed. Silent — button is still
      // there as a no-op so they fall back to manual entry.
      console.warn("[contacts-picker] failed:", err);
    }
  }, [setValue]);

  // Auto-calculate annual deal value when plan or seats change.
  // Formula: pricePerSeatPerMonth × seats × 12
  // Skips auto-calc for "Custom / Mixed" or unknown plans.
  React.useEffect(() => {
    const pricePerSeat = PLAN_PRICE_PER_SEAT_PM[plan];
    if (!pricePerSeat || !watchedSeats || watchedSeats < 1) return;
    const annualValue = Math.round(pricePerSeat * watchedSeats * 12);
    setValue("value", annualValue, { shouldValidate: true });
  }, [plan, watchedSeats, setValue]);

  // Quote-first funnel: Demo/Trial/Quote/Won are reachable ONLY after a quote
  // is sent. So a pre-quote lead (New/Contacted, or a brand-new one) may only
  // be set to New / Contacted / Lost here — sending a quote (not this form) is
  // what crosses the gate into the deal stages. A lead already past the gate
  // (stage quote/demo/trial/won/lost) gets the deal-stage set.
  const availableStages = React.useMemo(() => {
    // Deal stages are allowed when editing a lead already past the quote gate, OR
    // when adding a NEW record straight into the Deal Pipeline (defaultStage is a
    // deal stage). Otherwise a raw lead can only be New / Contacted / Lost.
    const dealMode = editingLead
      ? (POST_QUOTE_STAGE_VALUES as readonly string[]).includes(editingLead.stage)
      : !!defaultStage && (POST_QUOTE_STAGE_VALUES as readonly string[]).includes(defaultStage);
    const allowed = dealMode ? POST_QUOTE_STAGE_VALUES : RAW_LEAD_STAGE_VALUES;
    return STAGES.filter((s) => (allowed as readonly string[]).includes(s.value));
  }, [editingLead, defaultStage]);

  // Keep the selected stage within the allowed set (e.g. if it drifted out of
  // range for this lead's funnel position).
  React.useEffect(() => {
    if (!availableStages.some((s) => s.value === stage)) {
      const fallback = (availableStages[0]?.value ?? "new") as FormData["stage"];
      setStage(fallback);
      setValue("stage", fallback, { shouldDirty: true });
    }
  }, [availableStages, stage, setValue]);

  // Seats / value gate on plan, same conceptual pattern as stage gating:
  //   • Plan empty (raw lead) → keep seats / value blank. Sales rep is just
  //     capturing "met someone at expo" — no commercial detail yet. Leaving
  //     these blank prevents the leads table from showing phantom "10 seats
  //     · ₹1,00,000" on every raw inbox row.
  //   • Plan picked (qualified deal) → pre-fill 10 seats. The existing
  //     auto-calc effect below then computes the annual value from the
  //     catalog price × 12. User can override either.
  // Editing existing leads is unaffected — the reset() block above carries
  // whatever values the lead was saved with.
  React.useEffect(() => {
    if (editingLead) return;
    if (plan) {
      const currentSeats = getValues("seats");
      if (!currentSeats || Number.isNaN(currentSeats) || currentSeats < 1) {
        setValue("seats", 10, { shouldDirty: true });
      }
    } else {
      // Plan went back to empty — clear seats / value so the raw lead
      // doesn't carry phantom numbers from a previous plan selection.
      setValue("seats", undefined as unknown as number, { shouldDirty: true });
      setValue("value", undefined as unknown as number, { shouldDirty: true });
    }
  }, [plan, editingLead, getValues, setValue]);

  // Reset form when modal closes OR when editingLead changes (re-fills defaults).
  React.useEffect(() => {
    if (!open) {
      reset();
      setStage("new");
      setSource("manual");
      setPlan("");
      setPriority("medium");
      // For a fresh "Add lead" the owner defaults to the currently logged-in
      // user — sales reps own their own intake by default. They can re-assign.
      setOwnerId(me?.userId ?? "");
      return;
    }
    if (editingLead) {
      reset({
        company:        editingLead.company,
        contact_name:   editingLead.contact_name  ?? "",
        contact_email:  editingLead.contact_email ?? "",
        contact_phone:  editingLead.contact_phone ?? "",
        gstin:          editingLead.gstin         ?? "",
        plan:           editingLead.plan          ?? "",
        seats:          editingLead.seats         ?? undefined,
        value:          editingLead.value         ?? undefined,
        stage:         (editingLead.stage  as FormData["stage"]) ?? "new",
        source:         editingLead.source        ?? "manual",
        priority:      (editingLead.priority as LeadPriority) ?? "medium",
        follow_up_date: editingLead.follow_up_date ?? "",
        owner_id:       editingLead.owner_id      ?? "",
        subscription_type: editingLead.subscription_type ?? "",
        notes:          editingLead.notes         ?? "",
      });
      setStage((editingLead.stage as FormData["stage"]) ?? "new");
      setSource(editingLead.source ?? "manual");
      setPlan(editingLead.plan ?? "");
      setPriority((editingLead.priority as LeadPriority) ?? "medium");
      setOwnerId(editingLead.owner_id ?? "");
    } else {
      // New-lead default: owner = current user.
      setOwnerId(me?.userId ?? "");
    }
  }, [open, editingLead, reset, me?.userId]);

  /**
   * ─── MISTAKE-PROOFING ONE REGISTERED FIELD ────────────────────────────────
   * Returns `register()`'s props with the keystroke and blur rules layered on top:
   * `live` cleans on every keystroke and may only ever REMOVE characters, `commit`
   * formats on blur and is the only place a value may gain any. Doing it the other way
   * round — formatting mid-type — moves the caret out from under the operator's finger
   * and is how a "smart" field becomes a worse one. See lib/forms/poka-yoke.ts.
   *
   * `shouldDirty` is passed so a cleaned value still marks the form dirty; without it the
   * unsaved-changes guard would let a paste-and-close lose the paste.
   */
  const smart = (
    field: "contact_email" | "contact_phone" | "gstin",
    rules: { live: (s: string) => string; commit?: (s: string) => string },
  ) => {
    const reg = register(field);
    return {
      ...reg,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
        setValue(field, rules.live(e.target.value), { shouldDirty: true, shouldValidate: false });
      },
      onBlur: (e: React.FocusEvent<HTMLInputElement>) => {
        if (rules.commit) {
          const pretty = rules.commit(e.target.value);
          if (pretty !== e.target.value) setValue(field, pretty, { shouldDirty: true });
        }
        return reg.onBlur(e);
      },
    };
  };

  const onSubmit = async (data: FormData) => {
    try {
      // Normalize empties → null so the DB row honors "not qualified yet".
      // A raw lead (no plan/seats/value) lives in Inbox; once these get set,
      // it transitions into the Deal Pipeline.
      const planVal  = data.plan?.trim()  ? data.plan  : null;
      const seatsVal = (data.seats !== undefined && data.seats !== null && !Number.isNaN(data.seats) && data.seats > 0) ? data.seats : null;
      const valueVal = (data.value !== undefined && data.value !== null && !Number.isNaN(data.value) && data.value > 0) ? data.value : null;

      const sharedPatch = {
        company:        data.company,
        contact_name:   data.contact_name  || null,
        contact_email:  data.contact_email || null,
        contact_phone:  data.contact_phone || null,
        gstin:          data.gstin?.trim().toUpperCase() || null,
        plan:           planVal,
        seats:          seatsVal,
        value:          valueVal,
        stage:          data.stage,
        source:         data.source,
        priority:       data.priority,
        follow_up_date: data.follow_up_date || null,
        owner_id:       data.owner_id       || null,
        subscription_type: data.subscription_type || null,
        notes:          data.notes          || null,
      };

      if (isEditing && editingLead) {
        // ─── Update existing lead ───
        await updateLead.mutateAsync({ id: editingLead.id, patch: sharedPatch });
      } else {
        // ─── Create new lead ───
        const id = "L-" + Date.now().toString(36).toUpperCase();
        /* `created_by` goes HERE and deliberately NOT into `sharedPatch`, which is also the
           update payload. In there it would rewrite the creator on every edit — turning the one
           column that remembers who added a lead into a second copy of "who touched it last",
           which is the exact failure it was added to prevent. Written once, at creation, from
           the session rather than from `data`: a creator the user can pick is not a creator. */
        await createLead.mutateAsync({ id, ...sharedPatch, created_by: me?.userId ?? null });

        // ─── Contextual toast (replaces the hook's generic "Lead created") ───
        // The split between Leads (raw) and Deals (qualified) confused users:
        // they'd save a lead with a plan picked, then can't find it on /leads.
        // Solution: tell them WHICH page their lead landed on + 1-tap nav.
        toast.dismiss();
        // Where it LANDS is decided by stage (Deals = past the quote gate), not by
        // plan/value — else we'd say "Deal" but the raw lead sits in the inbox.
        const isDeal = (POST_QUOTE_STAGE_VALUES as readonly string[]).includes(data.stage);
        const companyName  = data.company;
        if (isDeal) {
          toast.success(`${companyName} saved as Deal`, {
            description: "In your Deal Pipeline",
            duration: 6000,
            action: {
              label: "View deals",
              onClick: () => router.push("/deals" as Route),
            },
          });
        } else {
          toast.success(`${companyName} added to your inbox`, {
            description: "In Leads — send a quote to move it into the Deal Pipeline",
            duration: 6000,
            action: {
              label: "View leads",
              onClick: () => router.push("/leads" as Route),
            },
          });
        }
      }
      onOpenChange(false);
    } catch {
      // Error toast handled in mutation hooks' onError
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* Slide-in drawer from the right (Linear / Attio / HubSpot pattern).
          Full-width on phones, ~560px panel on desktop. Form body scrolls
          independently; header + footer stay pinned. */}
      <SheetContent
        side="right"
        className="w-full sm:max-w-[520px] md:max-w-[600px] p-0 flex flex-col overflow-x-hidden"
      >
        <SheetHeader className="min-w-0">
          <SheetTitle className="break-words">{isEditing ? "Edit lead" : defaultStage ? "Add a new deal" : "Add a new lead"}</SheetTitle>
          <SheetDescription className="break-words">
            {isEditing
              ? `Update details for ${editingLead?.company}.`
              : defaultStage
                ? "Add an opportunity straight to your Deal Pipeline."
                : "Track a potential lead. Send a quote to move it into the Deal Pipeline."}
          </SheetDescription>
        </SheetHeader>

        <form
          onSubmit={handleSubmit(onSubmit)}
          className="flex flex-col flex-1 min-h-0 min-w-0 w-full"
        >
          {/* ── Three steps, and the third one is the point ────────────────────
              Contact → Product & seats → Review. The first two only shorten what is
              on screen at once; the REVIEW step is what makes this poka-yoke rather
              than decoration, because it shows the operator exactly what is about to
              be written before it is written.

              Editing skips the steps entirely. Somebody who opened this sheet to
              correct one phone number should not be walked through a wizard to reach
              it — see `steps` below. */}
          {useSteps && (
            <nav aria-label="Progress" className="flex items-center gap-1 border-b border-hairline px-5 py-2.5">
              {STEP_LABELS.map((label, i) => {
                const n = i + 1;
                const done = n < step;
                return (
                  <React.Fragment key={label}>
                    <button
                      type="button"
                      /* A completed step is clickable, an unreached one is not — going
                         back to fix something must never cost the operator their place,
                         and jumping forward past a required field just fails there. */
                      disabled={n > step}
                      onClick={() => setStep(n)}
                      className={cn(
                        "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] transition-colors",
                        n === step ? "bg-amber-soft font-semibold text-amber-ink"
                          : done    ? "text-ink-2 hover:bg-paper-2"
                          : "text-ink-3",
                      )}
                      aria-current={n === step ? "step" : undefined}
                    >
                      <span aria-hidden="true">{done ? "✓" : n}</span>
                      <span>{label}</span>
                    </button>
                    {n < STEP_LABELS.length && <span aria-hidden="true" className="text-ink-3">›</span>}
                  </React.Fragment>
                );
              })}
            </nav>
          )}

          <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
          {/* ── Paste the WhatsApp message instead of retyping it ──────────────
              Offered on a NEW lead only. On an edit it would overwrite fields the
              operator opened this sheet to correct, which is the opposite of help.

              It fills only what the extractor actually FOUND, and it shows the whole
              list before filling anything — see components/shared/smart-paste.tsx. */}
          {!isEditing && (
            <SmartPaste
              catalogue={PLANS.map((p) => ({ id: p, name: p }))}
              onFill={(v) => {
                if (v.name)  setValue("contact_name",  v.name,  { shouldDirty: true });
                if (v.email) setValue("contact_email", liveEmail(v.email), { shouldDirty: true });
                if (v.phone) setValue("contact_phone", commitPhone(v.phone), { shouldDirty: true });
                if (v.seats) setValue("seats",         v.seats, { shouldDirty: true });
                if (v.product) {
                  setPlan(v.product.name);
                  setValue("plan", v.product.name, { shouldDirty: true });
                }
                toast.success("Filled from the pasted text.", {
                  description: "Check each field before saving — anything it could not read is still blank.",
                });
              }}
            />
          )}

          <Step show={!useSteps || step === 1}>

          {/* Company name */}
          <FormField label="Company name" required htmlFor="company">
            <Input
              id="company"
              autoFocus
              placeholder="e.g. Acme Corp Pvt Ltd"
              error={errors.company?.message}
              {...register("company")}
            />
          </FormField>

          {/* Duplicate heads-up — an existing lead already matches this
              company / phone. Non-blocking: offer to open it instead. */}
          {!isEditing && dupMatch && (
            <div className="rounded-md bg-amber-soft/60 border border-amber/30 px-3 py-2.5 flex items-start gap-2 min-w-0">
              <Icon name="copy" size={14} className="text-amber-ink flex-shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1 text-xs text-amber-ink leading-snug">
                <b>Shayad ye lead pehle se hai:</b> {dupMatch.company}
                {dupMatch.contact_phone ? ` · ${dupMatch.contact_phone}` : ""}.
                Naya banane ke bajaye usi ko kholein?
                <button
                  type="button"
                  onClick={() => { onOpenChange(false); router.push(`/leads?lead=${dupMatch.id}` as Route); }}
                  className="ml-1.5 font-semibold underline underline-offset-2 hover:text-amber"
                >
                  Open existing lead
                </button>
              </div>
            </div>
          )}

          {/* Pick from phone contacts — Android PWA only.
              Tap → native contact picker opens → name/phone/email auto-fill.
              Hidden on iOS Safari + desktop (Contacts Picker API not supported).
              Mobile layout: text on top, button full-width below (more thumb-friendly).
              Desktop: text left, button right. */}
          {contactsApiAvailable && (
            <div className="rounded-md bg-indigo-50 border border-indigo/20 px-3 py-2.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-3 min-w-0">
              <p className="text-xs text-indigo-ink inline-flex items-start gap-2 min-w-0 leading-snug">
                <Icon name="mobile" size={13} className="flex-shrink-0 mt-0.5" />
                <span>Phone par hain? Apne contacts se direct add karo.</span>
              </p>
              <Button
                type="button"
                variant="default"
                size="sm"
                icon="user"
                onClick={pickContact}
                className="sm:shrink-0 w-full sm:w-auto justify-center"
              >
                Pick from contacts
              </Button>
            </div>
          )}

          {/* Contact info — 3 fields in grid */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <FormField label="Contact name" htmlFor="contact_name">
              <Input
                id="contact_name"
                placeholder="e.g. Rajesh K"
                {...register("contact_name")}
              />
            </FormField>
            <FormField label="Email" htmlFor="contact_email">
              <Input
                id="contact_email"
                type="email"
                placeholder="e.g. rajesh@acme.com"
                error={errors.contact_email?.message}
                {...smart("contact_email", { live: liveEmail })}
              />
              <FieldPill check={checkEmail(watch("contact_email") ?? "")} />
            </FormField>
            <FormField label="Phone" htmlFor="contact_phone">
              <Input
                id="contact_phone"
                inputMode="numeric"
                placeholder="e.g. +91 98765 43210"
                {...smart("contact_phone", { live: livePhone, commit: commitPhone })}
              />
              {/* Catches the ten-digit landline, which looks perfect right up until
                  somebody tries to WhatsApp it. */}
              <FieldPill check={checkPhone(watch("contact_phone") ?? "")} />
            </FormField>
          </div>

          {/* GSTIN — optional. When set, the existing Sandbox.co.in verifier
              auto-fills legal name + registered address on conversion. */}
          <FormField label="GSTIN" htmlFor="gstin">
            {/* Upper-cases and strips the spaces a PDF or WhatsApp paste brings, on every
                keystroke. The `uppercase` class alone only changed how it LOOKED — the
                stored value stayed lower-case, and a lower-case GSTIN fails the checksum
                that decides the tax head. */}
            <Input
              id="gstin"
              className="font-mono"
              placeholder="e.g. 27AABCE1234D1Z9"
              error={errors.gstin?.message}
              {...smart("gstin", { live: liveGstin })}
            />
            {/* One shared, tested rule instead of the four hand-written branches that used
                to live here — and it now names the STATE, which is the fact about to
                decide IGST vs CGST+SGST. An operator who sees "Delhi" where they expected
                Haryana has caught a wrong paste before it became a tax head. */}
            <FieldPill check={checkGstin(watch("gstin") ?? "")} />
            {!(watch("gstin") ?? "").trim() && (
              <p className="text-3xs text-ink-3">
                Optional. Helps auto-fill legal name + address on conversion.
              </p>
            )}
          </FormField>

          </Step>

          <Step show={!useSteps || step === 2}>

          {/* Plan — optional. If empty → lead lands in Inbox (raw, awaiting
              qualification). If picked → lead enters Pipeline as a deal. */}
          <FormField label="Interested plan" htmlFor="plan">
            <Select
              value={plan}
              onValueChange={(v) => {
                setPlan(v);
                (register("plan") as any).onChange({ target: { value: v, name: "plan" } });
              }}
            >
              <SelectTrigger id="plan" error={!!errors.plan}>
                <SelectValue placeholder="Skip to capture as raw lead (Inbox)" />
              </SelectTrigger>
              <SelectContent>
                {PLANS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <input type="hidden" {...register("plan")} value={plan} />
            <p className="text-2xs text-ink-3 mt-1">
              {plan
                ? "Will go straight into Deal Pipeline as a qualified opportunity."
                : "Leave empty to drop into Lead Inbox — you can qualify later."}
            </p>
          </FormField>

          {/* Seats + Value in grid — both optional now */}
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Seats" htmlFor="seats">
              <Input
                id="seats"
                type="number"
                min={0}
                placeholder="—"
                error={errors.seats?.message}
                {...register("seats", { valueAsNumber: true, setValueAs: (v) => v === "" || v === null ? undefined : Number(v) })}
              />
            </FormField>
            {/* "(whole rupees)" said in the label, not left to be discovered. This app
                stores money as integers (CLAUDE.md §13) and a field that quietly rounds
                1500.50 has decided something about somebody's money without telling them
                — checkMoney reports that instead. */}
            <FormField label="Deal value (₹ — whole rupees)" htmlFor="value">
              <Input
                id="value"
                type="text"
                inputMode="numeric"
                prefix="₹"
                error={errors.value?.message}
                /* The BOX holds a display string ("1,76,640"); the FORM holds a number.
                   Keeping them apart is what lets the field group digits the Indian way
                   without the grouping breaking its own validation — and it keeps the
                   registered field typed as the number it actually is, with no cast. */
                value={valueText}
                onChange={(e) => {
                  const next = liveMoney(e.target.value);
                  setValueText(next);
                  setValue("value", parseMoney(next) ?? undefined, { shouldDirty: true });
                }}
                onBlur={() => setValueText((t) => commitMoney(t))}
              />
              <FieldPill check={checkMoney(valueText)} />
              {/* Auto-calc hint */}
              {PLAN_PRICE_PER_SEAT_PM[plan] && (watchedSeats ?? 0) >= 1 && (
                <p className="mt-1 text-xs text-ink-3">
                  ₹{PLAN_PRICE_PER_SEAT_PM[plan].toLocaleString("en-IN")}/seat/mo
                  {" × "}{watchedSeats} seats × 12 mo
                  {" = "}
                  <span className="font-semibold text-ink">
                    ₹{(PLAN_PRICE_PER_SEAT_PM[plan] * (watchedSeats ?? 0) * 12).toLocaleString("en-IN")}
                  </span>
                </p>
              )}
              {plan === "Custom / Mixed" && (
                <p className="mt-1 text-xs text-ink-3">Enter your negotiated deal value</p>
              )}
            </FormField>
          </div>

          {/* Stage + Source + Priority — 3 status fields together */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <FormField label="Stage" required htmlFor="stage">
              <Select
                value={stage}
                onValueChange={(v) => {
                  setStage(v as FormData["stage"]);
                  (register("stage") as any).onChange({ target: { value: v, name: "stage" } });
                }}
              >
                <SelectTrigger id="stage">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {availableStages.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <input type="hidden" {...register("stage")} value={stage} />
              {!plan && (
                <p className="mt-1 text-3xs text-ink-3 leading-snug">
                  Pick a plan to unlock Demo / Trial / Quote / Won.
                </p>
              )}
            </FormField>
            <FormField label="Source" htmlFor="source">
              <Select
                value={source}
                onValueChange={(v) => {
                  setSource(v);
                  (register("source") as any).onChange({ target: { value: v, name: "source" } });
                }}
              >
                <SelectTrigger id="source">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SOURCES.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <input type="hidden" {...register("source")} value={source} />
            </FormField>
            <FormField label="Priority" htmlFor="priority">
              <Select
                value={priority}
                onValueChange={(v) => {
                  setPriority(v as LeadPriority);
                  (register("priority") as any).onChange({ target: { value: v, name: "priority" } });
                }}
              >
                <SelectTrigger id="priority">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRIORITY_OPTIONS.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      <span className="inline-flex items-center gap-2">
                        <span className={cn("inline-block w-2 h-2 rounded-full", p.dot)} />
                        {p.label}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <input type="hidden" {...register("priority")} value={priority} />
            </FormField>
          </div>

          {/* New vs switching — is the prospect already subscribed elsewhere? */}
          <FormField label="New or switching?" htmlFor="subscription_type">
            <select
              id="subscription_type"
              {...register("subscription_type")}
              className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40"
            >
              <option value="">Not sure yet</option>
              <option value="fresh">Fresh subscription (new)</option>
              <option value="switch">Switching vendor (already subscribed elsewhere)</option>
            </select>
            <p className="mt-1 text-3xs text-ink-3 leading-snug">
              &ldquo;Switching&rdquo; = they already use this product, just moving billing/reseller to you (migration).
            </p>
          </FormField>

          {/* Follow-up date + Owner — sales workflow row */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <FormField label="Next follow-up" htmlFor="follow_up_date">
              <Input
                id="follow_up_date"
                type="date"
                min={new Date().toISOString().slice(0, 10)}
                {...register("follow_up_date")}
              />
              <p className="mt-1 text-3xs text-ink-3">
                Drives your daily worklist · reminder ping the morning of.
              </p>
            </FormField>
            <FormField label="Owner" htmlFor="owner_id">
              <Select
                value={ownerId || "__unassigned"}
                onValueChange={(v) => {
                  const nextId = v === "__unassigned" ? "" : v;
                  setOwnerId(nextId);
                  (register("owner_id") as any).onChange({ target: { value: nextId, name: "owner_id" } });
                }}
              >
                <SelectTrigger id="owner_id">
                  <SelectValue placeholder="Unassigned" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__unassigned">Unassigned</SelectItem>
                  {(tenantUsers ?? []).map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {u.full_name || u.email}
                      {u.id === me?.userId ? " (you)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <input type="hidden" {...register("owner_id")} value={ownerId} />
            </FormField>
          </div>

          {/* Notes — multi-line textarea so sales reps can capture call
              transcripts, decision-maker context, budget cycles, etc. */}
          <FormField label="Notes" htmlFor="notes">
            <textarea
              id="notes"
              rows={4}
              placeholder="Decision maker, timeline, budget, objections, next-step plan…"
              className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-4 focus:outline-none focus:ring-2 focus:ring-amber resize-y"
              {...register("notes")}
            />
          </FormField>

          </Step>

          {/* ── Step 3: what is about to be saved ─────────────────────────────
              Read-only, and that is the whole value. A form's last screen is the only
              place an operator sees every field at once without having to scroll past
              the ones they already filled — which is where a wrong seat count or a
              landline in the phone box actually gets caught. */}
          <Step show={useSteps && step === 3}>
            <div className="rounded-lg border border-hairline bg-paper-2/40 p-3">
              <p className="mb-2 text-2xs font-semibold uppercase tracking-wider text-ink-3">
                About to be saved
              </p>
              <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <Review label="Company"     value={watch("company")} />
                <Review label="Contact"     value={watch("contact_name")} />
                <Review label="Email"       value={watch("contact_email")} />
                <Review label="Phone"       value={watch("contact_phone")} />
                <Review label="GSTIN"       value={watch("gstin")} mono
                        note={gstinState(watch("gstin") ?? "")?.name} />
                <Review label="Plan"        value={plan} />
                <Review label="Seats"       value={watchedSeats == null ? "" : String(watchedSeats)} />
                <Review label="Deal value"  value={valueText ? `₹${valueText}` : ""} />
                <Review label="Stage"       value={STAGES.find((s) => s.value === stage)?.label} />
                <Review label="Priority"    value={PRIORITY_OPTIONS.find((p) => p.value === priority)?.label} />
              </dl>
              {/* Blanks are stated, not shown as gaps — a blank row reads as a
                  rendering fault and an operator cannot tell it apart from a value
                  that failed to load. See the same rule on the enquiry panel. */}
              <p className="mt-2.5 border-t border-hairline pt-2 text-3xs leading-snug text-ink-3">
                Anything marked “not set” will be saved empty. Go back to any step above to
                fill it — nothing is lost.
              </p>
            </div>
          </Step>

          </div>  {/* close scrollable form body */}

          <SheetFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => (useSteps && step > 1 ? setStep(step - 1) : onOpenChange(false))}
            >
              {useSteps && step > 1 ? "Back" : "Cancel"}
            </Button>

            {useSteps && step < STEP_LABELS.length ? (
              <Button
                type="button"
                variant="primary"
                onClick={async () => {
                  /* Validates ONLY this step's fields. Running the whole schema here
                     would red-flag a field two steps ahead that nobody has reached
                     yet, which is the same "shouting at an untouched field" the pills
                     were built to stop. */
                  const ok = await trigger(step === 1 ? STEP_FIELDS[0] : STEP_FIELDS[1]);
                  if (ok) setStep(step + 1);
                }}
              >
                Next
              </Button>
            ) : (
              <Button
                type="submit"
                variant="primary"
                loading={isSubmitting || createLead.isPending || updateLead.isPending}
              >
                {isEditing ? "Save changes" : "Add lead"}
              </Button>
            )}
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
