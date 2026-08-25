"use client";

/**
 * ShopClient — product grid + "Request a quote" dialog for the customer portal.
 * Pricing shown is the reseller's customer MSRP (₹/user/month). On submit we
 * call portal_request_quote() which drops a lead into the reseller's pipeline.
 */
import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";

import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "@/components/ui/label";
import { Icon } from "@/components/ui/icon";
import { rupee } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { tenantWhatsAppLink, phoneDisplay } from "@/lib/portal/branding";

export interface ShopProduct {
  id: string;
  name: string;
  vendor: string;
  price_per_seat_month: number;
  hsn: string | null;
}

const VENDOR_ORDER = ["google", "microsoft", "zoho", "other"] as const;
const VENDOR_LABEL: Record<string, string> = {
  google:    "Google Workspace",
  microsoft: "Microsoft 365",
  zoho:      "Zoho",
  other:     "More products",
};

const schema = z.object({
  seats: z.coerce.number().int().min(1, "At least 1 user").max(100000),
  note:  z.string().max(500).optional(),
});
type FormData = z.infer<typeof schema>;

export function ShopClient({
  products,
  ownedPlans,
  resellerName,
  resellerPhone,
}: {
  products: ShopProduct[];
  ownedPlans: string[];
  resellerName: string;
  resellerPhone: string | null;
}) {
  const [selected, setSelected] = React.useState<ShopProduct | null>(null);

  const ownedSet = React.useMemo(
    () => new Set(ownedPlans.map((p) => p.toLowerCase())),
    [ownedPlans],
  );

  // Group products by vendor, preserving the catalog's price-sorted order.
  const grouped = React.useMemo(() => {
    const map = new Map<string, ShopProduct[]>();
    for (const p of products) {
      const key = VENDOR_ORDER.includes(p.vendor as never) ? p.vendor : "other";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(p);
    }
    return VENDOR_ORDER.filter((v) => map.has(v)).map((v) => ({ vendor: v, items: map.get(v)! }));
  }, [products]);

  return (
    <div className="max-w-[1080px] mx-auto px-6 py-8">
      <header className="mb-8">
        <h1 className="font-serif text-3xl md:text-4xl tracking-tight">Add more to your workspace</h1>
        <p className="text-sm text-ink-3 mt-1">
          Browse products from {resellerName}. Request a quote and we&apos;ll send you a
          GST invoice-ready price — no payment now.
        </p>
      </header>

      {products.length === 0 ? (
        <Card className="p-8 text-center text-sm text-ink-3">
          No products are listed right now. Please{" "}
          {resellerPhone
            ? <a className="text-amber-ink underline"
                 href={tenantWhatsAppLink(resellerPhone, `Hi ${resellerName}, what products can I buy?`) ?? "#"}
                 target="_blank" rel="noopener noreferrer">WhatsApp {resellerName}</a>
            : <>contact {resellerName}</>}{" "}
          for the catalogue.
        </Card>
      ) : (
        <div className="space-y-10">
          {grouped.map(({ vendor, items }) => (
            <section key={vendor}>
              <h2 className="text-2xs uppercase tracking-wider text-ink-3 font-semibold mb-3">
                {VENDOR_LABEL[vendor] ?? VENDOR_LABEL.other}
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {items.map((p) => {
                  const owned = ownedSet.has(p.name.toLowerCase());
                  return (
                    <Card key={p.id} className="p-5 flex flex-col">
                      <div className="flex items-start justify-between gap-2 mb-3">
                        <div className="font-serif text-lg text-ink leading-tight">{p.name}</div>
                        {owned && (
                          <span className="text-3xs uppercase tracking-wider font-semibold text-emerald bg-emerald-soft px-2 py-0.5 rounded-full whitespace-nowrap">
                            Current plan
                          </span>
                        )}
                      </div>
                      <div className="mb-5">
                        <span className="font-serif text-2xl text-ink">{rupee(p.price_per_seat_month)}</span>
                        <span className="text-xs text-ink-3"> /user/month</span>
                        <div className="text-2xs text-ink-3 mt-0.5">+ 18% GST · billed annually</div>
                      </div>
                      <div className="mt-auto">
                        <Button
                          variant={owned ? "default" : "primary"}
                          className="w-full justify-center"
                          onClick={() => setSelected(p)}
                        >
                          {owned ? "Add more users" : "Request a quote"}
                        </Button>
                      </div>
                    </Card>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}

      {resellerPhone && (
        <Card className="p-5 mt-10 text-center text-sm text-ink-3">
          Not sure which plan fits? WhatsApp {resellerName} on{" "}
          <a
            className="text-amber-ink font-medium"
            href={tenantWhatsAppLink(resellerPhone, `Hi ${resellerName}, I need help choosing a plan.`) ?? "#"}
            target="_blank" rel="noopener noreferrer"
          >
            {phoneDisplay(resellerPhone)}
          </a>
          .
        </Card>
      )}

      <RequestQuoteDialog
        product={selected}
        resellerName={resellerName}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}

function RequestQuoteDialog({
  product,
  resellerName,
  onClose,
}: {
  product: ShopProduct | null;
  resellerName: string;
  onClose: () => void;
}) {
  const {
    register, handleSubmit, reset,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { seats: 10, note: "" },
  });

  // Reset the form each time a new product is selected.
  React.useEffect(() => {
    if (product) reset({ seats: 10, note: "" });
  }, [product, reset]);

  async function onSubmit(values: FormData) {
    if (!product) return;
    const supabase = createClient();
    const { error } = await supabase.rpc("portal_request_quote", {
      p_item_id: product.id,
      p_seats:   values.seats,
      p_note:    values.note?.trim() ? values.note.trim() : undefined,
    });
    if (error) {
      toast.error(error.message || "Couldn't send the request. Please try again.");
      return;
    }
    toast.success(`Request sent! ${resellerName} will email you a GST quote shortly.`);
    onClose();
  }

  return (
    <Dialog open={!!product} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Request a quote</DialogTitle>
          <DialogDescription>
            {product?.name} · {product ? rupee(product.price_per_seat_month) : ""}/user/month + GST.
            {" "}{resellerName} will prepare a GST quote and follow up.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <FormField label="How many users?" required htmlFor="seats">
            <Input
              id="seats"
              type="number"
              inputMode="numeric"
              min={1}
              error={errors.seats?.message}
              {...register("seats")}
            />
          </FormField>

          <FormField label="Anything we should know? (optional)" htmlFor="note">
            <Textarea
              id="note"
              rows={3}
              placeholder="e.g. migrating from another provider, need it before month-end…"
              error={errors.note?.message}
              {...register("note")}
            />
          </FormField>

          <DialogFooter>
            <Button type="button" variant="default" onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" loading={isSubmitting}>
              <Icon name="send" size={14} className="mr-1.5" />
              Send request
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
