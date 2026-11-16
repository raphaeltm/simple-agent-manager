/**
 * Inbox: one item per ask from an agent (or SAM) to a person, read across projects
 * (idea 01M7G03ZCQ6TM6CMEYDRKQ8ST9). Every item names the store that holds its record; the
 * inbox keeps no copy (`packages/operations/src/inbox-list-core.ts`).
 *
 * Stores:
 * - `ask`: D1 `asks` (reviews, human tasks, errors; questions from slice G)
 * - `attention`: a question or permission held as a ProjectData attention marker, read from the
 *   `session_summaries.attention_json` index until slices G and J move them into `asks`
 * - `secret`: D1 `runtime_secret_requests`
 * - `approval`: D1 `operations_action_approvals`
 */

export const INBOX_STORES = ['ask', 'attention', 'secret', 'approval'] as const;
export type InboxStore = (typeof INBOX_STORES)[number];

export const INBOX_ITEM_KINDS = [
  'question',
  'permission',
  'form',
  'url',
  'secret',
  'approval',
  'review',
  'task',
  'error',
] as const;
export type InboxItemKind = (typeof INBOX_ITEM_KINDS)[number];

/** Kinds an `asks` row may hold. */
export const ASK_KINDS = ['question', 'review', 'task', 'error'] as const;
export type AskKind = (typeof ASK_KINDS)[number];

export const ASK_STATUSES = [
  'open',
  'answered',
  'done',
  'archived',
  'cancelled',
  'expired',
] as const;
export type AskStatus = (typeof ASK_STATUSES)[number];

export const ASK_ASSIGNEE_KINDS = ['user', 'team'] as const;
export type AskAssigneeKind = (typeof ASK_ASSIGNEE_KINDS)[number];

/**
 * List filters. `needs_you` (default): open items this viewer can act on. `blocking`: the open
 * items an agent is stopped on. `tasks` / `reviews`: open `asks` of that kind. `archived`:
 * archived `asks` rows (questions, permissions, secrets and approvals close in their own store
 * and are not listed once closed).
 */
export const INBOX_FILTERS = ['needs_you', 'blocking', 'tasks', 'reviews', 'archived'] as const;
export type InboxFilter = (typeof INBOX_FILTERS)[number];

/**
 * What the agent that filed the item is doing, from its task:
 * `waiting` (paused on this item), `working`, `finished`, `not_started`, or `unknown` when the
 * item has no task.
 */
export const INBOX_AGENT_STATES = [
  'waiting',
  'working',
  'finished',
  'not_started',
  'unknown',
] as const;
export type InboxAgentState = (typeof INBOX_AGENT_STATES)[number];

/** A reference the reader resolves with their own access. Never carries secret material. */
export interface InboxLink {
  kind: string;
  id: string;
  label: string | null;
}

/**
 * Fixes an `error` item can offer (inbox slice E). `retry`, `wake` and `resume` run the existing
 * retry / wake / resume operation with the answering person's authority; `open_chat` is handled
 * by the client (navigate to the item's chat) and the answer route refuses it.
 */
export const INBOX_ERROR_ACTIONS = ['retry', 'wake', 'resume', 'open_chat'] as const;
export type InboxErrorAction = (typeof INBOX_ERROR_ACTIONS)[number];

export interface InboxErrorActionOption {
  id: InboxErrorAction;
  label: string;
}

/** How the item is answered. The shape of the `answer` request follows from `type`. */
export type InboxAnswerSpec =
  /** Pick one of `options` (`answer`), or type text when `allowText`. */
  | { type: 'options'; options: string[]; allowText: boolean }
  /** Free text (`answer`). */
  | { type: 'text' }
  /** A live runtime interaction: `optionId`, `decline: true` or `formContent`. */
  | {
      type: 'interaction';
      interactionId: string | null;
      interactionKind: 'permission' | 'form' | 'url';
    }
  /** A secure value (`secret`, browser only) or `decline: true`. */
  | { type: 'secret'; envKey: string; requestId: string }
  /** `decision: 'approve' | 'deny'` with an optional `note`. */
  | { type: 'approval'; action: string; targetType: string; targetId: string }
  /** "Looks good" / "Mark done": no fields, or an optional `answer` comment. */
  | { type: 'acknowledge' }
  /** A system error: run one of `actions` (`action`), first is primary. Archive dismisses it. */
  | { type: 'actions'; actions: InboxErrorActionOption[] };

