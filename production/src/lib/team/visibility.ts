/**
 * Who can see whose records — the hierarchy rules, decided in one place.
 *
 * ─── AND THE FIRST THING TO SAY IS WHAT THIS IS NOT ──────────────────────────
 * This is NOT security. It decides what a screen SHOWS. The security boundary is
 * Postgres row-level security, and until the accompanying migration is applied a rep can
 * still reach a peer's records by calling the API directly — the filter is in the client.
 *
 * That distinction is written here rather than left implied because the failure is silent:
 * a UI that hides Rep B's leads from Rep A looks exactly like a UI that cannot serve them,
 * and somebody will reasonably conclude peer isolation is done. It is done when the RLS
 * policy is live. See supabase/migrations/*_user_hierarchy_visibility.sql.
 *
 * ─── THE TREE DECIDES, THE ROLE ONLY GRANTS THE OVERRIDE ────────────────────
 * "Manager sees subordinates" is a statement about the reporting tree, not about a role
 * name. So scope comes from `manager_id`: anybody with people reporting to them sees their
 * own records plus theirs, however junior their title. The role does exactly one thing —
 * an owner sees everything, because somebody has to be able to.
 *
 * Deriving it from role instead would break the moment a `sales_senior` has nobody
 * reporting to them (they would see a team that does not exist) or a `sales` rep picks up
 * two juniors (they would be blind to the people they are responsible for).
 *
 * ─── AN UNOWNED RECORD BELONGS TO THE COMPANY, NOT TO NOBODY ────────────────
 * The single most important rule here, and the one that stops this feature being an
 * outage. In the live books today, all 25 quotes and all 12 customers have a NULL owner —
 * `owner_id` was simply never filled in. A rule of "you see rows assigned to you or your
 * team" makes every one of those rows invisible to everybody except an owner.
 *
 * So an unassigned row stays VISIBLE to the whole tenant. It is not private data being
 * leaked; it is company data nobody has claimed, and hiding it would delete the books from
 * the screen while the rows sat safely in the database — the worst possible shape of bug,
 * because it looks like data loss.
 */

export type Scope = "all" | "team" | "own";

export interface TeamMember {
  id: string;
  /** Who they report to. Null at the top of the tree. */
  managerId: string | null;
  role: string;
}

/** Roles that see everything, regardless of the tree. */
const SEES_ALL: ReadonlySet<string> = new Set(["owner"]);

/**
 * What this person's scope is.
 *
 * `team` requires ACTUAL subordinates — a manager-titled person with nobody under them
 * gets `own`, because a "Team view" toggle that shows one person is a control that lies
 * about the shape of the organisation.
 */
export function scopeOf(me: TeamMember, all: readonly TeamMember[]): Scope {
  if (SEES_ALL.has(me.role)) return "all";
  return all.some((u) => u.managerId === me.id) ? "team" : "own";
}

/**
 * Every user id whose records this person may see.
 *
 * Returns null for `all` — deliberately not "every id in the tenant". A list of ids would
 * silently stop including somebody the moment a new user is added between the query that
 * built it and the query that used it, and "no restriction" is the honest representation
 * of no restriction.
 */
/**
 * `rootId` plus everybody at or below it in the reporting tree.
 *
 * Breadth-first with a `seen` set. The cycle guard is not paranoia: manager_id is a
 * self-referencing column an admin edits by hand, so A→B→A is one mis-click away, and
 * without this the walk never returns — the page hangs with no error, which is far harder
 * to diagnose than a wrong list.
 *
 * Extracted because two callers need it for opposite reasons: visibility asks "whose rows
 * may I see", and the manager picker asks "who must I NOT offer, because it would make a
 * loop". Two copies of a cycle-guarded walk is two places for the guard to be dropped from.
 */
function subtreeIds(rootId: string, all: readonly TeamMember[]): Set<string> {
  const seen = new Set<string>([rootId]);
  const queue = [rootId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const u of all) {
      if (u.managerId === current && !seen.has(u.id)) {
        seen.add(u.id);
        queue.push(u.id);
      }
    }
  }
  return seen;
}

