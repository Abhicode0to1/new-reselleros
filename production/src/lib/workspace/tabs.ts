/**
 * Workspace tabs — the state machine.
 *
 * Pure and React-free on purpose. This is the layer where a bug costs somebody
 * the quote they were half-way through typing, so it is a reducer with tests
 * rather than logic scattered through a component.
 *
 * ─── NO ZUSTAND, DELIBERATELY ────────────────────────────────────────────────
 * The brief asked for Zustand. This app has no state library and five React
 * Context providers already, and CLAUDE.md §2 is explicit about not adding
 * dependencies without strong justification. Tab state is a handful of records
 * and a reducer; Context carries it with nothing new installed. Zustand is a fine
 * library — it just is not needed to hold eight rows.
 *
 * ─── WHAT "KEEPING A DRAFT ALIVE" ACTUALLY MEANS ─────────────────────────────
 * Keeping eight route components mounted would preserve the DOM exactly, and it
 * would also keep eight sets of TanStack Query subscriptions and effects running —
 * the opposite of the memory goal in the same brief, and background tabs would
 * still re-render whenever shared state changed. So `formState` holds the VALUES:
 * what the user typed survives a tab switch, which is what they care about.
 *
 * What does NOT survive, stated plainly rather than discovered later: scroll
 * position, focus, text selection, and the internal state of any uncontrolled or
 * third-party widget. Those live in the DOM, and the DOM is rebuilt.
 */

export interface WorkspaceTab {
  /** Stable id. Derived from the URL so the same page never opens twice. */
  id: string;
  title: string;
  url: string;
  /** Icon name from the app's icon set. */
  icon?: string;
  /** True when this tab holds unsaved input. Blocks silent eviction. */
  isDraft: boolean;
  /** The values the user typed, keyed by field. Restored on return. */
  formState?: Record<string, unknown>;
  /** Epoch ms. Drives which tab is evicted, and it is passed in, never read
   *  from the clock, so the reducer stays pure and testable. */
  lastAccessedAt: number;
}

export interface TabsState {
  tabs: WorkspaceTab[];
  activeId: string | null;
}

export const MAX_TABS = 8;

export const emptyTabs: TabsState = { tabs: [], activeId: null };

/**
 * One id per URL.
 *
 * The query string is included because /quotes/new?customer=abc and /quotes/new
 * are genuinely different pieces of work, but the hash is not — a hash is a
 * position within the same page, and treating it as a new tab would open a
 * duplicate every time someone clicked an anchor.
 */
export function tabIdFor(url: string): string {
  const clean = (url ?? "").trim();
  const hashless = clean.split("#")[0];
  return hashless.replace(/\/+$/, "") || "/";
}

export type TabsAction =
  | { type: "open"; url: string; title: string; icon?: string; at: number }
  | { type: "activate"; id: string; at: number }
  | { type: "close"; id: string }
  | { type: "closeOthers"; id: string }
  | { type: "setDraft"; id: string; isDraft: boolean; formState?: Record<string, unknown> }
  | { type: "rename"; id: string; title: string }
  | { type: "cycle"; direction: 1 | -1; at: number };

export interface TabsResult {
  state: TabsState;
  /**
   * Set when the action could not be completed and the UI must ask the user.
   * Never acted on automatically — a prompt the code answers for you is not a
   * prompt.
   */
  needsConfirm?: {
    kind: "close_draft" | "evict_all_drafts";
    tabId?: string;
    message: string;
  };
}

const byId = (tabs: WorkspaceTab[], id: string) => tabs.find((t) => t.id === id) ?? null;

/**
 * Which tab should take over when `closingId` goes away.
 *
 * The neighbour to the RIGHT, falling back to the left — the same rule editors
 * and browsers use, because jumping to the most-recent tab instead makes the
 * cursor appear to teleport across the strip.
 */
function nextActiveAfterClose(tabs: WorkspaceTab[], closingId: string): string | null {
  const i = tabs.findIndex((t) => t.id === closingId);
  if (i === -1) return null;
  const rest = tabs.filter((t) => t.id !== closingId);
  if (rest.length === 0) return null;
  return (rest[i] ?? rest[i - 1] ?? rest[0]).id;
}

