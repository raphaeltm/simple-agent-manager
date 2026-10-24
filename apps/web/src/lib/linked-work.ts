/**
 * Plain words for linked work.
 *
 * SAM stores relations as verbs (`works_on`, `uploaded`, `read`, ...). Users see sentences, so
 * every relation gets one short phrase here and nowhere else — the Related panel, the header
 * chip and the library file strip all read the same map, so they cannot describe the same
 * relation differently (`.claude/rules/24-no-duplicate-ui-controls.md`).
 *
 * `LINK_RELATION_LABELS` is a `Record<LinkRelation, string>`, so adding a relation to the shared
 * union without giving it a phrase is a typecheck failure rather than a row that renders a raw
 * enum value at the user (`.claude/rules/79-new-enum-values-audit-every-denylist.md`).
 */
import type { CappedList, LinkedSession, LinkRelation } from '@simple-agent-manager/shared';

export const LINK_RELATION_LABELS: Record<LinkRelation, string> = {
  works_on: 'Working on',
  created: 'Created',
  edited: 'Edited',
  opened: 'Opened',
  uploaded: 'Uploaded',
  replaced: 'Replaced',
  linked: 'Linked',
  related: 'Related',
  discusses: 'Discussed',
  read: 'Read',
  viewed: 'Viewed',
};

/**
 * Display precedence: what the chat DID to the resource outranks what it merely saw, so a chat
 * that worked on an idea and also read it reads "Working on · Read", never the reverse.
 *
 * Derived from the label map's key order rather than restated, so the two cannot drift. The map
 * is written strong-first for exactly this reason.
 */
const RELATION_ORDER = Object.keys(LINK_RELATION_LABELS) as LinkRelation[];

const KNOWN_RELATIONS = new Set<string>(RELATION_ORDER);

/** Relations the UI has a phrase for. An unknown one from a newer API is dropped, not printed. */
export function isKnownLinkRelation(value: unknown): value is LinkRelation {
  return typeof value === 'string' && KNOWN_RELATIONS.has(value);
}

export function sortLinkRelations(relations: readonly LinkRelation[]): LinkRelation[] {
  return [...relations].sort((a, b) => RELATION_ORDER.indexOf(a) - RELATION_ORDER.indexOf(b));
}

/**
 * One meta line for a row: "Working on", "Uploaded · Viewed".
 *
 * Returns an empty string when there is nothing to say, so callers render no line at all
 * instead of a stray separator.
 */
export function describeRelations(relations: readonly LinkRelation[]): string {
  return sortLinkRelations(relations)
    .map((relation) => LINK_RELATION_LABELS[relation])
    .join(' · ');
}

/**
 * The count to show above a capped list.
 *
 * `totalIsLowerBound` means a bounded cross-store read could only establish a minimum, so the
 * honest rendering is "N+" (linked-work program decision 9). Showing a bare "N" there would
 * assert a count the server explicitly declined to claim.
 */
export function formatCappedTotal(
  list: Pick<CappedList<unknown>, 'total' | 'totalIsLowerBound'>
): string {
  return `${list.total}${list.totalIsLowerBound ? '+' : ''}`;
}

/** Relations that mean a chat produced the file, as opposed to merely reading it. */
const PROVENANCE_RELATIONS: readonly LinkRelation[] = ['uploaded', 'replaced'];

/**
 * Sessions on a library file, ordered so the chat that produced it comes first.
 *
 * Within each group the most recently active chat leads; a session with no recorded activity
 * sorts last rather than ahead of every dated one.
 */
export function orderFileSessions(sessions: readonly LinkedSession[]): LinkedSession[] {
  const producedRank = (session: LinkedSession) =>
    session.relations.some((relation) => PROVENANCE_RELATIONS.includes(relation)) ? 0 : 1;
  return [...sessions].sort(
    (a, b) =>
      producedRank(a) - producedRank(b) ||
      (b.lastActivityAt ?? Number.NEGATIVE_INFINITY) -
        (a.lastActivityAt ?? Number.NEGATIVE_INFINITY)
  );
}

/**
 * Where a library file came from, in one phrase.
 *
 * Only the link store can answer this: the browser upload route no longer accepts
 * client-supplied `uploadSessionId` / `uploadTaskId` (T1), so a chat named here genuinely
 * uploaded, replaced or read the file. `null` when no chat is linked at all.
 */
export function fileProvenance(
  sessions: readonly LinkedSession[]
): { session: LinkedSession; verb: string } | null {
  const [first] = orderFileSessions(sessions);
  if (!first) return null;
  const relation = sortLinkRelations(first.relations)[0];
  const verb =
    relation === 'uploaded'
      ? 'Uploaded by'
      : relation === 'replaced'
        ? 'Replaced by'
        : relation === 'viewed'
          ? 'Viewed by'
          : 'Linked to';
  return { session: first, verb };
}

/** A chat's display name. Topics are optional, and an untitled chat still needs a label. */
export function linkedSessionLabel(session: Pick<LinkedSession, 'topic'>): string {
  return session.topic?.trim() || 'Untitled chat';
}
