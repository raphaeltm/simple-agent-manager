/**
 * Notifications for multiplayer sessions (idea 01M59MYE4GY91BWTE8TZF1ZB5D):
 * - `mention`        — someone @mentioned you in a comment (always sent, never batched)
 * - `comment`        — someone commented on your session, or replied in a thread you are in
 *                      (at most one per recipient per session per configurable window)
 * - `session_access` — a session was shared with you, your access was removed, or someone
 *                      you shared with re-shared your session
 *
 * Best-effort by design: callers run these in `waitUntil` and a failure is logged, never
 * surfaced, because the comment or grant has already been committed. The actor is never
 * notified about their own action. Bodies are short, redacted previews.
 */
import type {
  CommentMention,
  MessageCommentThread,
  NotificationType,
} from '@simple-agent-manager/shared';
import { NOTIFICATION_TYPE_URGENCY } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { getCommentNotificationWindowMs } from './collaboration-settings';
import { getMessageCommentConfig, normalizeCommentBody } from './message-comments';
import {
  buildActionUrl,
  getProjectName,
  sendNotification,
  sendNotificationOnce,
} from './notification';

const COMMENT_PREVIEW_MAX_LENGTH = 140;
const TOPIC_MAX_LENGTH = 60;

function sessionLabel(topic: string | null | undefined): string {
  const trimmed = topic?.trim();
  if (!trimmed) return 'a session';
  const short =
    trimmed.length > TOPIC_MAX_LENGTH ? `${trimmed.slice(0, TOPIC_MAX_LENGTH - 1)}…` : trimmed;
  return `“${short}”`;
}

function preview(env: Env, body: string): string {
  const normalized = normalizeCommentBody(body, getMessageCommentConfig(env)).replace(/\s+/g, ' ');
  return normalized.length > COMMENT_PREVIEW_MAX_LENGTH
    ? `${normalized.slice(0, COMMENT_PREVIEW_MAX_LENGTH - 1)}…`
    : normalized;
}

/**
 * Deep link that opens one comment thread in the Comments page reader: the conversation
 * around the commented message, opened on the quoted words, with the thread beside it.
 * The reader links on to the chat itself. Relative, like `buildActionUrl`.
 */
export function buildCommentActionUrl(
  projectId: string,
  sessionId: string,
  thread: Pick<MessageCommentThread, 'id'>
): string {
  return `/projects/${encodeURIComponent(projectId)}/comments/${encodeURIComponent(
    sessionId
  )}/${encodeURIComponent(thread.id)}`;
}

export interface CommentActivityInput {
  projectId: string;
  sessionId: string;
  sessionTopic: string | null;
  /** The session owner; notified when someone else comments on their session. */
  sessionOwnerUserId: string | null;
  thread: MessageCommentThread;
  /** The comment just written: the thread root, or one reply. */
  comment: { id: string; body: string; mentions: CommentMention[] };
  kind: 'thread' | 'reply';
  actor: { userId: string; name: string | null };
}

type Reason = 'mention' | 'your_session' | 'participant';

/** Exported for tests: who is notified, and why. One reason per person, strongest first. */
export function planCommentRecipients(input: CommentActivityInput): Map<string, Reason> {
  const recipients = new Map<string, Reason>();
  const add = (userId: string | null | undefined, reason: Reason) => {
    if (!userId || userId === input.actor.userId || recipients.has(userId)) return;
    recipients.set(userId, reason);
  };
  for (const mention of input.comment.mentions) add(mention.userId, 'mention');
  add(input.sessionOwnerUserId, 'your_session');
  if (input.kind === 'reply') {
    // People already in the conversation: the thread author and earlier human repliers.
    if (input.thread.author.kind === 'human') add(input.thread.author.id, 'participant');
    for (const reply of input.thread.replies) {
      if (reply.author.kind === 'human' && reply.id !== input.comment.id) {
        add(reply.author.id, 'participant');
      }
    }
  }
  return recipients;
}

function commentTitle(reason: Reason, actorName: string, topic: string): string {
  if (reason === 'mention') return `${actorName} mentioned you on ${topic}`;
  if (reason === 'your_session') return `${actorName} commented on your session ${topic}`;
  return `${actorName} replied on ${topic}`;
}

