/**
 * Where an idea stands, and the evidence it was derived from.
 *
 * An idea is a `tasks` row that has not been handed to an agent yet. Its state is *derived*
 * from the work linked to it — the chats working on it, their tasks, their pull requests and
 * their unanswered questions — so nobody has to keep a status field honest by hand. Only
 * `done` and `parked` are human decisions (the `completed` and `cancelled` task statuses).
 *
 * Nothing here is user-facing copy. The API returns the state and the evidence; the words and
 * the buttons belong to the UI, so the contract does not have to change to reword a sentence.
 */

/** Where an idea stands. Derived, except `done` and `parked`. */
export type IdeaDerivedState =
  'not-started' | 'working' | 'review' | 'merged' | 'stuck' | 'question' | 'done' | 'parked';

export const IDEA_DERIVED_STATES = [
  'not-started',
  'working',
  'review',
  'merged',
  'stuck',
  'question',
  'done',
  'parked',
] as const satisfies readonly IdeaDerivedState[];

/**
 * The states that need a person: an agent asked something, work stopped, or a pull request
 * merged and only a human can say whether that finished the idea.
 */
export const IDEA_NEEDS_YOU_STATES = ['question', 'stuck', 'merged'] as const;
export type IdeaNeedsYouState = (typeof IDEA_NEEDS_YOU_STATES)[number];

export function ideaNeedsYou(state: IdeaDerivedState): state is IdeaNeedsYouState {
  return (IDEA_NEEDS_YOU_STATES as readonly IdeaDerivedState[]).includes(state);
}

/**
 * What decided the state, so the UI can say "From GitHub, a minute ago" rather than asking
 * anyone to trust a label.
 *
 * `none` means nothing is linked yet, which is the only way to reach `not-started`.
 */
export type IdeaStatusOrigin = 'chat' | 'github' | 'agent' | 'person' | 'none';

export interface IdeaStatusSource {
  origin: IdeaStatusOrigin;
  /** When the deciding evidence was last observed. ISO 8601, or null when there is none. */
  observedAt: string | null;
  /** True when the evidence is stored state that has not been refreshed recently. */
  stale: boolean;
}

/** The chat that decided the state, when a chat decided it. */
export interface IdeaStatusSession {
  sessionId: string;
  topic: string | null;
  /** The chat session's own status (`active`, `sleeping`, `stopped`, …). */
  sessionStatus: string;
  /** The task driving the chat, when it has one. */
  taskId: string | null;
  /** The task's status, when there is a task. */
  taskStatus: string | null;
  /** Who is working: an agent profile name when known. */
  agentLabel: string | null;
  lastActivityAt: string | null;
}

/** A pull request for an idea, with the stored state T2 keeps for it. */
export interface IdeaPullRequestSummary {
  url: string;
  number: number;
  state: 'open' | 'closed' | 'merged';
  isDraft: boolean;
  title: string | null;
  checksState: 'pending' | 'success' | 'failure' | 'neutral' | null;
  mergedAt: string | null;
  updatedAt: string | null;
  /** True when the stored state has not been refreshed from GitHub recently. */
  stale: boolean;
}

export interface IdeaDerivedStatus {
  state: IdeaDerivedState;
  /** Set exactly when `ideaNeedsYou(state)`. */
  needsYou: IdeaNeedsYouState | null;
  source: IdeaStatusSource;
  /** The chat behind `working`, `question` and `stuck`. */
  session: IdeaStatusSession | null;
  /** The pull request behind `review` and `merged`. */
  pullRequest: IdeaPullRequestSummary | null;
  /**
   * The agent's question (`question`) or the failure it reported (`stuck`), truncated by the
   * server. Null for every other state.
   */
  note: string | null;
}

/** What an idea has collected. Counts, not lists: the list page shows "4 updates, 2 chats". */
export interface IdeaCounts {
  updates: number;
  chats: number;
  files: number;
  pullRequests: number;
}

export interface IdeaListItem {
  ideaId: string;
  title: string;
  /** The opening of the plan, trimmed by the server. Null when the idea has no text. */
  summary: string | null;
  createdAt: string;
  updatedAt: string;
  derived: IdeaDerivedStatus;
  counts: IdeaCounts;
  /** True for ideas an automation or an incident filed, which the list folds away. */
  filedByAgent: boolean;
  /** What filed it, when `filedByAgent`: a connector client name or a trigger kind. */
  filedBy: string | null;
  /**
   * The connected client a person filed this through, when they used one. Not the same as
   * `filedByAgent`: a person asking Claude to file an idea is still a person's idea, and the
   * list says where it came from rather than folding it away.
   */
  viaConnector: string | null;
}

export interface IdeaListResponse {
  items: IdeaListItem[];
  /** True when more ideas exist than were loaded. */
  truncated: boolean;
}

/**
 * How long an idea's title may be.
 *
 * The server truncates at `getPlatformOperationLimits().ideaTitleMaxLength`, which defaults to
 * this; the web forms stop you at the same number. One constant so a self-hoster who raises
 * `MCP_IDEA_TITLE_MAX_LENGTH` does not get a form that still refuses the longer title.
 */
export const DEFAULT_IDEA_TITLE_MAX_LENGTH = 200;

/** The statuses a person may move an idea to, and what each one means. */
export const IDEA_HUMAN_TRANSITIONS = ['completed', 'cancelled', 'draft'] as const;
export type IdeaHumanTransition = (typeof IDEA_HUMAN_TRANSITIONS)[number];

export function isIdeaHumanTransition(value: unknown): value is IdeaHumanTransition {
  return typeof value === 'string' && (IDEA_HUMAN_TRANSITIONS as readonly string[]).includes(value);
}
