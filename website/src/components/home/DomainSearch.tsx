"use client";
/**
 * The hero's domain-search card — the handoff's exact behaviour:
 *
 *   · debounced 340ms, skeleton rows (wPulse) while pending
 *   · availability is a DETERMINISTIC hash in this prototype stage (`h % 4 === 0` → taken);
 *     production must call the registrar/EPP availability API, and the handoff says so.
 *     Deterministic beats random on purpose — the same name always answers the same way,
 *     so a shared screenshot can be reproduced.
 *   · when any result is taken: an "TAKEN — TRY THESE INSTEAD" chip row of four alternates
 *     (<name>india, get<name>, <name>hq, the<name>)
 *   · Add puts a yearly line in the cart and the drawer opens.
 */
import { useEffect, useRef, useState } from "react";
import { useCart } from "@/components/cart/CartProvider";
import { rupee } from "@/lib/money";
import { TLDS } from "@/lib/data/catalog";
import { effectiveReg } from "@/lib/offers";

function taken(name: string): boolean {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 997;
  return h % 4 === 0;
}

export function DomainSearch() {
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cart = useCart();

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const onInput = (value: string) => {
    setQuery(value);
    setSearching(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setSearching(false), 340);
  };

  const q = query.trim().toLowerCase().replace(/[^a-z0-9-]/g, "") || "yourbusiness";
  const results = TLDS.slice(0, 5).map((t) => {
    const full = q + t.tld;
    return { t, full, gone: taken(full) };
  });
  const anyTaken = results.some((r) => r.gone);
  const alternates = [q + "india", "get" + q, q + "hq", "the" + q].map((base, i) => {
    const t = TLDS[i % 3];
    return { name: base + t.tld, t };
  });

  const addDomain = (name: string, t: (typeof TLDS)[number]) => {
    /* Offer FIRST YEAR par hai; cart line wahi kahe jo sach hai — ₹1 pehla saal,
       renewal poora, offer ka naam saath me. */
    const p = effectiveReg(t.tld, t.reg);
    cart.add({
      label: name,
      detail: p.offer
        ? `Domain registration · ${p.offer.label} first year · renews ${rupee(t.renew)}/yr`
        : `Domain registration · renews ${rupee(t.renew)}/yr`,
      unitPrice: p.reg,
      unit: "year",
      cycle: "yearly",
    });
  };

  return (
    <div className="card" style={{ padding: 26 }}>
      <div className="mono-label" style={{ color: "var(--text-muted)", marginBottom: 10 }}>
        FIND YOUR NAME — LIVE PRICES, RENEWAL INCLUDED
      </div>
      <div style={{ display: "flex", border: "2px solid var(--dark)", borderRadius: 6, overflow: "hidden" }}>
        <input
          value={query}
          onChange={(e) => onInput(e.target.value)}
          placeholder="yourbusiness"
          aria-label="Domain name to search"
          style={{ flex: 1, border: "none", outline: "none", padding: "13px 14px", fontSize: 16, fontFamily: "inherit", minWidth: 0 }}
        />
        <button className="btn btn-primary" style={{ borderRadius: 0, padding: "13px 20px" }}>Search</button>
      </div>

      <div style={{ marginTop: 8 }}>
        {searching
          ? [1, 2, 3, 4, 5].map((i) => (
              <div key={i} style={{ height: 46, borderBottom: "1px solid var(--border-hairline)", display: "flex", alignItems: "center" }}>
                <div style={{ height: 12, width: `${40 + i * 8}%`, background: "var(--border-hairline)", borderRadius: 4, animation: "wPulse 1.1s infinite" }} />
              </div>
            ))
          : results.map(({ t, full, gone }) => (
              <div key={t.tld} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: "1px solid var(--border-hairline)" }}>
                <span className="mono" style={{ fontSize: 15, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={full}>
                  {full}
                </span>
                <span className="mono-label" style={{ color: gone ? "var(--danger)" : "var(--success)" }}>
                  {gone ? "TAKEN" : "AVAILABLE"}
                </span>
                {gone ? (
                  <span className="meta">already registered</span>
                ) : (
                  <>
                    {(() => {
                      const p = effectiveReg(t.tld, t.reg);
                      return p.offer ? (
                        <span style={{ fontSize: 15, fontWeight: 600, whiteSpace: "nowrap" }}>
                          <s style={{ color: "var(--text-disabled)", fontWeight: 400 }}>{rupee(p.offer.was)}</s>{" "}
                          <span style={{ color: "var(--success)" }}>{rupee(p.reg)}</span>
                        </span>
                      ) : (
                        <span style={{ fontSize: 15, fontWeight: 600 }}>{rupee(t.reg)}</span>
                      );
                    })()}
                    <button
                      onClick={() => addDomain(full, t)}
                      style={{ fontSize: 13, fontWeight: 600, color: "var(--primary)", border: "1px solid #9FC5F3", borderRadius: 5, background: "#fff", padding: "5px 12px", cursor: "pointer" }}
                    >
                      Add
                    </button>
                  </>
                )}
              </div>
            ))}
      </div>

      {!searching && anyTaken && (
        <div style={{ marginTop: 14 }}>
          <div className="mono-label" style={{ color: "var(--danger)", marginBottom: 8 }}>TAKEN — TRY THESE INSTEAD</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {alternates.map((a) => (
              <button
                key={a.name}
                className="chip"
                onClick={() => addDomain(a.name, a.t)}
                title={`Add ${a.name} — ${rupee(a.t.reg)}`}
              >
                {a.name} · {rupee(a.t.reg)}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
