"use client";

/**
 * Domain search, on the customer's own Domains page.
 *
 * Pardeep, 16 Sep 2026: "here add the domain search also, so that user does not
 * have navigate elsewhere if needed." The page already listed what they own and
 * let them WATCH a name that was taken; the missing third of it was finding out
 * whether a name is free in the first place.
 *
 * ─── ONE LOOKUP, NOT A SECOND COPY ──────────────────────────────────────────
 * `searchDomains` is the marketing site's own implementation and its header
 * spells out why it is shared: "two copies of a money-and-availability call is
 * precisely how the two drift — one gets fixed, the other keeps lying." That
 * argument applies to this surface at least as strongly, because this reader is
 * already a paying customer. So this component renders; it does not look up.
 *
 * ─── THREE OUTCOMES PER NAME, AND THE THIRD IS THE ONE THAT MATTERS ─────────
 *   available          say so, with the price when the registrar gave one
 *   taken              say so, and offer the watch that already exists below
 *   COULD NOT CHECK    say exactly that
 *
 * `checked === false` must never be drawn as "taken". The API comment makes the
 * asymmetry explicit — a wrong TAKEN loses a sale silently, while a wrong
 * AVAILABLE is caught the moment somebody tries to register it. A row we could
 * not check gets its own line rather than being folded into either.
 *
 * ─── NO PHONE NUMBER IN THE FAILURE PATH ────────────────────────────────────
 * `UNREACHABLE` from the shared module ends "...or WhatsApp us." That is right
 * for the marketing site and wrong here: support in the portal goes through the
 * ticket system (Pardeep, 16 Sep 2026). This file states its own message and
 * points at a ticket.
 */

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import { Badge } from "@/components/ui/badge";
import { rupee } from "@/lib/utils";
import {
  searchDomains,
  normaliseName,
  DEFAULT_TLDS,
  type DomainResult,
} from "@/site/lib/domain-search";

/** The portal's own wording — the shared one offers WhatsApp, which we do not. */
const COULD_NOT_CHECK =
  "We couldn't reach the registry just now. Try again in a moment, or raise a ticket and we will look it up for you.";

/**
 * The ticket link, carrying what the customer was just shown.
 *
 * Without the price and the term, the ticket says only "Please register
 * acme.in" and somebody on the team has to look the name up again to answer a
 * question the customer already had the answer to. Worse, the customer has no
 * record of the number they saw.
 *
 * It states what the SEARCH SHOWED, in the past tense, rather than quoting a
 * price — the figure comes from the registrar at the moment of the search and
 * the team confirms it on the ticket. `years` matters and is not decoration:
 * .ai is sold in a 2-year minimum, so "for 1 year" would be wrong for it.
 */
function registerHref(r: DomainResult): Route {
  const opening = `I would like to register ${r.domain}.`;
  const body = r.priceKnown
    ? `${opening}

The search on my Domains page showed it as available at ` +
      `${rupee(r.price)} for ${r.years} year${r.years === 1 ? "" : "s"}.` +
      `
Please confirm and let me know how to pay.`
    : `${opening}

The search on my Domains page showed it as available, but no ` +
      `price came back for it.` +
      `
Please confirm the price and let me know how to pay.`;
  /* `as Route`: next.config sets experimental.typedRoutes, which can check a
     literal template at the call site but not a string returned from here. */
  return (`/portal/support/new?subject=${encodeURIComponent(`Please register ${r.domain}`)}` +
    `&body=${encodeURIComponent(body)}`) as Route;
}