export async function notifyCommentActivity(env: Env, input: CommentActivityInput): Promise<void> {
  const recipients = planCommentRecipients(input);
  if (recipients.size === 0) return;
  const [projectName, windowMs] = await Promise.all([
    getProjectName(env, input.projectId),
    getCommentNotificationWindowMs(env),
  ]);
  const actorName = input.actor.name?.trim() || 'A teammate';
  const topic = sessionLabel(input.sessionTopic);
  const body = preview(env, input.comment.body);
  const actionUrl = buildCommentActionUrl(input.projectId, input.sessionId, input.thread);
  const now = Date.now();

  await Promise.all(
    [...recipients].map(async ([userId, reason]) => {
      const type: NotificationType = reason === 'mention' ? 'mention' : 'comment';
      const notification = {
        projectId: input.projectId,
        sessionId: input.sessionId,
        type,
        urgency: NOTIFICATION_TYPE_URGENCY[type],
        title: commentTitle(reason, actorName, topic),
        body,
        actionUrl,
        metadata: {
          projectName,
          reason,
          threadId: input.thread.id,
          commentId: input.comment.id,
          messageId: input.thread.anchor.messageId,
          actorUserId: input.actor.userId,
        },
      };
      try {
        if (reason === 'mention') {
          // A mention is never batched, but a retried write must not notify twice.
          await sendNotificationOnce(
            env,
            userId,
            `mention:${input.comment.id}`,
            now + windowMs,
            notification,
            now
          );
          return;
        }
        // Ordinary activity: at most one notification per session per window.
        await sendNotificationOnce(
          env,
          userId,
          `comment-activity:${input.sessionId}`,
          now + windowMs,
          notification,
          now
        );
      } catch (err) {
        log.warn('collaboration.comment_notification_failed', {
          projectId: input.projectId,
          sessionId: input.sessionId,
          threadId: input.thread.id,
          recipientUserId: userId,
          reason,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })
  );
}

export interface SessionAccessNotificationInput {
  projectId: string;
  sessionId: string;
  sessionTopic: string | null;
  sessionOwnerUserId: string | null;
  actor: { userId: string; name: string | null };
  change: 'granted' | 'renewed' | 'revoked';
  /** People whose access changed (the target plus any cascaded grants on revoke). */
  affectedUserIds: string[];
  /** Display name of the primary grantee, for the owner's re-share notice. */
  granteeName: string | null;
  /** When granted or renewed access ends (epoch ms). */
  expiresAt?: number | null;
}

function accessWindow(expiresAt: number | null | undefined): string {
  if (!expiresAt) return '';
  const minutes = Math.max(1, Math.round((expiresAt - Date.now()) / 60_000));
  return ` for the next ${minutes} minute${minutes === 1 ? '' : 's'}`;
}

export async function notifySessionAccessChange(
  env: Env,
  input: SessionAccessNotificationInput
): Promise<void> {
  const projectName = await getProjectName(env, input.projectId);
  const actorName = input.actor.name?.trim() || 'A teammate';
  const topic = sessionLabel(input.sessionTopic);
  const actionUrl = buildActionUrl(input.projectId, input.sessionId);
  const sends: Array<{ userId: string; title: string; body: string | null }> = [];

  const window = accessWindow(input.expiresAt);
  for (const userId of new Set(input.affectedUserIds)) {
    if (userId === input.actor.userId) continue;
    if (input.change === 'granted') {
      sends.push({
        userId,
        title: `${actorName} shared ${topic} with you`,
        body: `You can chat in this session${window}. It runs on the owner’s accounts.`,
      });
    } else if (input.change === 'renewed') {
      sends.push({
        userId,
        title: `${actorName} extended your access to ${topic}`,
        body: `You can chat in this session${window}.`,
      });
    } else {
      sends.push({ userId, title: `Your access to ${topic} was removed`, body: null });
    }
  }
  // An owner learns when someone they shared with passes the session on.
  if (
    input.change === 'granted' &&
    input.sessionOwnerUserId &&
    input.sessionOwnerUserId !== input.actor.userId
  ) {
    sends.push({
      userId: input.sessionOwnerUserId,
      title: `${actorName} shared your session ${topic} with ${input.granteeName ?? 'a teammate'}`,
      body: null,
    });
  }

  await Promise.all(
    sends.map(async (send) => {
      try {
        await sendNotification(env, send.userId, {
          projectId: input.projectId,
          sessionId: input.sessionId,
          type: 'session_access',
          urgency: NOTIFICATION_TYPE_URGENCY.session_access,
          title: send.title,
          body: send.body,
          actionUrl,
          metadata: { projectName, change: input.change, actorUserId: input.actor.userId },
        });
      } catch (err) {
        log.warn('collaboration.session_access_notification_failed', {
          projectId: input.projectId,
          sessionId: input.sessionId,
          recipientUserId: send.userId,
          change: input.change,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })
  );
}
