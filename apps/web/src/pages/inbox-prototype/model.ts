/** PROTOTYPE ONLY — state, ordering, grouping and scenes for /prototype/inbox. */
import { ARCHIVED_ITEMS, BASE_ITEMS, type InboxItem, must, TEAM_ITEMS } from './mock-data';
import { BUSY_ITEMS, STRESS_ITEMS } from './stress-data';

export type Filter = 'all' | 'blocking' | 'tasks' | 'reviews' | 'updates' | 'archived';
export type Dataset = 'base' | 'stress' | 'empty' | 'team' | 'busy';
export type Direction = 'a' | 'b' | 'c';

export interface State {
  dataset: Dataset;
  filter: Filter;
  /** A/B: the focused item. C: the expanded row. */
  openId: string | null;
  contextOpen: boolean;
  /** B: the secondary list sheet. */
  listOpen: boolean;
  /** Answered items → one-line receipt. */
  resolved: Record<string, string>;
  /** The item whose receipt is showing now. */
  lastReceipt: string | null;
  archived: string[];
  /** A project name to scope the inbox to (the project inbox and the Overview); null = all. */
  scope: string | null;
  /** Items filed while the prototype runs (a failed start from the Overview's composer). */
  extra: InboxItem[];
}

export type Action =
  | { type: 'filter'; filter: Filter }
  | { type: 'open'; id: string | null }
  | { type: 'context'; open: boolean }
  | { type: 'list'; open: boolean }
  | { type: 'answered'; id: string; receipt: string; advance: boolean }
  | { type: 'archive'; id: string; advance: boolean }
  | { type: 'file'; item: InboxItem }
  | { type: 'scope'; scope: string | null };

export const SCENES: Record<string, Partial<State>> = {
  home: {},
  question: { openId: 'q-vat' },
  permission: { openId: 'perm-migrate' },
  secret: { openId: 'secret-stripe' },
  approval: { openId: 'approval-ws' },
  task: { openId: 'task-key' },
  review: { openId: 'review-pricing' },
  context: { openId: 'q-vat', contextOpen: true },
  group: { openId: 'secret-stripe', resolved: { 'q-vat': 'Sent “Include VAT” · the agent woke' } },
  receipt: {
    openId: 'q-vat',
    resolved: { 'q-vat': 'Sent “Include VAT” · the agent woke' },
    lastReceipt: 'q-vat',
  },
  updates: { filter: 'updates', listOpen: true },
  blocking: { filter: 'blocking', listOpen: true },
  tasks: { filter: 'tasks', listOpen: true },
  reviews: { filter: 'reviews', listOpen: true },
  archived: { filter: 'archived', listOpen: true },
  empty: { dataset: 'empty' },
  stress: { dataset: 'stress', listOpen: true },
  'stress-task': { dataset: 'stress', openId: 'stress-12-steps' },
  'stress-options': { dataset: 'stress', openId: 'stress-10-options' },
  team: { dataset: 'team', listOpen: true },
  'team-item': { dataset: 'team', openId: 'team-video' },
};

export function sceneState(scene: string | null): State {
  const base: State = {
    dataset: 'base',
    filter: 'all',
    openId: null,
    contextOpen: false,
    listOpen: false,
    resolved: {},
    lastReceipt: null,
    archived: [],
    scope: null,
    extra: [],
  };
  return { ...base, ...(scene ? SCENES[scene] : {}) };
}

function datasetItems(dataset: Dataset): InboxItem[] {
  if (dataset === 'stress') return STRESS_ITEMS;
  if (dataset === 'team') return [...TEAM_ITEMS, ...BASE_ITEMS];
  if (dataset === 'busy') return BUSY_ITEMS;
  if (dataset === 'empty') return [];
  return BASE_ITEMS;
}

/** Every item filed at runtime, so lookups by id find it (prototype-only registry). */
const FILED: InboxItem[] = [];

export function findItem(id: string | null): InboxItem | undefined {
  if (!id) return undefined;
  return [
    ...FILED,
    ...STRESS_ITEMS,
    ...BUSY_ITEMS,
    ...TEAM_ITEMS,
    ...BASE_ITEMS,
    ...ARCHIVED_ITEMS,
  ].find((i) => i.id === id);
}

/**
 * Order: live-runtime deadlines first (a permission dies in minutes), then blocking oldest
 * first, then everything else oldest first; items a teammate took go last. The idea said
 * "blocking first, then oldest", which would bury a 4-minute permission under a 40-minute
 * approval.
 */
function rank(a: InboxItem, b: InboxItem): number {
  // A start that failed sits with the live deadlines: the person fired and forgot, and
  // nothing else will tell them.
  const tier = (i: InboxItem) =>
    i.team?.claimedBy
      ? 3
      : i.deadlineMin !== undefined || i.kind === 'failed'
        ? 0
        : i.blocking
          ? 1
          : 2;
  if (tier(a) !== tier(b)) return tier(a) - tier(b);
  if (tier(a) === 0) return (a.deadlineMin ?? 0) - (b.deadlineMin ?? 0);
  return b.ageMin - a.ageMin;
}