export function visibleUserIds(me: TeamMember, all: readonly TeamMember[]): string[] | null {
  if (scopeOf(me, all) === "all") return null;
  return [...subtreeIds(me.id, all)];
}

/**
 * Who may be offered as `member`'s manager.
 *
 * Excludes the member themselves — the database has a CHECK for that
 * (users_manager_not_self), but a dropdown that offers an option the save will reject is a
 * worse experience than one that never offers it.
 *
 * Excludes everybody BELOW the member, which the database cannot check. "A reports to B"
 * where B already reports to A is a cycle, and a cycle in this column is the one input that
 * makes a naive recursive walk run for ever. Both the SQL function and `subtreeIds` above
 * survive it, so the symptom would not be a hang — it would be a reporting line that is
 * quietly nonsense, and nobody would notice until a manager wondered why they could see
 * their own boss's pipeline.
 */
export function eligibleManagers(
  member: TeamMember,
  all: readonly TeamMember[],
): TeamMember[] {
  const below = subtreeIds(member.id, all);
  return all.filter((u) => !below.has(u.id));
}

/**
 * May this person see one specific record?
 *
 * `ownerId` is whatever the table calls it — `leads.owner_id`, `quotes.owner_id`,
 * `customers.account_manager_id`. The column name differs per table; the rule does not.
 */
export function canSeeRecord(
  me: TeamMember,
  all: readonly TeamMember[],
  ownerId: string | null | undefined,
): boolean {
  /* Unowned is company data — see the header. This branch comes FIRST so it cannot be
     accidentally narrowed by a later condition. */
  if (!ownerId) return true;

  const ids = visibleUserIds(me, all);
  return ids === null || ids.includes(ownerId);
}

/** The rows this person may see, from any table with an owner-ish column. */
export function filterVisible<T>(
  me: TeamMember,
  all: readonly TeamMember[],
  rows: readonly T[],
  ownerOf: (row: T) => string | null | undefined,
): T[] {
  const ids = visibleUserIds(me, all);
  if (ids === null) return [...rows];
  return rows.filter((r) => {
    const o = ownerOf(r);
    return !o || ids.includes(o);
  });
}

/* ── What the toggle offers ─────────────────────────────────────────────────── */

export type TeamViewMode = "mine" | "team";

/**
 * Should the My/Team toggle be shown at all?
 *
 * Only when the two options would actually differ. A rep with no subordinates would get a
 * toggle whose halves show the same rows — a control that does nothing teaches people that
 * controls do nothing.
 */
export function showsTeamToggle(me: TeamMember, all: readonly TeamMember[]): boolean {
  return scopeOf(me, all) !== "own";
}

/** The ids for the chosen half of the toggle. */
export function idsForMode(
  me: TeamMember,
  all: readonly TeamMember[],
  mode: TeamViewMode,
): string[] | null {
  /* "Mine" means MINE, even for an owner. The point of the toggle is to narrow, and an
     owner who picks "My assigned" is asking what is on their own plate. */
  if (mode === "mine") return [me.id];
  return visibleUserIds(me, all);
}

/**
 * The label under the toggle, naming how many people are in scope.
 *
 * States the count because "Team view" on its own does not say whose team, and a manager
 * with two reports and a manager with forty need different things from the same screen.
 */
export function scopeNote(me: TeamMember, all: readonly TeamMember[], mode: TeamViewMode): string {
  if (mode === "mine") return "Only records assigned to you.";

  const ids = visibleUserIds(me, all);
  if (ids === null) return "Everything in this workspace — you are an owner.";

  const others = ids.length - 1;
  if (others <= 0) return "Only records assigned to you — nobody reports to you yet.";
  return `You and ${others} ${others === 1 ? "person who reports" : "people who report"} to you.`;
}
