/**
 * Project / one-time sales (custom software etc.) — TanStack Query hooks.
 *
 * A project sale is billed in milestones (installments), each of which can be
 * turned into a proper GST Tax Invoice and paid. Revenue flows through the
 * normal `invoices` table; receivable = project total − payments received.
 *
 * Deliberately separate from the subscription money-spine — no subscription,
 * no vendor PO, no renewal is ever created here.
 */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import type {
  ProjectSaleRow,
  ProjectMilestoneRow,
  ProjectPaymentRow,
  ProjectQuoteLine,
  ExpenseRow,
} from "@/lib/supabase/database.types";

export type { ProjectSaleRow, ProjectMilestoneRow, ProjectPaymentRow, ProjectQuoteLine };

export type ProjectSaleWithTotals = ProjectSaleRow & {
  paid:        number;   // Σ payments received
  receivable:  number;   // total − paid
};

export type MilestoneInput = {
  label:        string;
  total_amount: number;   // GST-inclusive amount due this installment
  due_date:     string | null;
};

// ── List ─────────────────────────────────────────────────────────────────────
export function useProjectSales() {
  return useQuery({
    queryKey: ["project_sales"],
    queryFn: async (): Promise<ProjectSaleWithTotals[]> => {
      const supabase = createClient();
      const { data: projects, error } = await supabase
        .from("project_sales")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;

      const { data: pays, error: pErr } = await supabase
        .from("project_payments")
        .select("project_id, amount");
      if (pErr) throw pErr;

      const paidBy = new Map<string, number>();
      for (const p of pays ?? []) {
        paidBy.set(p.project_id, (paidBy.get(p.project_id) ?? 0) + (p.amount ?? 0));
      }
      return (projects ?? []).map((pr) => {
        const paid = paidBy.get(pr.id) ?? 0;
        return { ...(pr as ProjectSaleRow), paid, receivable: Math.max(0, (pr.total_amount ?? 0) - paid) };
      });
    },
    staleTime: 30_000,
  });
}

// ── All project payments for the tenant (for the Payments dashboard) ──────────
export type ProjectPaymentListRow = ProjectPaymentRow & { project_title: string; customer_name: string; customer_id: string | null };
export function useAllProjectPayments() {
  return useQuery({
    queryKey: ["project_payments", "all"],
    queryFn: async (): Promise<ProjectPaymentListRow[]> => {
      const supabase = createClient();
      const { data: pays, error } = await supabase
        .from("project_payments").select("*").order("received_at", { ascending: false });
      if (error) throw error;
      const rows = (pays ?? []) as ProjectPaymentRow[];
      const ids = [...new Set(rows.map((p) => p.project_id))];
      const titleBy = new Map<string, { title: string; customer: string; customerId: string | null }>();
      if (ids.length > 0) {
        const { data: projs } = await supabase
          .from("project_sales").select("id, title, customer_name, customer_id").in("id", ids);
        for (const p of projs ?? []) titleBy.set(p.id, { title: p.title, customer: p.customer_name, customerId: p.customer_id });
      }
      return rows.map((p) => ({
        ...p,
        project_title: titleBy.get(p.project_id)?.title ?? "Project",
        customer_name: titleBy.get(p.project_id)?.customer ?? "—",
        customer_id:   titleBy.get(p.project_id)?.customerId ?? null,
      }));
    },
    staleTime: 30_000,
  });
}

// ── The milestone behind a given project invoice (for recording payment) ─────
export function useMilestoneByInvoice(invoiceId: string | null | undefined) {
  return useQuery({
    queryKey: ["project_milestones", "by_invoice", invoiceId],
    enabled:  Boolean(invoiceId),
    queryFn: async (): Promise<ProjectMilestoneRow | null> => {
      if (!invoiceId) return null;
      const supabase = createClient();
      const { data, error } = await supabase
        .from("project_milestones").select("*").eq("invoice_id", invoiceId).maybeSingle();
      if (error) throw error;
      return (data ?? null) as ProjectMilestoneRow | null;
    },
  });
}

// ── Which invoice ids came from a project milestone (vs a subscription quote) ─
export function useProjectInvoiceIds() {
  return useQuery({
    queryKey: ["project_milestones", "invoice_ids"],
    queryFn: async (): Promise<Set<string>> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("project_milestones").select("invoice_id").not("invoice_id", "is", null);
      if (error) throw error;
      return new Set((data ?? []).map((m) => m.invoice_id as string));
    },
    staleTime: 30_000,
  });
}