/** Open asks (Needs you), before filtering. */
export function openItems(state: State): InboxItem[] {
  return scoped(state, [...state.extra, ...datasetItems(state.dataset)])
    .filter((i) => !state.archived.includes(i.id) && !state.resolved[i.id])
    .sort(rank);
}

function scoped(state: State, items: InboxItem[]): InboxItem[] {
  return state.scope ? items.filter((i) => i.project === state.scope) : items;
}

/** What the badge and "Needs you" count: open asks you can act on (not a teammate's). */
export function actionable(state: State): InboxItem[] {
  return openItems(state).filter((i) => !i.team?.claimedBy);
}

export function filtered(state: State): InboxItem[] {
  if (state.filter === 'archived') {
    return scoped(state, [
      ...datasetItems(state.dataset).filter((i) => state.archived.includes(i.id)),
      ...(state.dataset === 'empty' ? [] : ARCHIVED_ITEMS),
    ]);
  }
  const open = openItems(state);
  if (state.filter === 'blocking') return open.filter((i) => i.blocking);
  if (state.filter === 'tasks') return open.filter((i) => i.kind === 'task');
  if (state.filter === 'reviews') return open.filter((i) => i.kind === 'review');
  return open;
}

export type Row =
  { type: 'item'; item: InboxItem } | { type: 'group'; key: string; items: InboxItem[] };

/** Items from one chat (same groupKey) collapse into one stacked row at the first member. */
export function toRows(items: InboxItem[]): Row[] {
  const rows: Row[] = [];
  const groups = new Map<string, InboxItem[]>();
  for (const item of items) {
    if (!item.groupKey) {
      rows.push({ type: 'item', item });
      continue;
    }
    const existing = groups.get(item.groupKey);
    if (existing) existing.push(item);
    else {
      const members = [item];
      groups.set(item.groupKey, members);
      rows.push({ type: 'group', key: item.groupKey, items: members });
    }
  }
  return rows.map((r) =>
    r.type === 'group' && r.items.length === 1 ? { type: 'item', item: must(r.items[0]) } : r
  );
}

/** The walk order for next / previous: rows flattened, a group's members adjacent. */
export function queue(state: State): InboxItem[] {
  return toRows(
    filtered({ ...state, filter: state.filter === 'updates' ? 'all' : state.filter })
  ).flatMap((r) => (r.type === 'group' ? r.items : [r.item]));
}

/** Every member of an item's chat stack, answered ones included, for the stack stepper. */
export function groupMembers(state: State, item: InboxItem): InboxItem[] {
  if (!item.groupKey) return [];
  return datasetItems(state.dataset)
    .filter((i) => i.groupKey === item.groupKey && !state.archived.includes(i.id))
    .sort(rank);
}

export function counts(state: State) {
  const open = openItems(state);
  return {
    // A team item a teammate took is listed (last) but not counted: you cannot act on it.
    all: actionable(state).length,
    blocking: open.filter((i) => i.blocking).length,
    tasks: open.filter((i) => i.kind === 'task').length,
    reviews: open.filter((i) => i.kind === 'review').length,
  };
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'filter':
      return { ...state, filter: action.filter, openId: null, lastReceipt: null };
    case 'open':
      return { ...state, openId: action.id, contextOpen: false, lastReceipt: null };
    case 'context':
      return { ...state, contextOpen: action.open };
    case 'list':
      return { ...state, listOpen: action.open };
    case 'answered': {
      const next = nextAfter(state, action.id);
      return {
        ...state,
        resolved: { ...state.resolved, [action.id]: action.receipt },
        lastReceipt: action.id,
        openId: action.advance ? (next?.id ?? null) : action.id,
        contextOpen: false,
      };
    }
    case 'scope':
      return { ...state, scope: action.scope, filter: 'all', openId: null, lastReceipt: null };
    case 'file':
      FILED.push(action.item);
      return { ...state, extra: [action.item, ...state.extra] };
    case 'archive': {
      // Archive = closed: the item leaves Needs you and the agent is told you will not act
      // (confirmed by the owner, 2026-11-15, idea 01M7G03ZCQ6TM6CMEYDRKQ8ST9 section 10).
      const next = nextAfter(state, action.id);
      return {
        ...state,
        archived: [...state.archived, action.id],
        resolved: { ...state.resolved, [action.id]: ARCHIVE_RECEIPT },
        lastReceipt: action.id,
        openId: action.advance ? (next?.id ?? null) : null,
        contextOpen: false,
      };
    }
  }
}

export const ARCHIVE_RECEIPT = 'Archived · the agent was told you won’t act on it';

export function nextAfter(state: State, id: string): InboxItem | undefined {
  const q = queue(state);
  const index = q.findIndex((i) => i.id === id);
  return q[index + 1] ?? q.find((i) => i.id !== id);
}

export function formatAge(min: number): string {
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  if (min < 1440) return `${Math.round(min / 60)}h`;
  return `${Math.round(min / 1440)}d`;
}