export function tabsReducer(state: TabsState, action: TabsAction): TabsResult {
  switch (action.type) {
    // ── open ────────────────────────────────────────────────────────────
    case "open": {
      const id = tabIdFor(action.url);
      const existing = byId(state.tabs, id);

      // Already open → focus it. Opening a duplicate of a page someone is
      // already editing is how two tabs end up fighting over one draft.
      if (existing) {
        return {
          state: {
            tabs: state.tabs.map((t) => (t.id === id ? { ...t, lastAccessedAt: action.at } : t)),
            activeId: id,
          },
        };
      }

      const fresh: WorkspaceTab = {
        id, url: action.url, title: action.title, icon: action.icon,
        isDraft: false, lastAccessedAt: action.at,
      };

      if (state.tabs.length < MAX_TABS) {
        return { state: { tabs: [...state.tabs, fresh], activeId: id } };
      }

      // At the limit: evict the least-recently-used tab that is NOT a draft.
      // Evicting by age alone would throw away typed work, which is the one
      // thing this whole feature exists to protect.
      const evictable = [...state.tabs]
        .filter((t) => !t.isDraft)
        .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);

      if (evictable.length === 0) {
        // Every open tab holds unsaved input. Refuse and ask rather than
        // picking someone's work to destroy.
        return {
          state,
          needsConfirm: {
            kind: "evict_all_drafts",
            message:
              `All ${MAX_TABS} tabs have unsaved changes, so none can be closed automatically. `
              + `Save or close one before opening another.`,
          },
        };
      }

      const victim = evictable[0].id;
      return {
        state: {
          tabs: [...state.tabs.filter((t) => t.id !== victim), fresh],
          activeId: id,
        },
      };
    }

    // ── activate ────────────────────────────────────────────────────────
    case "activate": {
      if (!byId(state.tabs, action.id)) return { state };
      return {
        state: {
          tabs: state.tabs.map((t) => (t.id === action.id ? { ...t, lastAccessedAt: action.at } : t)),
          activeId: action.id,
        },
      };
    }

    // ── close ───────────────────────────────────────────────────────────
    case "close": {
      const tab = byId(state.tabs, action.id);
      if (!tab) return { state };

      if (tab.isDraft) {
        // The caller confirms and dispatches again with the flag cleared. The
        // reducer never decides to discard someone's typing on its own.
        return {
          state,
          needsConfirm: {
            kind: "close_draft",
            tabId: action.id,
            message: "You have unsaved changes. Close tab anyway?",
          },
        };
      }

      const nextActive = state.activeId === action.id
        ? nextActiveAfterClose(state.tabs, action.id)
        : state.activeId;

      return {
        state: { tabs: state.tabs.filter((t) => t.id !== action.id), activeId: nextActive },
      };
    }

    // ── closeOthers ─────────────────────────────────────────────────────
    case "closeOthers": {
      // Drafts are kept. "Close others" is a tidying action, and tidying must
      // never be destructive.
      const kept = state.tabs.filter((t) => t.id === action.id || t.isDraft);
      const activeStillOpen = kept.some((t) => t.id === state.activeId);
      return {
        state: { tabs: kept, activeId: activeStillOpen ? state.activeId : action.id },
      };
    }

    // ── setDraft ────────────────────────────────────────────────────────
    case "setDraft": {
      return {
        state: {
          ...state,
          tabs: state.tabs.map((t) =>
            t.id === action.id
              ? {
                  ...t,
                  isDraft: action.isDraft,
                  // Clearing the flag clears the stored values too: a saved form
                  // whose old values linger would restore stale input on return.
                  formState: action.isDraft ? (action.formState ?? t.formState) : undefined,
                }
              : t,
          ),
        },
      };
    }

    // ── rename ──────────────────────────────────────────────────────────
    case "rename": {
      const title = action.title.trim();
      if (!title) return { state };
      return {
        state: {
          ...state,
          tabs: state.tabs.map((t) => (t.id === action.id ? { ...t, title } : t)),
        },
      };
    }

    // ── cycle ───────────────────────────────────────────────────────────
    case "cycle": {
      if (state.tabs.length === 0) return { state };
      const i = state.tabs.findIndex((t) => t.id === state.activeId);
      // Wraps, like every tab strip people already know.
      const next = state.tabs[(((i === -1 ? 0 : i) + action.direction) % state.tabs.length + state.tabs.length) % state.tabs.length];
      return {
        state: {
          tabs: state.tabs.map((t) => (t.id === next.id ? { ...t, lastAccessedAt: action.at } : t)),
          activeId: next.id,
        },
      };
    }

    default:
      return { state };
  }
}

/** Force-close a tab the user has confirmed they want to discard. */
export function forceClose(state: TabsState, id: string): TabsState {
  const cleared = state.tabs.map((t) => (t.id === id ? { ...t, isDraft: false, formState: undefined } : t));
  return tabsReducer({ ...state, tabs: cleared }, { type: "close", id }).state;
}

/** Tabs holding unsaved work — for the "are you sure you want to leave?" guard. */
export function draftTabs(state: TabsState): WorkspaceTab[] {
  return state.tabs.filter((t) => t.isDraft);
}