export interface InboxItem {
  /** Stable reference: `ask:<id>`, `attention:<sessionId>:<markerId>`, `secret:<id>`, `approval:<id>`. */
  ref: string;
  store: InboxStore;
  kind: InboxItemKind;
  projectId: string;
  projectName: string | null;
  sessionId: string | null;
  topic: string | null;
  taskId: string | null;
  /** Items with the same key come from one chat (or one group) and render as a stack. */
  stackKey: string;
  /** One sentence. Agent-written: untrusted. */
  title: string;
  /** The agent's reason or body. Agent-written: untrusted. */
  body: string | null;
  blocking: boolean;
  agentState: InboxAgentState;
  /** Open items are `open`; `asks` rows carry their own status. */
  status: AskStatus;
  createdAt: string;
  /** Last change; for an `error` item, when it last failed. */
  updatedAt: string;
  /** `error` items: how many times the thing failed while the item was open. Null otherwise. */
  failureCount: number | null;
  expiresAt: string | null;
  dueAt: string | null;
  answerSpec: InboxAnswerSpec;
  links: InboxLink[];
  /** Whether this viewer may answer or archive it. */
  canAct: boolean;
  untrustedContent: true;
}

export interface InboxListResponse {
  items: InboxItem[];
  nextCursor: string | null;
  /** Rows on this page that could not be read and were left out (logged server side). */
  skipped: number;
}

export interface InboxCountResponse {
  /** Open items this viewer can act on (the badge). */
  needsYou: number;
  /** Of those, the ones an agent is stopped on. */
  blocking: number;
}

export interface InboxContextMessage {
  id: string;
  role: string;
  content: string;
  createdAt: number;
  truncated: boolean;
}

/** Transcript around the ask. Present only for a reader with access to the source chat. */
export interface InboxItemContext {
  /** Messages before the ask, oldest first. */
  before: InboxContextMessage[];
  /** What the agent did since asking: messages after the ask, oldest first. */
  since: {
    messages: InboxContextMessage[];
    /** Tool runs and other activity after the ask. */
    activityCount: number;
    /** More happened after the ask than this read covers. */
    truncated: boolean;
  };
}

export interface InboxItemResponse {
  item: InboxItem;
  /** Null when not requested or the reader has no access to the source chat. */
  context: InboxItemContext | null;
}

/** POST .../inbox/items/:ref/answer. Fields by `answerSpec.type`. */
export interface InboxAnswerRequest {
  answer?: string;
  optionId?: string;
  decline?: true;
  formContent?: Record<string, unknown>;
  decision?: 'approve' | 'deny';
  note?: string;
  /** `actions` items: the fix to run (`retry`, `wake`, `resume`). */
  action?: InboxErrorAction;
  /** Secret value: accepted from the app's own pages only, never logged or returned. */
  secret?: { value: string; replaceExisting?: boolean; expectedExistingVersion?: string };
}

export interface InboxActionResponse {
  ref: string;
  /** What happened, in the store's own words (`answered`, `archived`, `declined`, `denied`, ...). */
  outcome: string;
  /** False when the agent's notice was not queued yet (a sweep retries it). */
  agentNotified: boolean;
}

const REF_ID = '[A-Za-z0-9_-]{1,128}';
const REF_PATTERNS: Record<InboxStore, RegExp> = {
  ask: new RegExp(`^ask:(${REF_ID})$`),
  attention: new RegExp(`^attention:(${REF_ID}):(${REF_ID})$`),
  secret: new RegExp(`^secret:(${REF_ID})$`),
  approval: new RegExp(`^approval:(${REF_ID})$`),
};

export type ParsedInboxRef =
  | { store: 'ask' | 'secret' | 'approval'; id: string }
  | { store: 'attention'; sessionId: string; markerId: string };

/** Parse a ref, or null when it is not one this build issues. */
export function parseInboxRef(ref: string): ParsedInboxRef | null {
  for (const store of INBOX_STORES) {
    const [, first, second] = REF_PATTERNS[store].exec(ref) ?? [];
    if (first === undefined) continue;
    if (store === 'attention') {
      return second === undefined ? null : { store, sessionId: first, markerId: second };
    }
    return { store, id: first };
  }
  return null;
}

export function formatInboxRef(ref: ParsedInboxRef): string {
  return ref.store === 'attention'
    ? `attention:${ref.sessionId}:${ref.markerId}`
    : `${ref.store}:${ref.id}`;
}
