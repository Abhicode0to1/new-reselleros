"use client";

/**
 * Web hosting in the customer portal's shop — browse, pick a domain, pay.
 *
 * Pardeep, 12 Sep 2026: "Put hosting in the portal shop, so a logged-in customer
 * can buy without going back to the marketing site."
 *
 * ─── WHY THIS IS NOT A CARD IN THE SEAT GRID ────────────────────────────────
 * The grid next to it sells LICENCES: a price per user per month, a seats box,
 * and a "Request a quote" that raises a lead. Hosting is none of those. It is
 * one account, on one domain, charged per month — so the number that matters is
 * ₹/month not ₹/user/month, the field that matters is a domain not a quantity,
 * and it is paid for now rather than quoted later. Rendering it as a seat card
 * would have printed "₹499/user/month" against a product with no users, and
 * offered a quote for something the customer can simply buy.
 *
 * (Before this existed, synced hosting plans DID appear in that grid, filed
 * under "More products" — one product listed once, described wrongly. The
 * migration that added `portal_list_hosting_plans` also takes them out of
 * `portal_list_products`, which is why they cannot appear twice now.)
 *
 * ─── THE DOMAIN IS ASKED FOR BEFORE THE MONEY ───────────────────────────────
 * Provisioning derives the cPanel username from the domain deterministically,
 * so the domain has to be settled at order time and cannot be changed after.
 * The dialog therefore asks for it first, shows exactly what will be charged,
 * and only then opens Razorpay — rather than taking payment and discovering in
 * the worker an hour later that there is nothing to provision onto.
 *
 * The server re-reads the price from the reseller's catalogue and ignores
 * anything this component thinks it costs; see the route's own header.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Icon } from "@/components/ui/icon";
import { rupee } from "@/lib/utils";
import { loadRazorpayCheckout } from "@/lib/razorpay/checkout-client";
/* The SAME rate and the SAME rounding the server charges with. This used to be
   a local `const GST_RATE = 18` — two copies of one number, so a change to the
   rate would have shown the customer one total in the dialog and charged them
   another. hosting-order.ts has no server imports, so a client may use it. */
import { HOSTING_GST_RATE, hostingOrderTotals } from "@/lib/portal/hosting-order";

export interface HostingPlan {
  id: string;
  name: string;
  price_month: number;
  period: string | null;
  hsn: string | null;
  quota_mb: number | null;
  bandwidth_mb: number | null;
  features: string[];
  popular: boolean;
}

interface BuyResponse {
  success?: boolean;
  error?: string;
  simulated?: boolean;
  orderId?: string;
  amount?: number;
  currency?: string;
  razorpayKeyId?: string;
  quoteId?: string;
  domain?: string;
  planName?: string;
  customerName?: string;
  totalRupees?: number;
  alreadyHosted?: boolean;
  notConfigured?: boolean;
}

/** MB → the unit a person reads. 10240 is "10 GB", not "10240 MB". */
function storage(mb: number | null): string | null {
  if (!mb || mb <= 0) return null;
  if (mb >= 1024 * 1024) return `${Math.round(mb / (1024 * 1024))} TB`;
  if (mb >= 1024) return `${Math.round(mb / 1024)} GB`;
  return `${mb} MB`;
}

export function HostingSection({
  plans,
  email,
  resellerName,
}: {
  plans: HostingPlan[];
  email: string;
  resellerName: string;
}) {
  const [selected, setSelected] = React.useState<HostingPlan | null>(null);

  if (plans.length === 0) return null;

  return (
    <section>
      <h2 className="text-2xs uppercase tracking-wider text-ink-3 font-semibold mb-3">Web hosting</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {plans.map((p) => {
          const disk = storage(p.quota_mb);
          const bw = storage(p.bandwidth_mb);
          return (
            <Card key={p.id} className="p-5 flex flex-col">
              <div className="flex items-start justify-between gap-2 mb-3">
                <div className="font-serif text-lg text-ink leading-tight">{p.name}</div>
                {p.popular && (
                  <span className="text-3xs uppercase tracking-wider font-semibold text-amber-ink bg-amber-soft px-2 py-0.5 rounded-full whitespace-nowrap">
                    Popular
                  </span>
                )}
              </div>

              <div className="mb-4">
                <span className="font-serif text-2xl text-ink">{rupee(p.price_month)}</span>
                <span className="text-xs text-ink-3"> {p.period || "/mo"}</span>
                <div className="text-2xs text-ink-3 mt-0.5">+ {HOSTING_GST_RATE}% GST · billed monthly</div>
              </div>

              {(disk || bw || p.features.length > 0) && (
                <ul className="space-y-1.5 mb-5 text-xs text-ink-2">
                  {disk && (
                    <li className="flex items-center gap-2">
                      <Icon name="check" size={13} className="text-emerald flex-shrink-0" />
                      {disk} storage
                    </li>
                  )}
                  {bw && (
                    <li className="flex items-center gap-2">
                      <Icon name="check" size={13} className="text-emerald flex-shrink-0" />
                      {bw} bandwidth
                    </li>
                  )}
                  {p.features.slice(0, 4).map((f) => (
                    <li key={f} className="flex items-center gap-2">
                      <Icon name="check" size={13} className="text-emerald flex-shrink-0" />
                      {f}
                    </li>
                  ))}
                </ul>
              )}

              <div className="mt-auto">
                <Button variant="primary" className="w-full justify-center" onClick={() => setSelected(p)}>
                  Buy hosting
                </Button>
              </div>
            </Card>
          );
        })}
      </div>

      <BuyHostingDialog
        plan={selected}
        email={email}
        resellerName={resellerName}
        onClose={() => setSelected(null)}
      />
    </section>
  );
}

