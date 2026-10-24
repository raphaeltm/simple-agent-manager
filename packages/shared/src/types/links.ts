/** Project-scoped relationships between work resources. */
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

export interface PullRequestRef {
  url: string;
  number: number;
  source: 'task_output' | 'pr_association' | 'explicit_link';
}
export interface PullRequestState {
  state: 'open' | 'closed' | 'merged';
  isDraft: boolean;
  title: string | null;
  checksState: 'pending' | 'success' | 'failure' | 'neutral' | null;
  mergedAt: string | null;
  updatedAt: string | null;
  stale: boolean;
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
