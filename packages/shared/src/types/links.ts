/** Project-scoped relationships between work resources. */
import type { PullRequestRef, PullRequestState } from './pull-requests';

export type { PullRequestRef, PullRequestState } from './pull-requests';

export type LinkKind = 'session' | 'idea' | 'file' | 'pr';
export type LinkRelation =
  | 'created'
  | 'edited'
  | 'read'
  | 'works_on'
  | 'discusses'
  | 'linked'
  | 'uploaded'
  | 'replaced'
  | 'viewed'
  | 'opened'
  | 'related';
export type LinkOrigin = 'auto' | 'explicit';

/**
 * Every relation, in one place.
 *
 * `LinkRelation` is the type; this is its runtime enumeration, for the boundaries that have to
 * reject an unrecognised string (the web client's payload normaliser) and for tests that assert
 * a per-relation map is complete.
 *
 * `satisfies` catches a member here that is NOT in the union, but not a union member missing
 * from here. Two things close that gap, both verified by mutation rather than assumed:
 *
 * 1. `LINK_RELATION_LABELS` (`apps/web/src/components/linked-work/relation-labels.ts`) is a
 *    `Record<LinkRelation, string>` in a SOURCE file, so `pnpm typecheck` reads it: a member
 *    added to this union with no phrase fails with TS2741.
 * 2. `relation-labels.test.ts` compares that map's keys against this array at runtime, which is
 *    what catches a phrase added with no entry here.
 *
 * Point 1 has to live in `src/`: the shared, api and web tsconfigs all `exclude` their `tests`
 * directory, so a type-level proof written inside a test file is never checked by `tsc`.
 */
export const LINK_RELATIONS = [
  'created',
  'edited',
  'read',
  'works_on',
  'discusses',
  'linked',
  'uploaded',
  'replaced',
  'viewed',
  'opened',
  'related',
] as const satisfies readonly LinkRelation[];

export const STRONG_LINK_RELATIONS = [
  'works_on',
  'created',
  'edited',
  'linked',
  'uploaded',
  'replaced',
  'opened',
] as const satisfies readonly LinkRelation[];
export const WEAK_LINK_RELATIONS = [
  'read',
  'viewed',
  'discusses',
] as const satisfies readonly LinkRelation[];
export const isLinkRelation = (value: unknown): value is LinkRelation =>
  typeof value === 'string' && (LINK_RELATIONS as readonly string[]).includes(value);
export const isStrongLinkRelation = (relation: LinkRelation): boolean =>
  (STRONG_LINK_RELATIONS as readonly LinkRelation[]).includes(relation);
export const isWeakLinkRelation = (relation: LinkRelation): boolean =>
  (WEAK_LINK_RELATIONS as readonly LinkRelation[]).includes(relation);

export interface CappedList<T> {
  items: T[];
  total: number;
  truncated: boolean;
  /** True when a bounded cross-store read can only establish a minimum count. */
  totalIsLowerBound: boolean;
}

export interface LinkedSession {
  sessionId: string;
  topic: string | null;
  status: string;
  relations: LinkRelation[];
  lastActivityAt: number | null;
  taskId: string | null;
}
export interface LinkedIdea {
  ideaId: string;
  title: string;
  status: string;
  relations: LinkRelation[];
}
export interface LinkedFile {
  fileId: string;
  filename: string;
  directory: string;
  relations: LinkRelation[];
  bySessionId: string | null;
}
export interface LinkedPullRequest extends PullRequestRef {
  state: PullRequestState | null;
  bySessionId: string | null;
}
export interface IdeaContext {
  sessions: CappedList<LinkedSession>;
  files: CappedList<LinkedFile>;
  pullRequests: CappedList<LinkedPullRequest>;
  relatedIdeas: CappedList<LinkedIdea>;
}
export interface SessionContext {
  ideas: CappedList<LinkedIdea>;
  files: CappedList<LinkedFile>;
  pullRequests: CappedList<LinkedPullRequest>;
}
export interface FileContext {
  sessions: CappedList<LinkedSession>;
  ideas: CappedList<LinkedIdea>;
}
