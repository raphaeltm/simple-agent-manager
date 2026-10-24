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
 * a per-relation map is complete. `satisfies` keeps it tied to the union: a member added to the
 * union without being added here is not a compile error, so the exhaustiveness proof is a
 * `Record<LinkRelation, …>` elsewhere plus a test that compares the two.
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
