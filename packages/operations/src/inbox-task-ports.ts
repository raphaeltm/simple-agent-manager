/**
 * What human-task operations (inbox slice H1) need from the worker: the `sam.inbox` event
 * outbox, item subscriptions, the comment core in the project's Durable Object, the agent-wake
 * policy, and notifications. Implemented in `apps/api/src/services/inbox/task-port.ts`.
 */
import type {
  CommentMention,
  InboxItemCommentThread,
  InboxTaskEventType,
} from '@simple-agent-manager/shared';

export interface InboxTaskEventActor {
  kind: 'user' | 'agent' | 'system';
  /** User id, or the agent's chat session id. */
  id: string | null;
  name: string | null;
}

export interface InboxTaskEventInput {
  projectId: string;
  askId: string;
  eventType: InboxTaskEventType;
  actor: InboxTaskEventActor;
  /** The actor is not the owner of the filing chat: the agent must treat it as teammate input. */
  teammateInput: boolean;
  /** Small ids-only detail (step index, assignee kind, thread id). Never comment text. */
  detail?: Record<string, string | number | boolean | null>;
  /** Whether the task is still open after this change (renews or winds down its watches). */
  taskOpen: boolean;
  /** Hours a closed task keeps its watches (`inbox.closedTaskWatchHours`). */
  closedWatchHours: number;
  /** The request's `waitUntil`: admission runs after the response; the outbox sweep retries. */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** Commit the intent only and leave admission to the outbox reconcile sweep (bulk callers). */
  deferAdmission?: boolean;
}

export interface InboxTaskWatchInput {
  projectId: string;
  askId: string;
  /** The chat to wake, its task, and the person it works for. */
  sessionId: string;
  taskId: string;
  userId: string;
  agentSessionId: string | null;
  /** Also wake on step ticks (otherwise ticks are recorded only). */
  includeSteps: boolean;
  /**
   * Wake on comments. True only for the chat that assigned the task: the comment wake rule is
   * decided against that chat, so an attached chat hears about lifecycle changes, not comments.
   */
  includeComments: boolean;
}

export interface InboxTaskCommentWakeInput {
  projectId: string;
  /** The filing chat; null when the item came from no chat. */
  sessionId: string | null;
  actorUserId: string;
  assigneeUserId: string | null;
  claimedByUserId: string | null;
}

export interface InboxTaskCommentWakeDecision {
  wake: boolean;
  /** Set when `wake`: the author is not the chat owner. */
  teammateInput: boolean;
  reason: string;
}

export interface InboxTaskCommentNotice {
  projectId: string;
  askId: string;
  title: string;
  commentId: string;
  threadId: string;
  body: string;
  mentions: CommentMention[];
  actor: { userId: string; name: string | null };
  /** People who should hear about it besides mentions (assignee, claimer, earlier repliers). */
  participants: string[];
  /** People allowed to read the task; nobody else is notified, even when mentioned. */
  readers: 'project' | string[];
}

export interface OperationInboxTaskPort {
  /** Admit one `sam.inbox` event through the durable outbox. Never throws; false if not queued. */
  admitEvent(input: InboxTaskEventInput): Promise<boolean>;
  /**
   * Subscribe a chat to the item (prompt delivery to that chat, no expiry). Idempotent per chat
   * and item. Throws when the chat is not this task's active chat.
   */
  watch(input: InboxTaskWatchInput): Promise<{ subscriptionId: string; created: boolean }>;
  /** An agent closed the task (cancel): its watches wind down like a closed task's. */
  closeWatches(projectId: string, askId: string, closedWatchHours: number): Promise<void>;
  /** Active subscriptions on the item (the watcher cap). */
  countWatchers(projectId: string, askId: string): Promise<number>;
  /** Whether a person's comment may wake the filing chat (`decideAgentWake`). Never throws. */
  decideCommentWake(input: InboxTaskCommentWakeInput): Promise<InboxTaskCommentWakeDecision>;
  listComments(
    projectId: string,
    askId: string
  ): Promise<{ threads: InboxItemCommentThread[]; hasMore: boolean }>;
  createComment(
    projectId: string,
    input: {
      askId: string;
      threadId?: string;
      body: string;
      clientMutationId?: string;
      actor: { kind: 'human' | 'agent'; id: string; name: string | null };
      mentions?: CommentMention[];
    }
  ): Promise<{ thread: InboxItemCommentThread; commentId: string; idempotent: boolean }>;
  /** Mentioned user ids that are active project members, with display names. */
  resolveMentions(projectId: string, userIds: readonly string[]): Promise<CommentMention[]>;
  /** Mention and participant notifications for a comment. Never throws. */
  notifyComment(input: InboxTaskCommentNotice): Promise<void>;
  /** Low-urgency in-app notification of a new task. Never throws. */
  notifyAssigned(input: {
    projectId: string;
    askId: string;
    title: string;
    userIds: string[];
  }): Promise<void>;
}
