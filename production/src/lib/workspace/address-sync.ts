/**
 * The address bar is the truth. (R-068)
 *
 * Two pure decisions the tab provider used to make inline, both of which went wrong:
 *
 * 1. WHEN may the provider rewrite the URL? It called `router.replace(<active tab's history
 *    cursor>)` on hydration and on ANY change to the tabs array (a draft flag flipping was
 *    enough). If the stored cursor pointed somewhere other than the page the user had just
 *    opened, the app navigated them away on its own. Seen live: `/leads` opened directly,
 *    the app replaced it with `/renewals` a few seconds later (the dev compile time of
 *    /renewals), over and over, until sessionStorage was cleared.
 *    Now: only on a genuine switch of the active tab, and never to the address already shown.
 *
 * 2. WHERE does an address change get recorded? The record effect also ran when the active
 *    tab CHANGED, so switching or closing a tab pushed the OLD tab's url into the NEW tab's
 *    history — the replace then put the right page back, and the next switch did it again.
 *    That is how `/leads`'s own stack became `/leads, /renewals, /leads, /renewals …`.
 *    Now: recorded only when the address changes, into the tab that owns it.
 */
import { pushUrl, currentUrl, emptyHistory, type TabHistory } from "./history";
import { tabIdFor, type TabsState } from "./tabs";

export interface AddressRecord {
  /** A different open tab owns the new address — activate it. Null: stay. */
  activateId: string | null;
  /** Same object when nothing changed, so callers can skip a state update. */
  histories: Record<string, TabHistory>;
}

/**
 * The address changed (a link, the address bar, a reload). Make the histories agree with it.
 *
 * - Already where the active tab's cursor is → nothing to do.
 * - An open tab's own page (by id) → that tab owns it: record it there and activate it,
 *   instead of filing it in whichever tab happened to be active.
 * - Otherwise → an in-tab navigation of the active tab, exactly as before.
 */
export function recordAddress(
  state: TabsState,
  histories: Record<string, TabHistory>,
  address: string,
): AddressRecord {
  const url = (address ?? "").trim();
  const active = state.activeId;
  if (!url || !active) return { activateId: null, histories };

  const historyOf = (id: string): TabHistory => {
    if (histories[id]) return histories[id];
    // A tab that has never recorded anything is still showing its own page; seed with it so
    // the first navigation away leaves something for Back to return to.
    const tab = state.tabs.find((t) => t.id === id);
    return tab ? { stack: [tab.url], cursor: 0 } : emptyHistory;
  };

  if (currentUrl(historyOf(active)) === url) {
    return histories[active] ? { activateId: null, histories }
      : { activateId: null, histories: { ...histories, [active]: historyOf(active) } };
  }

  const owner = state.tabs.find((t) => t.id === tabIdFor(url));
  const target = owner ? owner.id : active;
  const before = historyOf(target);
  const after = pushUrl(before, url);
  return {
    activateId: target === active ? null : target,
    histories: after === histories[target] ? histories : { ...histories, [target]: after },
  };
}

/**
 * The URL to `router.replace` to after `state.activeId` changed from `prevActiveId`, or null
 * for "leave the address alone".
 *
 * Null when:
 * - there was no previous active tab (hydration, or the first tab being adopted) — the page
 *   in front of the user is the one they opened, whatever an old session stored;
 * - the active tab did not change (the tabs array changed for another reason, e.g. a draft
 *   flag) — nobody asked to go anywhere;
 * - the target is already the address (the switch was itself caused by the address).
 */
export function urlForTabSwitch(
  prevActiveId: string | null,
  state: TabsState,
  histories: Record<string, TabHistory>,
  address: string,
): string | null {
  const id = state.activeId;
  if (!id || !prevActiveId || prevActiveId === id) return null;
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab) return null;
  const target = (histories[id] && currentUrl(histories[id])) || tab.url;
  return target === (address ?? "").trim() ? null : target;
}
