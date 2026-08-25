/**
 * CommandPalette — global ⌘K / Ctrl+K search.
 *
 * Includes:
 * - Navigate to any page
 * - Search customers / leads / quotes / invoices / subscriptions / contacts / payments
 * - Run quick actions (new lead, new quote, etc.)
 *
 * ⚠️ The line above used to read "(stub data — to be wired to Supabase)" and was FALSE —
 * corrected 25 Aug 2026. The seven `use*` query hooks imported below have been real Supabase
 * reads for some time. It is left visible rather than quietly deleted because a stale comment
 * costs more than a wrong one: anybody opening this file to add search believed the feature
 * was a mock and would have built it a second time.
 *
 * @example consumer-side
 * const { open, isOpen, setOpen } = useCommandPalette();
 * <button onClick={open}>⌘K</button>
 * <CommandPalette open={isOpen} onOpenChange={setOpen} />
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { Command } from "cmdk";

import { Dialog, DialogContent, DialogPortal, DialogOverlay } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { APP_NAV, filterNavForRole, type UserRole } from "@/lib/nav";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { rupee, cn } from "@/lib/utils";
// Real-data queries — Linear/Notion-style universal search. Each hook is
// already cached by TanStack Query so opening the palette is instant once
// the user has visited the corresponding page at least once. First-time
// open shows a brief loading flicker per group (acceptable trade-off).
import { useLeads } from "@/lib/queries/leads";
import { useCustomers } from "@/lib/queries/customers";
import { useQuotes } from "@/lib/queries/quotes";
import { useAllContacts } from "@/lib/queries/contacts";
import { useInvoices } from "@/lib/queries/invoices";
import { useSubscriptions } from "@/lib/queries/subscriptions";
import { usePayments } from "@/lib/queries/payments";
import { formatDate } from "@/lib/utils";
import {
  customerKeywords, leadKeywords, quoteKeywords,
  invoiceKeywords, subscriptionKeywords, contactKeywords,
} from "@/lib/search/keywords";
import AddSeatsDialog from "@/components/features/subscriptions/add-seats-dialog";
import type { Subscription } from "@/lib/supabase/database.types";

// ============================================================
// Hook to manage open state + register ⌘K shortcut
// ============================================================
export function useCommandPalette() {
  const [isOpen, setOpen] = React.useState(false);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return { isOpen, setOpen, open: () => setOpen(true), close: () => setOpen(false) };
}

/**
 * How many rows per group to render when NOTHING has been typed — a browsable
 * preview, not a search result.
 *
 * This used to be applied unconditionally: `customers.slice(0, MAX_PER_GROUP)`.
 * The order was backwards. Slicing happened BEFORE cmdk filtered, so only the
 * first ten rows of each group were ever rendered and therefore only those ten
 * could ever be matched. With 340 records across the groups, roughly 70 were
 * searchable and 270 were invisible — searching "excel" returned a different
 * customer entirely, because Excel Technologies was the 30-somethingth row and
 * never made it into the DOM.
 *
 * The old comment claimed "cmdk's filter then narrows further as they type",
 * which is exactly what could not happen: a filter cannot widen a set that was
 * already truncated.
 *
 * So the cap now applies ONLY to the empty-query view. The moment the operator
 * types, every row is rendered and cmdk filters the whole set. Rendering a few
 * hundred rows is what cmdk is built for, and measured scoring cost across the
 * entire working set is ~2.5ms per keystroke.
 */
const PREVIEW_PER_GROUP = 10;