// ── A customer's project sales (for the customer 360 page) ────────────────────
export function useCustomerProjects(customerId: string | null | undefined) {
  return useQuery({
    queryKey: ["project_sales", "by_customer", customerId],
    enabled:  Boolean(customerId),
    queryFn: async (): Promise<ProjectSaleWithTotals[]> => {
      if (!customerId) return [];
      const supabase = createClient();
      const { data: projects, error } = await supabase
        .from("project_sales").select("*").eq("customer_id", customerId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      const ids = (projects ?? []).map((p) => p.id);
      const paidBy = new Map<string, number>();
      if (ids.length > 0) {
        const { data: pays } = await supabase.from("project_payments").select("project_id, amount").in("project_id", ids);
        for (const p of pays ?? []) paidBy.set(p.project_id, (paidBy.get(p.project_id) ?? 0) + (p.amount ?? 0));
      }
      return (projects ?? []).map((pr) => {
        const paid = paidBy.get(pr.id) ?? 0;
        return { ...(pr as ProjectSaleRow), paid, receivable: Math.max(0, (pr.total_amount ?? 0) - paid) };
      });
    },
  });
}

// ── All of a customer's PROJECT payments (+ how much each project invoice has
//    been paid). Project milestone receipts live in project_payments, NOT the
//    `payments` table, so the customer's Transactions/Statement miss them unless
//    we surface them here. invoicePaid maps a milestone's invoice_id → ₹ received,
//    so a project invoice can show its true paid / partial / due state.
export interface CustomerProjectPayment {
  id: string; amount: number; received_at: string;
  method: string | null; reference: string | null; bank_txn_id: string | null;
  project_id: string; project_title: string; invoice_id: string | null;
}
export function useCustomerProjectPayments(customerId: string | null | undefined) {
  return useQuery({
    queryKey: ["project_payments", "by_customer", customerId],
    enabled:  Boolean(customerId),
    queryFn: async (): Promise<{
      payments: CustomerProjectPayment[];
      invoicePaid: Record<string, number>;
      // invoice_id → the project it belongs to (for the hierarchical view).
      invoiceProject: Record<string, { projectId: string; title: string }>;
    }> => {
      const empty = { payments: [], invoicePaid: {}, invoiceProject: {} };
      if (!customerId) return empty;
      const supabase = createClient();
      const { data: projects } = await supabase.from("project_sales").select("id, title").eq("customer_id", customerId);
      const ids = (projects ?? []).map((p) => p.id);
      if (ids.length === 0) return empty;
      const titleById = new Map((projects ?? []).map((p) => [p.id as string, (p.title as string) ?? "Project"]));
      const [{ data: milestones }, { data: pays }] = await Promise.all([
        supabase.from("project_milestones").select("id, invoice_id, project_id").in("project_id", ids),
        supabase.from("project_payments").select("*").in("project_id", ids).order("received_at", { ascending: false }),
      ]);
      const invByMs = new Map<string, string | null>((milestones ?? []).map((m) => [m.id as string, (m.invoice_id as string | null)]));
      const invoiceProject: Record<string, { projectId: string; title: string }> = {};
      for (const m of milestones ?? []) {
        if (m.invoice_id) invoiceProject[m.invoice_id as string] = { projectId: m.project_id as string, title: titleById.get(m.project_id as string) ?? "Project" };
      }
      const invoicePaid: Record<string, number> = {};
      const payments: CustomerProjectPayment[] = [];
      for (const p of pays ?? []) {
        const inv = p.milestone_id ? (invByMs.get(p.milestone_id) ?? null) : null;
        payments.push({
          id: p.id, amount: p.amount ?? 0, received_at: p.received_at,
          method: p.method ?? null, reference: p.reference ?? null, bank_txn_id: p.bank_txn_id ?? null,
          project_id: p.project_id, project_title: titleById.get(p.project_id) ?? "Project", invoice_id: inv,
        });
        if (inv) invoicePaid[inv] = (invoicePaid[inv] ?? 0) + (p.amount ?? 0);
      }
      return { payments, invoicePaid, invoiceProject };
    },
  });
}

// ── Single project (with milestones + payments) ───────────────────────────────
export function useProjectSale(id: string | null | undefined) {
  return useQuery({
    queryKey: ["project_sales", id],
    enabled:  Boolean(id),
    queryFn: async () => {
      if (!id) return null;
      const supabase = createClient();
      const [{ data: project, error: e1 }, { data: milestones, error: e2 }, { data: payments, error: e3 }, { data: costs, error: e4 }] =
        await Promise.all([
          supabase.from("project_sales").select("*").eq("id", id).single(),
          supabase.from("project_milestones").select("*").eq("project_id", id).order("seq", { ascending: true }),
          supabase.from("project_payments").select("*").eq("project_id", id).order("received_at", { ascending: false }),
          supabase.from("expenses").select("*").eq("project_id", id).order("expense_date", { ascending: false }),
        ]);
      if (e1) throw e1;
      if (e2) throw e2;
      if (e3) throw e3;
      if (e4) throw e4;
      const paid = (payments ?? []).reduce((s, p) => s + (p.amount ?? 0), 0);
      // Cost basis = ex-GST expense amount (GST is pass-through / input credit,
      // not a real cost) so profit compares like-with-like against ex-GST revenue.
      const costTotal = (costs ?? []).reduce((s, c) => s + (c.amount ?? 0), 0);
      return {
        project:    project as ProjectSaleRow,
        milestones: (milestones ?? []) as ProjectMilestoneRow[],
        payments:   (payments ?? []) as ProjectPaymentRow[],
        costs:      (costs ?? []) as ExpenseRow[],
        costTotal,
        paid,
        receivable: Math.max(0, (project?.total_amount ?? 0) - paid),
      };
    },
  });
}

// ── Create ─────────────────────────────────────────────────────────────────────
export function useCreateProjectSale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      customerId:   string | null;
      customerName: string;
      title:        string;
      description:  string | null;
      taxable:      number;
      gstRate:      number;
      interState:   boolean;
      milestones:   MilestoneInput[];
    }) => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("create_project_sale", {
        p_customer_id:   input.customerId,
        p_customer_name: input.customerName,
        p_title:         input.title,
        p_description:   input.description,
        p_taxable:       input.taxable,
        p_gst_rate:      input.gstRate,
        p_inter_state:   input.interState,
        p_milestones:    input.milestones,
      });
      if (error) throw error;
      return data as string;   // project id
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project_sales"] });
      toast.success("Project created");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not create project"),
  });
}