export function DomainSearch({ onWatch }: { onWatch: (domain: string) => void }) {
  const [term, setTerm] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [results, setResults] = React.useState<DomainResult[] | null>(null);
  const [failed, setFailed] = React.useState<string | null>(null);
  const [searched, setSearched] = React.useState("");

  /* The same normaliser the lookup uses, so the button cannot enable on
     something the search would strip to nothing. */
  const base = normaliseName(term);
  const ready = base.length > 0 && !busy;

  async function run(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setFailed(null);
    setResults(null);
    const outcome = await searchDomains(base, DEFAULT_TLDS);
    if (outcome.ok) {
      setResults(outcome.domains);
      setSearched(outcome.base);
    } else {
      setFailed(COULD_NOT_CHECK);
    }
    setBusy(false);
  }

  return (
    <Card className="p-4 md:p-5 mt-6">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h2 className="font-serif text-lg text-ink">Find a new name</h2>
        <p className="text-2xs text-ink-3">{DEFAULT_TLDS.map((t) => `.${t}`).join(" · ")}</p>
      </div>
      <p className="text-sm text-ink-3 mt-1">
        Check whether a name is free before you ask for it. We check the registry live.
      </p>

      <form onSubmit={run} className="mt-4 flex flex-col sm:flex-row gap-2">
        <label htmlFor="domain-search" className="sr-only">
          Domain name to look up
        </label>
        <Input
          id="domain-search"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="e.g. theonewewant"
          className="flex-1 font-mono"
          wrapperClassName="flex-1"
          autoComplete="off"
          spellCheck={false}
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          disabled={busy}
          helper="Just the name — we add the endings for you."
        />
        <Button
          type="submit"
          variant="primary"
          icon="search"
          loading={busy}
          disabled={!ready}
          title={ready ? undefined : "Type a name to look up"}
        >
          Check
        </Button>
      </form>

      {failed && (
        <p className="mt-4 text-sm text-rose-ink">
          {failed}{" "}
          <Link href="/portal/support/new" className="underline hover:text-ink">
            Raise a ticket
          </Link>
          .
        </p>
      )}

      {results && results.length === 0 && (
        <p className="mt-4 text-sm text-ink-3">
          The registry did not answer for any ending we tried. Please try again in a moment.
        </p>
      )}

      {results && results.length > 0 && (
        <ul className="mt-4 divide-y divide-hairline">
          {results.map((r) => {
            /* Absent `checked` means an older payload, which was always a real
               answer — so only an explicit false is "we do not know". */
            const unknown = r.checked === false;
            return (
              <li key={r.domain} className="flex items-center justify-between gap-3 py-3 flex-wrap">
                <div className="min-w-0">
                  <p className="font-mono text-sm text-ink break-all">{r.domain}</p>
                  {unknown ? (
                    <p className="text-2xs text-ink-3 mt-0.5">We couldn&apos;t check this one.</p>
                  ) : r.available ? (
                    <p className="text-2xs text-ink-3 mt-0.5">
                      {r.priceKnown
                        ? `${rupee(r.price)} for ${r.years} year${r.years === 1 ? "" : "s"}`
                        : "Price on request"}
                    </p>
                  ) : (
                    <p className="text-2xs text-ink-3 mt-0.5">Someone already owns this one.</p>
                  )}
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {unknown ? (
                    <Badge kind="muted" size="sm">Unknown</Badge>
                  ) : r.available ? (
                    <>
                      <Badge kind="success" size="sm" dot>Available</Badge>
                      <Button asChild size="sm" variant="primary">
                        <Link href={registerHref(r)}>Ask to register</Link>
                      </Button>
                    </>
                  ) : (
                    <>
                      <Badge kind="muted" size="sm">Taken</Badge>
                      {/* The watch box already lives on this page — send the name
                          to it rather than making them retype it. */}
                      <Button
                        size="sm"
                        variant="default"
                        icon="bell"
                        onClick={() => onWatch(r.domain)}
                      >
                        Watch it
                      </Button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {results && results.length > 0 && (
        <p className="mt-3 text-2xs text-ink-3">
          <Icon name="info" size={11} className="inline mr-1 align-text-bottom" />
          Checked just now for <span className="font-mono">{searched}</span>. Registering is done by
          us — ask and we will take it from there.
        </p>
      )}
    </Card>
  );
}