// ============================================================
// CommandPalette
// ============================================================
export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();

  // Pull real tenant-scoped data. RLS ensures we only see this tenant's
  // rows. Queries are cached by TanStack Query — opening the palette
  // multiple times is instant after first load.
  const { data: leads }     = useLeads();
  const { data: customers } = useCustomers();
  const { data: quotes }    = useQuotes({ status: "all" });
  const { data: contacts }  = useAllContacts();
  const { data: invoices }  = useInvoices({ status: "all" });
  const { data: subscriptions } = useSubscriptions();
  const { data: payments }  = usePayments();
  const { data: me }        = useCurrentUser();

  // customer_id → name, so payments (which store no customer_name) become
  // name-searchable in the palette.
  const customerNameById = React.useMemo(() => {
    const m = new Map<string, string>();
    (customers ?? []).forEach((c) => m.set(c.id, c.name));
    return m;
  }, [customers]);

  // Page list must respect the SAME role gating as the sidebar — otherwise a
  // sales user could ⌘K into owner/accounting destinations that just bounce off
  // middleware. Also de-dupe by href: the accountant "Filing" section reuses the
  // Accounting hrefs, so a shared route (P&L, GST, aging…) would otherwise list
  // twice. First section to claim an href wins.
  const pageItems = React.useMemo(() => {
    const nav = filterNavForRole(APP_NAV, me?.role as UserRole | undefined, { canViewDeals: me?.canViewDeals });
    const seen = new Set<string>();
    return nav.flatMap((section) =>
      section.items
        .filter((item) => !seen.has(item.href) && seen.add(item.href))
        .map((item) => ({ ...item, section: section.section })),
    );
  }, [me?.role, me?.canViewDeals]);

  const go = (href: string) => {
    onOpenChange(false);
    router.push(href as Route);
  };

  // Controlled so the Add-seats group can stay hidden until the operator has
  // typed something (see that group for why), and so the query does not persist
  // into the next open — reopening onto a stale search reads as a stuck palette.
  const [query, setQuery] = React.useState("");
  React.useEffect(() => { if (!open) setQuery(""); }, [open]);

  // Seats can only be added to something currently running. A paused or expired
  // subscription needs reviving first, and offering the action on one would send
  // the operator into a dialog that cannot succeed.
  const activeSubs = React.useMemo(
    () => (subscriptions ?? []).filter((s) => s.status === "active"),
    [subscriptions],
  );

  // Show a short preview per group when nothing is typed; render EVERYTHING once
  // the operator types, so cmdk can filter the whole set rather than a truncated
  // slice of it. See PREVIEW_PER_GROUP for why this is conditional.
  const searching = query.trim().length > 0;
  const cap = React.useCallback(
    <T,>(rows: T[]): T[] => (searching ? rows : rows.slice(0, PREVIEW_PER_GROUP)),
    [searching],
  );

  // Which subscription the seats dialog is open for, if any.
  const [addSeatsSub, setAddSeatsSub] = React.useState<Subscription | null>(null);


  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay />
        <DialogContent
          className={cn(
            "p-0 max-w-2xl top-[12vh] translate-y-0",
            "overflow-hidden"
          )}
          hideClose
        >
          <Command
            label="Command palette"
            shouldFilter
            className="bg-transparent"
          >
            {/* Search input */}
            <div className="flex items-center gap-3 px-4 py-3 border-b border-hairline">
              <Icon name="search" size={18} className="text-ink-3" />
              <Command.Input
                value={query}
                onValueChange={setQuery}
                placeholder="Search customers, leads, quotes, invoices, or run an action…"
                className="flex-1 bg-transparent border-0 outline-none text-base text-ink placeholder:text-ink-4 font-sans"
              />
              <kbd className="text-3xs px-1.5 py-0.5 rounded bg-paper-2 border border-hairline text-ink-3 font-mono">
                ESC
              </kbd>
            </div>

            <Command.List className="max-h-[60vh] overflow-y-auto p-2">
              <Command.Empty className="py-8 text-center text-sm text-ink-3">
                No results found.
              </Command.Empty>

              {/* Quick actions */}
              <Command.Group heading="Quick Actions" className="cmdk-group">
                <PaletteItem
                  icon="plus"
                  label="Create new lead"
                  meta="Open the quick-add form"
                  onSelect={() => go("/leads?action=quick-add")}
                />
                <PaletteItem
                  icon="file"
                  label="Create new quote"
                  meta="Open Quote Builder"
                  onSelect={() => go("/quotes/new")}
                />
                <PaletteItem
                  icon="receipt"
                  label="Create invoice"
                  meta="Direct GST tax invoice"
                  onSelect={() => go("/quotes/new?invoice=1")}
                />
                <PaletteItem
                  icon="rupee"
                  label="Record a payment"
                  meta="Open an invoice to record what you received"
                  onSelect={() => go("/invoices")}
                />
                <PaletteItem
                  icon="users"
                  label="Add new customer"
                  meta="Open new customer form"
                  onSelect={() => go("/customers/new")}
                />
                <PaletteItem
                  icon="send"
                  label="Launch new campaign"
                  meta="Email or WhatsApp blast"
                  onSelect={() => go("/campaigns")}
                />
                <PaletteItem
                  icon="mail"
                  label="Send renewal reminders"
                  meta="Go to Renewals"
                  onSelect={() => go("/renewals")}
                />
              </Command.Group>

              {/* Pages — role-filtered + href-deduped (see pageItems) */}
              <Command.Group heading="Pages">
                {pageItems.map((item) => (
                  <PaletteItem
                    key={item.id}
                    icon={item.icon}
                    label={item.label}
                    meta={item.section}
                    onSelect={() => go(item.href)}
                  />
                ))}
              </Command.Group>

              {/* Customers — real, tenant-scoped */}
              {customers && customers.length > 0 && (
                <Command.Group heading={`Customers · ${customers.length}`}>
                  {cap(customers).map((c) => {
                    const meta = [c.contact_name, c.contact_email, c.domain].filter(Boolean).join(" · ");
                    return (
                      <PaletteItem
                        key={c.id}
                        icon="users"
                        label={c.name}
                        meta={meta || c.id}
                        keywords={customerKeywords(c)}
                        onSelect={() => go(`/customers/${c.id}`)}
                      />
                    );
                  })}
                </Command.Group>
              )}

              {/* Leads — real, tenant-scoped. Deep-links to /leads?lead=<id>
                  which pops the detail drawer (existing pattern). */}
              {leads && leads.length > 0 && (
                <Command.Group heading={`Leads · ${leads.length}`}>
                  {cap(leads).map((l) => {
                    const stage = l.stage ? `${l.stage}` : "";
                    const value = l.value ? rupee(l.value, { compact: true }) : "";
                    const plan = l.plan ?? "No plan";
                    const meta = [plan, value, stage].filter(Boolean).join(" · ");
                    return (
                      <PaletteItem
                        key={l.id}
                        icon="target"
                        label={l.company}
                        meta={meta}
                        keywords={leadKeywords(l)}
                        onSelect={() => go(`/leads?lead=${l.id}`)}
                      />
                    );
                  })}
                </Command.Group>
              )}

              {/* Contacts — unified across leads/customers/imported */}
              {contacts && contacts.length > 0 && (
                <Command.Group heading={`Contacts · ${contacts.length}`}>
                  {cap(contacts).map((c) => (
                    <PaletteItem
                      key={c.id}
                      icon="user"
                      label={c.name || c.email || c.phone || "(unnamed)"}
                      meta={[c.company, c.email, c.phone].filter(Boolean).join(" · ")}
                      keywords={contactKeywords(c)}
                      onSelect={() => go("/contacts")}
                    />
                  ))}
                </Command.Group>
              )}

              {/* Quotes — real tenant-scoped quotes with status + ₹ */}
              {quotes && quotes.length > 0 && (
                <Command.Group heading={`Quotes · ${quotes.length}`}>
                  {cap(quotes).map((q) => {
                    const total = q.amount != null ? rupee(q.amount, { compact: true }) : "";
                    const meta = [q.customer_name, total, q.status].filter(Boolean).join(" · ");
                    return (
                      <PaletteItem
                        key={q.id}
                        icon="file"
                        label={q.id}
                        meta={meta}
                        keywords={quoteKeywords(q)}
                        onSelect={() => go(`/quotes/${q.id}`)}
                      />
                    );
                  })}
                </Command.Group>
              )}

              {/* Invoices — real, tenant-scoped. Deep-links to /invoices?open=<id>
                  which auto-opens that invoice's preview (existing pattern). */}
              {invoices && invoices.length > 0 && (
                <Command.Group heading={`Invoices · ${invoices.length}`}>
                  {cap(invoices).map((inv) => {
                    const total = inv.amount != null ? rupee(inv.amount, { compact: true }) : "";
                    const meta = [inv.customer_name, total, inv.status].filter(Boolean).join(" · ");
                    return (
                      <PaletteItem
                        key={inv.id}
                        icon="receipt"
                        label={inv.id}
                        meta={meta}
                        keywords={invoiceKeywords(inv)}
                        onSelect={() => go(`/invoices?open=${inv.id}`)}
                      />
                    );
                  })}
                </Command.Group>
              )}

              {/* Add seats — the on-call emergency path.
                  A customer rings asking for five more seats. This turns that into
                  Ctrl+K → type their name → Enter, with no page load in between,
                  and the pro-rata figure computed by add-seats-dialog.

                  SHOWN ONLY ONCE SOMETHING IS TYPED. One item per active
                  subscription would otherwise add ~38 rows to a palette that opens
                  cold, pushing navigation and quick actions off the first screen to
                  offer an action most opens don't want. Two characters is enough to
                  mean "I am looking for a particular customer". */}
              {activeSubs.length > 0 && query.trim().length >= 2 && (
                <Command.Group heading="Add seats">
                  {cap(activeSubs).map((s) => (
                    <PaletteItem
                      key={`seats-${s.id}`}
                      icon="plus"
                      label={`Add seats — ${s.customer_name}`}
                      meta={[s.plan, s.seats ? `${s.seats} seats now` : null, s.renewal_date ? `renews ${formatDate(s.renewal_date)}` : null]
                        .filter(Boolean).join(" · ")}
                      onSelect={() => {
                        // Close the palette FIRST, then open the dialog on the next
                        // tick. Two Radix dialogs mounted at once fight over the
                        // focus trap and the seats input never receives focus.
                        onOpenChange(false);
                        setTimeout(() => setAddSeatsSub(s), 0);
                      }}
                    />
                  ))}
                </Command.Group>
              )}

              {/* Subscriptions — real, tenant-scoped */}
              {subscriptions && subscriptions.length > 0 && (
                <Command.Group heading={`Subscriptions · ${subscriptions.length}`}>
                  {cap(subscriptions).map((s) => {
                    const mrr = s.mrr ? `${rupee(s.mrr, { compact: true })}/mo` : "";
                    const meta = [s.plan, mrr, s.status].filter(Boolean).join(" · ");
                    return (
                      <PaletteItem
                        key={s.id}
                        icon="refresh"
                        label={s.customer_name}
                        meta={meta}
                        keywords={subscriptionKeywords(s)}
                        onSelect={() => go("/subscriptions")}
                      />
                    );
                  })}
                </Command.Group>
              )}

              {/* Payments — no customer_name column, so we resolve it from the
                  customers cache to make receipts name-searchable. */}
              {payments && payments.length > 0 && (
                <Command.Group heading={`Payments · ${payments.length}`}>
                  {cap(payments).map((p) => {
                    const who = (p.customer_id && customerNameById.get(p.customer_id)) || "Payment";
                    const amount = rupee(p.amount, { compact: true });
                    const meta = [amount, p.method, formatDate(p.received_at), p.reference].filter(Boolean).join(" · ");
                    return (
                      <PaletteItem
                        key={p.id}
                        icon="rupee"
                        label={who}
                        meta={meta}
                        onSelect={() => go("/payments")}
                      />
                    );
                  })}
                </Command.Group>
              )}
            </Command.List>

            {/* Footer hint */}
            <div className="flex items-center gap-3 px-3 py-2 border-t border-hairline bg-paper-2 text-2xs text-ink-3">
              <span className="flex items-center gap-1">
                <kbd className="text-3xs px-1 py-0.5 rounded bg-paper border border-hairline font-mono">↑↓</kbd>
                navigate
              </span>
              <span className="flex items-center gap-1">
                <kbd className="text-3xs px-1 py-0.5 rounded bg-paper border border-hairline font-mono">↵</kbd>
                select
              </span>
              <span className="flex items-center gap-1">
                <kbd className="text-3xs px-1 py-0.5 rounded bg-paper border border-hairline font-mono">ESC</kbd>
                close
              </span>
            </div>
          </Command>
        </DialogContent>
      </DialogPortal>
    </Dialog>

    {/* Rendered as a SIBLING of the palette, not inside it. Nesting it under the
        palette's DialogContent would unmount the seats dialog the moment the
        palette closes — which is exactly when it needs to appear. */}
    {addSeatsSub && (
      <AddSeatsDialog
        sub={addSeatsSub}
        open={!!addSeatsSub}
        onOpenChange={(v) => { if (!v) setAddSeatsSub(null); }}
      />
    )}
    </>
  );
}

// ============================================================
// PaletteItem — styled cmdk Item
// ============================================================
function PaletteItem({
  icon,
  label,
  meta,
  keywords,
  onSelect,
}: {
  icon: string;
  label: string;
  meta?: string;
  /**
   * Extra terms to match on that are NOT displayed — phone digits, GSTIN, the
   * contact's name. Without these the palette could only find a row by what the
   * row happened to show, so a lead was unfindable by the person's name or
   * number: the two things you actually have when the phone rings.
   *
   * Kept out of `meta` on purpose. Padding the visible line makes rows
   * unreadable AND flattens cmdk's ranking, so the right answer stops coming
   * first.
   */
  keywords?: string[];
  onSelect: () => void;
}) {
  return (
    <Command.Item
      keywords={keywords}
      onSelect={onSelect}
      className={cn(
        "flex items-center gap-3 px-3 py-2 rounded-md cursor-pointer",
        "data-[selected=true]:bg-paper-2",
        "text-ink hover:bg-paper-2"
      )}
    >
      <Icon name={icon} size={15} className="text-ink-3 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{label}</div>
        {meta && <div className="text-2xs text-ink-3 truncate">{meta}</div>}
      </div>
    </Command.Item>
  );
}