// ── Payments recorded against a given invoice (project invoices) ─────────────
// A project invoice has no parent quote, so the normal quote→payments lookup
// finds nothing. Its receipts live in project_payments, linked via the
// milestone that carries this invoice_id.
export function useProjectPaymentsByInvoice(invoiceId: string | null | undefined) {
  return useQuery({
    queryKey: ["project_payments", "by_invoice", invoiceId],
    enabled:  Boolean(invoiceId),
    queryFn: async (): Promise<ProjectPaymentRow[]> => {
      if (!invoiceId) return [];
      const supabase = createClient();
      const { data: ms, error: e1 } = await supabase
        .from("project_milestones").select("id").eq("invoice_id", invoiceId);
      if (e1) throw e1;
      const ids = (ms ?? []).map((m) => m.id);
      if (ids.length === 0) return [];
      const { data, error } = await supabase
        .from("project_payments").select("*").in("milestone_id", ids)
        .order("received_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as ProjectPaymentRow[];
    },
  });
}

// ── Create a project QUOTATION (status 'quoted', itemised) ────────────────────
export function useCreateProjectQuote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      customerId:   string | null;
      customerName: string;
      title:        string;
      description:  string | null;
      lineItems:    ProjectQuoteLine[];
      gstRate:      number;
      interState:   boolean;
      milestones:   MilestoneInput[];
    }) => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("create_project_quote", {
        p_customer_id:   input.customerId,
        p_customer_name: input.customerName,
        p_title:         input.title,
        p_description:   input.description,
        p_line_items:    input.lineItems,
        p_gst_rate:      input.gstRate,
        p_inter_state:   input.interState,
        p_milestones:    input.milestones,
      });
      if (error) throw error;
      return data as string;   // project id
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project_sales"] });
      toast.success("Quotation created");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not create quotation"),
  });
}

