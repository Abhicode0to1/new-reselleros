"use client";
/**
 * Cart state for the whole site — one provider, so the header badge, the drawer, the cart
 * page and the checkout all read the SAME lines and the same totals.
 *
 * Persistence is `localStorage` under `anutech.cart.v1`, exactly the handoff's key, with the
 * same caveat the handoff itself states: in production this should become a server-backed
 * cart (or at minimum a signed cookie) so it survives devices and support can recover it.
 * The key is kept so that upgrade can migrate rather than orphan.
 *
 * The drawer-opens-on-add behaviour is the handoff's core commerce interaction: EVERY add
 * opens the right-hand drawer, on every route except cart/checkout/done — those three render
 * the cart already, and a drawer over the cart page would be the site talking over itself.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import { cartTotals, type CartLine, type CartTotals } from "@/lib/money";

const STORAGE_KEY = "anutech.cart.v1";
const NO_DRAWER_ROUTES = ["/cart", "/checkout", "/done"];

interface CartApi {
  lines: CartLine[];
  totals: CartTotals;
  coupon: string;
  setCoupon: (code: string) => void;
  /** Adds (or bumps qty of an identical line) and opens the drawer. */
  add: (line: Omit<CartLine, "key" | "qty"> & { qty?: number }) => void;
  setQty: (key: string, delta: number) => void;
  remove: (key: string) => void;
  clear: () => void;
  drawerOpen: boolean;
  closeDrawer: () => void;
  /** The label of the line just added — the drawer's green headline. */
  justAdded: string | null;
}

const CartContext = createContext<CartApi | null>(null);

export function useCart(): CartApi {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useCart outside CartProvider");
  return ctx;
}

function load(): CartLine[] {
  /* try/catch on every storage touch — private windows and blocked site data throw on the
     accessor itself, and a cart that crashes the page is worse than an empty one. */
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    /* The handoff mentions a migration path for legacy rows ({amount} instead of
       {unitPrice}); honour it rather than dropping a returning visitor's cart. */
    return parsed
      .filter((l): l is Record<string, unknown> => !!l && typeof l === "object")
      .map((l, i) => ({
        key: typeof l.key === "string" ? l.key : `legacy-${i}`,
        label: String(l.label ?? ""),
        detail: String(l.detail ?? ""),
        unitPrice: Number(l.unitPrice ?? l.amount ?? 0),
        qty: Math.max(1, Number(l.qty ?? 1)),
        unit: String(l.unit ?? "item"),
        cycle: (l.cycle === "monthly" || l.cycle === "yearly" ? l.cycle : "once") as CartLine["cycle"],
      }))
      .filter((l) => l.label && Number.isFinite(l.unitPrice));
  } catch {
    return [];
  }
}

function save(lines: CartLine[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(lines));
  } catch {
    /* Storage refused — the in-memory cart still works for this visit. */
  }
}

export function CartProvider({ children }: { children: React.ReactNode }) {
  const [lines, setLines] = useState<CartLine[]>([]);
  const [coupon, setCoupon] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const pathname = usePathname();

  useEffect(() => {
    setLines(load());
  }, []);

  const add = useCallback<CartApi["add"]>(
    (line) => {
      setLines((prev) => {
        /* Same label + same unit price = the same thing; bump qty instead of a duplicate
           row. A cart with two "Positive SSL ₹899" rows reads like a billing mistake. */
        const existing = prev.find((l) => l.label === line.label && l.unitPrice === line.unitPrice);
        const next = existing
          ? prev.map((l) => (l.key === existing.key ? { ...l, qty: l.qty + (line.qty ?? 1) } : l))
          : [...prev, { ...line, qty: line.qty ?? 1, key: `${line.label}-${Date.now()}` }];
        save(next);
        return next;
      });
      setJustAdded(line.label);
      if (!NO_DRAWER_ROUTES.includes(pathname)) setDrawerOpen(true);
    },
    [pathname],
  );

  const setQty = useCallback((key: string, delta: number) => {
    setLines((prev) => {
      const next = prev
        .map((l) => (l.key === key ? { ...l, qty: Math.max(1, l.qty + delta) } : l));
      save(next);
      return next;
    });
  }, []);

  const remove = useCallback((key: string) => {
    setLines((prev) => {
      const next = prev.filter((l) => l.key !== key);
      save(next);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setLines(() => {
      save([]);
      return [];
    });
    setCoupon("");
    setDrawerOpen(false);
  }, []);

  const totals = useMemo(() => cartTotals(lines, coupon), [lines, coupon]);

  const api = useMemo<CartApi>(
    () => ({
      lines,
      totals,
      coupon,
      setCoupon,
      add,
      setQty,
      remove,
      clear,
      drawerOpen,
      closeDrawer: () => setDrawerOpen(false),
      justAdded,
    }),
    [lines, totals, coupon, add, setQty, remove, clear, drawerOpen, justAdded],
  );

  return (
    <CartContext.Provider value={api}>
      {children}
      {/* README "Accessibility": an aria-live region announces cart changes. */}
      <div aria-live="polite" className="sr-only">
        {lines.length === 0
          ? "Cart is empty"
          : `${lines.length} item(s) in cart, ₹${Math.round(totals.payable).toLocaleString("en-IN")} including GST`}
      </div>
    </CartContext.Provider>
  );
}
