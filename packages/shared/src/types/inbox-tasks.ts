/**
 * Human tasks (inbox slice H1, ideas 01M7G03ZCQ6TM6CMEYDRKQ8ST9 and 01M6MFVAJF20DZK8NJ97VAXC7A).
 *
 * A human task is one `asks` row of kind `task`: an agent hands a person non-blocking work and
 * keeps going. Its steps and claim live on that row, its lifecycle in D1 `ask_activity`, and its
 * discussion in the anchored comment core under anchor kind `inbox_item`. Each change a person
 * makes admits a `sam.inbox` project event, which wakes the chats subscribed to the item.
 */
import type { CommentAuthor, CommentReply, CommentStatus } from './comments';

/** Project event source for inbox item changes. Reserved: only the API admits it. */
export const INBOX_EVENT_SOURCE = 'sam.inbox';
/** Project event subject type; the subject id is the `asks` id. */
export const INBOX_EVENT_SUBJECT_TYPE = 'inbox_item';

export const INBOX_TASK_EVENT_TYPES = [
  'inbox.task.commented',
  'inbox.task.step_checked',
  'inbox.task.step_unchecked',
  'inbox.task.claimed',
  'inbox.task.reassigned',
  'inbox.task.done',
  'inbox.task.reopened',
  'inbox.task.archived',
] as const;
export type InboxTaskEventType = (typeof INBOX_TASK_EVENT_TYPES)[number];

/** What a subscribed chat is woken by unless it asks for step ticks too. */
export const INBOX_TASK_DEFAULT_WAKE_EVENT_TYPES: readonly InboxTaskEventType[] = [
  'inbox.task.commented',
  'inbox.task.claimed',
  'inbox.task.reassigned',
  'inbox.task.done',
  'inbox.task.reopened',
  'inbox.task.archived',
];
export const INBOX_TASK_STEP_EVENT_TYPES: readonly InboxTaskEventType[] = [
  'inbox.task.step_checked',
  'inbox.task.step_unchecked',
];

/** Lifecycle rows of `ask_activity`. Discussion text is never stored here. */
export const ASK_ACTIVITY_KINDS = [
  'created',
  'commented',
  'step_checked',
  'step_unchecked',
  'claimed',
  'reassigned',
  'done',
  'reopened',
  'archived',
  'cancelled',
] as const;
export type AskActivityKind = (typeof ASK_ACTIVITY_KINDS)[number];

export const ASK_ACTOR_KINDS = ['user', 'agent', 'system'] as const;
export type AskActorKind = (typeof ASK_ACTOR_KINDS)[number];

export interface InboxTaskStep {
  index: number;
  text: string;
  done: boolean;
}

export interface InboxTaskActivity {
  id: string;
  kind: AskActivityKind;
  actorKind: AskActorKind;
  /** User id for a person, chat session id for an agent, null for SAM. */
  actorId: string | null;
  actorName: string | null;
  /** Small structured detail: step index, previous and new assignee, comment thread id. */
  detail: Record<string, string | number | boolean | null> | null;
  createdAt: string;
}

export interface InboxTaskAssignee {
  kind: 'user' | 'team';
  userId: string | null;
  name: string | null;
}

/** One discussion thread on an inbox item (anchored comment core, anchor kind `inbox_item`). */
export interface InboxItemCommentThread {
  id: string;
  itemId: string;
  author: CommentAuthor;
  body: string;
  status: CommentStatus;
  createdAt: number;
  updatedAt: number;
  replies: CommentReply[];
}

/** What a task view needs beyond the inbox item itself. */
export interface InboxTaskDetail {
  steps: InboxTaskStep[];
  assignee: InboxTaskAssignee;
  /** The member who took a team task, or null. */
  claimedBy: { userId: string; name: string | null } | null;
  dueHint: string | null;
  /** Lifecycle, oldest first (at most `inbox.taskActivityMax` rows; `activityHasMore` says so). */
  activity: InboxTaskActivity[];
  activityHasMore: boolean;
  discussion: InboxItemCommentThread[];
  discussionHasMore: boolean;
  /** Why the agent cancelled it, when it did. */
  cancelReason: string | null;
  /** True when the viewer may tick, take, finish, reopen, reassign or archive. */
  canWrite: boolean;
  /** True when the viewer may take it (a team task nobody has taken). */
  canClaim: boolean;
}

/** `POST …/inbox/items/:ref/steps/:index` */
export interface InboxTaskStepRequest {
  done: boolean;
}
/** `POST …/inbox/items/:ref/comments` */
export interface InboxTaskCommentRequest {
  body: string;
  /** Reply in this thread instead of starting a new one. */
  threadId?: string;
}
/** `POST …/inbox/items/:ref/reassign`: one active member, or the team. */
export type InboxTaskReassignRequest = { assigneeUserId: string } | { team: true };
/** `POST …/inbox/items/:ref/done` */
export interface InboxTaskDoneRequest {
  note?: string;
}

export interface InboxTaskActionResponse {
  ref: string;
  status: string;
  /** Whether the change was sent to the chats watching the task (false: recorded only). */
  agentNotified: boolean;
}

export interface InboxTaskCommentResponse extends InboxTaskActionResponse {
  threadId: string;
  commentId: string;
}