function BuyHostingDialog({
  plan,
  email,
  resellerName,
  onClose,
}: {
  plan: HostingPlan | null;
  email: string;
  resellerName: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [domain, setDomain] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (plan) { setDomain(""); setError(null); setBusy(false); }
  }, [plan]);

  const totals = plan ? hostingOrderTotals(plan.price_month) : null;
  const total = totals?.amount ?? 0;

  async function onBuy() {
    if (!plan) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/portal/checkout/hosting", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ itemId: plan.id, domain }),
      });
      const data = (await res.json()) as BuyResponse;

      if (!res.ok || data.error) {
        /* Shown in the dialog rather than as a toast: every one of these is
           something to FIX in the field above (a malformed domain, a domain
           already hosted), and a toast that disappears takes the instruction
           with it. */
        setError(data.error ?? "Couldn't start the order. Please try again.");
        return;
      }

      if (data.simulated) {
        toast.success(`Order placed — ${data.planName} on ${data.domain}.`);
        onClose();
        router.push("/portal/hosting");
        router.refresh();
        return;
      }

      if (data.orderId && data.razorpayKeyId) {
        const Razorpay = await loadRazorpayCheckout();
        const rzp = new Razorpay({
          key: data.razorpayKeyId,
          amount: data.amount ?? 0,
          currency: data.currency ?? "INR",
          name: resellerName,
          description: `${data.planName} · ${data.domain}`,
          order_id: data.orderId,
          prefill: { name: data.customerName, email },
          theme: { color: "#C2410C" },
          handler: () => {
            /* The webhook does the real work — records the payment, raises the
               invoice and queues provisioning. None of that is instant, so this
               promises setup rather than claiming the account already exists. */
            toast.success("Payment received. We're setting up your hosting — you'll get an email shortly.");
            onClose();
            setTimeout(() => { router.push("/portal/hosting"); router.refresh(); }, 2000);
          },
          modal: { ondismiss: () => setBusy(false) },
        });
        rzp.on("payment.failed", (resp) => {
          setError(resp.error?.description ?? "Payment failed. Please try again.");
          setBusy(false);
        });
        rzp.open();
        return;
      }

      setError("Payment couldn't be started. Please contact " + resellerName + ".");
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={Boolean(plan)} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>Buy {plan?.name}</DialogTitle>
          <DialogDescription>
            Your hosting is set up on one domain. Enter the domain you want it on — it
            can&apos;t be changed after setup.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* `error` and `helper` go on the Input, not the FormField: Input owns
              both and wires `aria-describedby` to whichever is showing, so a
              screen reader hears the refusal. A loose <p> underneath would be
              visible and unannounced. */}
          <FormField label="Domain" htmlFor="hosting-domain">
            <Input
              id="hosting-domain"
              placeholder="example.com"
              value={domain}
              autoComplete="off"
              spellCheck={false}
              error={error ?? undefined}
              helper="Just the domain — no http:// and no trailing path."
              onChange={(e) => { setDomain(e.target.value); setError(null); }}
              onKeyDown={(e) => { if (e.key === "Enter" && domain.trim()) void onBuy(); }}
            />
          </FormField>

          {plan && (
            <div className="rounded-md border border-hairline bg-paper-2 p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-ink-2">{plan.name}</span>
                <span className="tabular-nums">{rupee(plan.price_month)}</span>
              </div>
              <div className="flex items-center justify-between text-ink-3 text-xs mt-1">
                <span>GST {HOSTING_GST_RATE}%</span>
                <span className="tabular-nums">{rupee(total - (totals?.subtotal ?? plan.price_month))}</span>
              </div>
              <div className="flex items-center justify-between font-medium border-t border-hairline mt-2 pt-2">
                <span>Total today</span>
                <span className="tabular-nums">{rupee(total)}</span>
              </div>
              <div className="text-2xs text-ink-3 mt-1.5">
                Then {rupee(total)} every month. Cancel any time by contacting {resellerName}.
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="default" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!domain.trim()} onClick={onBuy}>
            {plan ? `Pay ${rupee(total)}` : "Pay"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