// ── Direct project invoice — create + accept + raise, in one atomic RPC ───────
export function useCreateProjectDirectInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      customerId:   string | null;
      customerName: string;
      title:        string;
      description:  string | null;
      lineItems:    ProjectQuoteLine[];
      gstRate:      number;
      interState:   boolean;
    }) => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("create_project_direct_invoice", {
        p_customer_id:   input.customerId,
        p_customer_name: input.customerName,
        p_title:         input.title,
        p_description:   input.description,
        p_line_items:    input.lineItems,
        p_gst_rate:      input.gstRate,
        p_inter_state:   input.interState,
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      return row as { invoice_id: string; project_id: string };
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["project_sales"] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["aging"] });
      qc.invalidateQueries({ queryKey: ["nav-badges"] });
      toast.success(`Invoice ${res.invoice_id} raised`);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not create invoice"),
  });
}

// ── Edit a project quotation (only before it's invoiced/paid) ────────────────
export function useUpdateProjectQuote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      projectId:    string;
      customerName: string;
      title:        string;
      description:  string | null;
      lineItems:    ProjectQuoteLine[];
      gstRate:      number;
      interState:   boolean;
      milestones:   MilestoneInput[];
    }) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("update_project_quote", {
        p_project_id:    input.projectId,
        p_customer_name: input.customerName,
        p_title:         input.title,
        p_description:   input.description,
        p_line_items:    input.lineItems,
        p_gst_rate:      input.gstRate,
        p_inter_state:   input.interState,
        p_milestones:    input.milestones,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: (_r, v) => {
      qc.invalidateQueries({ queryKey: ["project_sales"] });
      qc.invalidateQueries({ queryKey: ["project_sales", v.projectId] });
      toast.success("Quotation updated");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not update"),
  });
}

// Edit ONLY the future (un-invoiced, un-paid) milestones — the invoiced/paid
// ones stay locked. The remaining milestones must still add up to the fixed
// contract total (the RPC enforces this).
export function useUpdateProjectFutureMilestones() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { projectId: string; milestones: MilestoneInput[] }) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("update_project_future_milestones", {
        p_project_id: input.projectId,
        p_milestones: input.milestones,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: (_r, v) => {
      qc.invalidateQueries({ queryKey: ["project_sales"] });
      qc.invalidateQueries({ queryKey: ["project_sales", v.projectId] });
      toast.success("Remaining schedule updated");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not update"),
  });
}

export function useDeleteProjectSale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (projectId: string) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("delete_project_sale", { p_project_id: projectId });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project_sales"] });
      qc.invalidateQueries({ queryKey: ["bank_transactions"] });
      toast.success("Project deleted");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not delete"),
  });
}

// ── Accept a quotation → active project (owner "mark accepted") ───────────────
export function useAcceptProjectQuote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (projectId: string) => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("accept_project_quote", { p_project_id: projectId });
      if (error) throw error;
      return data as string;
    },
    onSuccess: (_r, projectId) => {
      qc.invalidateQueries({ queryKey: ["project_sales", projectId] });
      qc.invalidateQueries({ queryKey: ["project_sales"] });
      toast.success("Quotation accepted — project is now active");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not accept"),
  });
}

// ── Raise a milestone's Tax Invoice ───────────────────────────────────────────
export function useRaiseMilestoneInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { milestoneId: string; projectId: string }) => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("raise_project_milestone_invoice", {
        p_milestone_id: input.milestoneId,
      });
      if (error) throw error;
      return data as string;   // invoice id
    },
    onSuccess: (invId, vars) => {
      qc.invalidateQueries({ queryKey: ["project_sales", vars.projectId] });
      qc.invalidateQueries({ queryKey: ["project_sales"] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
      toast.success(`Tax invoice ${invId} raised`);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not raise invoice"),
  });
}

// ── Record a payment against a milestone ──────────────────────────────────────
export function useRecordProjectPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      milestoneId: string;
      projectId:   string;
      amount:      number;
      method:      string | null;
      reference:   string | null;
      receivedAt:  string;
      bankTxnId?:  string | null;
    }) => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("record_project_payment", {
        p_milestone_id: input.milestoneId,
        p_amount:       input.amount,
        p_method:       input.method,
        p_reference:    input.reference,
        p_received_at:  input.receivedAt,
        p_bank_txn_id:  input.bankTxnId ?? null,
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: (_id, vars) => {
      qc.invalidateQueries({ queryKey: ["project_sales", vars.projectId] });
      qc.invalidateQueries({ queryKey: ["project_sales"] });
      qc.invalidateQueries({ queryKey: ["project_milestones"] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["bank_transactions"] });
      toast.success("Payment recorded");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not record payment"),
  });
}
