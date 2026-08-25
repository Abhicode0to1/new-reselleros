"use client";

/**
 * /portal/support/new — raise a new support ticket.
 */
import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/label";
import { Icon } from "@/components/ui/icon";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { createClient } from "@/lib/supabase/client";

const CATEGORIES = [
  { value: "billing",     label: "💰 Billing / invoice / payment" },
  { value: "tech",        label: "🔧 Technical (Workspace not working)" },
  { value: "plan_change", label: "📈 Plan change / add or remove users" },
  { value: "feature",     label: "💡 Feature request / suggestion" },
  { value: "other",       label: "📋 Something else" },
] as const;

const PRIORITIES = [
  { value: "low",     label: "Low · informational" },
  { value: "normal",  label: "Normal · standard request" },
  { value: "high",    label: "High · affecting work" },
  { value: "urgent",  label: "Urgent · email down / critical" },
] as const;

const schema = z.object({
  category: z.enum(["billing", "tech", "plan_change", "feature", "other"]),
  priority: z.enum(["low", "normal", "high", "urgent"]),
  subject:  z.string().min(5,  "Brief subject (min 5 chars)"),
  body:     z.string().min(20, "Describe in at least 20 characters"),
});
type FormData = z.infer<typeof schema>;

function newTicketId(): string {
  const stamp = Date.now().toString(36).toUpperCase();
  const rand  = Math.floor(Math.random() * 256).toString(16).padStart(2, "0").toUpperCase();
  return `TKT-${stamp}-${rand}`;
}

export default function NewTicketPage() {
  const router = useRouter();

  const { register, handleSubmit, watch, setValue, formState: { errors, isSubmitting } } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { category: "billing", priority: "normal" },
  });

  async function onSubmit(values: FormData) {
    const supabase = createClient();

    // Get current portal session — auth user + customer
    const { data: authData } = await supabase.auth.getUser();
    if (!authData?.user) {
      toast.error("Session expired. Please sign in again.");
      router.push("/portal/login");
      return;
    }

    // Find their customer link (RLS-scoped — only their own row visible)
    const { data: link } = await supabase
      .from("customer_users")
      .select("customer_id, tenant_id, customers ( name )")
      .eq("auth_user_id", authData.user.id)
      .maybeSingle();
    if (!link) {
      toast.error("Customer profile not found. Please sign in again.");
      return;
    }
    const customerName = ((link.customers as unknown) as { name?: string } | null)?.name ?? "Customer";

    const { error } = await supabase.from("support_tickets").insert({
      id:              newTicketId(),
      tenant_id:       link.tenant_id,
      customer_id:     link.customer_id,
      customer_name:   customerName,
      raised_by_email: authData.user.email ?? "",
      raised_by_user:  authData.user.id,
      category:        values.category,
      priority:        values.priority,
      subject:         values.subject,
      body:            values.body,
      status:          "open",
    });
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Ticket raised · we'll respond within 4 business hours");
    router.push("/portal/support");
  }

  return (
    <div className="max-w-[680px] mx-auto px-6 py-8">
      <div className="mb-6">
        <Link href="/portal/support" className="text-xs text-ink-3 hover:text-ink">
          ← Back to all tickets
        </Link>
        <h1 className="font-serif text-3xl md:text-4xl tracking-tight mt-2">Raise a ticket</h1>
        <p className="text-sm text-ink-3 mt-1">
          We respond within 4 business hours. For urgent items, also WhatsApp us.
        </p>
      </div>

      <Card className="p-6">
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <FormField label="Category" required htmlFor="category">
              <Select value={watch("category")} onValueChange={(v) => setValue("category", v as FormData["category"])}>
                <SelectTrigger id="category"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField label="Priority" required htmlFor="priority">
              <Select value={watch("priority")} onValueChange={(v) => setValue("priority", v as FormData["priority"])}>
                <SelectTrigger id="priority"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PRIORITIES.map((p) => (
                    <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </div>

          <FormField label="Subject" required htmlFor="subject">
            <Input
              id="subject"
              placeholder="Short summary of the issue"
              error={errors.subject?.message}
              {...register("subject")}
            />
          </FormField>

          <FormField label="Details" required htmlFor="body">
            <Textarea
              id="body"
              rows={6}
              placeholder="Describe the issue in detail. Include any error messages, user emails affected, screenshot URLs, etc."
              {...register("body")}
            />
            {errors.body?.message && (
              <p className="text-2xs text-rose mt-1">{errors.body.message}</p>
            )}
          </FormField>

          <div className="flex gap-2 justify-end pt-2">
            <Button asChild variant="default">
              <Link href="/portal/support">Cancel</Link>
            </Button>
            <Button type="submit" variant="primary" loading={isSubmitting}>
              <Icon name="send" size={14} className="mr-1.5" />
              Submit ticket
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
