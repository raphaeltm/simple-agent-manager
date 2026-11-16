/**
 * The worker side of human tasks (`OperationInboxTaskPort`, inbox slice H1): `sam.inbox` events
 * through the durable source outbox, task subscriptions in the project's Durable Object, the
 * comment core (anchor kind `inbox_item`), the agent-wake policy, and notifications. No task rule
 * lives here; `packages/operations/src/inbox-task-core.ts` decides and calls these.
 */
import type { OperationInboxTaskPort } from '@simple-agent-manager/operations';
import {
  type AdmitProjectEventInput,
  INBOX_EVENT_SOURCE,
  INBOX_EVENT_SUBJECT_TYPE,
  INBOX_TASK_DEFAULT_WAKE_EVENT_TYPES,
  INBOX_TASK_STEP_EVENT_TYPES,
  NOTIFICATION_TYPE_URGENCY,
  PROJECT_EVENT_FILTER_VERSION,
} from '@simple-agent-manager/shared';
import { ulid } from '@simple-agent-manager/worker-core';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { decideInboxTaskCommentWake } from '../agent-wake-authorization';
import { getProjectName, sendNotification, sendNotificationOnce } from '../notification';
import * as projectDataService from '../project-data';
import { enqueueAndAdmitProjectEventSourceIntent } from '../project-event-source-outbox';
import { resolveDeliveryPreference } from '../project-event-subscriptions-access';

const PREVIEW_MAX = 140;

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function displayName(env: Env, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const row = await env.DATABASE.prepare('SELECT name, email FROM users WHERE id = ?')
    .bind(userId)
    .first<{ name: string | null; email: string | null }>();
  return row?.name?.trim() || row?.email?.split('@')[0] || null;
}

function inboxItemUrl(projectId: string, askId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/inbox?item=${encodeURIComponent(`ask:${askId}`)}`;
}

function preview(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX - 1)}…` : flat;
}

/** Whether every reader of a person's task (not a team task) includes this user. */
function mayRead(readers: 'project' | string[], userId: string): boolean {
  return readers === 'project' || readers.includes(userId);
}

export function createInboxTaskPort(env: Env): OperationInboxTaskPort {
  return {
    async admitEvent(input) {
      try {
        const actorName =
          input.actor.name ??
          (input.actor.kind === 'user' ? await displayName(env, input.actor.id) : null);
        const occurredAt = Date.now();
        const eventId = ulid();
        const metadata = {
          actor: { kind: input.actor.kind, id: input.actor.id, name: actorName },
          teammateInput: input.teammateInput,
          askId: input.askId,
          ...(input.detail ? { detail: input.detail } : {}),
        };
        const event: AdmitProjectEventInput = {
          projectId: input.projectId,
          source: INBOX_EVENT_SOURCE,
          eventType: input.eventType,
          subject: { type: INBOX_EVENT_SUBJECT_TYPE, id: input.askId },
          severity: 'info',
          // One event per change: the id is minted here, so a retry of the outbox replays it.
          deliveryKey: `inbox:${input.askId}:${eventId}`,
          payloadFingerprint: await sha256Hex(JSON.stringify([input.eventType, metadata])),
          metadata,
          occurredAt,
          receivedAt: occurredAt,
        };
        await enqueueAndAdmitProjectEventSourceIntent(env, event);
        return true;
      } catch (error) {
        log.error('inbox.task_event_admission_failed', {
          projectId: input.projectId,
          askId: input.askId,
          eventType: input.eventType,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    },

    async watch(input) {
      const session = await projectDataService.getSession(env, input.projectId, input.sessionId);
      if (!session || session.taskId !== input.taskId) {
        throw new Error('The watching chat is not this task’s chat');
      }
      const task = await env.DATABASE.prepare(
        'SELECT recovery_source_task_id FROM tasks WHERE id = ? AND project_id = ?'
      )
        .bind(input.taskId, input.projectId)
        .first<{ recovery_source_task_id: string | null }>();
      const eventTypes = [
        ...INBOX_TASK_DEFAULT_WAKE_EVENT_TYPES,
        ...(input.includeSteps ? INBOX_TASK_STEP_EVENT_TYPES : []),
      ];
      const result = await projectDataService.createProjectEventSubscription(env, input.projectId, {
        // The same owner identity the chat's own subscriptions use, so the agent can list and
        // cancel this one with the event tools.
        owner: { type: 'agent', id: `${input.projectId}:${input.sessionId}`, name: null },
        idempotencyKey: `inbox-watch:${input.askId}`,
        filter: {
          version: PROJECT_EVENT_FILTER_VERSION,
          source: INBOX_EVENT_SOURCE,
          subjectType: INBOX_EVENT_SUBJECT_TYPE,
          subjectId: input.askId,
          eventType: eventTypes,
        },
        deliveryPreference: resolveDeliveryPreference('existing_session_prompt', {
          sessionId: input.sessionId,
          taskId: input.taskId,
          runtimeId: null,
          agentId: input.agentSessionId,
        }),
        ownerTaskId: task?.recovery_source_task_id ?? input.taskId,
        reason: 'Watching a human task in the inbox',
        // A task never expires, so neither does the watch. When the chat's work is finished
        // the source-task guard stops waking it and the events stay recorded.
        expiresAt: null,
      });
      return { subscriptionId: result.subscription.id, created: !result.idempotent };
    },

    countWatchers: (projectId, askId) =>
      projectDataService.countInboxItemWatchers(env, projectId, askId),

    decideCommentWake: (input) => decideInboxTaskCommentWake(env, input),

    listComments: (projectId, askId) =>
      projectDataService.listInboxItemCommentThreads(env, projectId, { itemId: askId }),

    async createComment(projectId, input) {
      const actorName =
        input.actor.name ??
        (input.actor.kind === 'human' ? await displayName(env, input.actor.id) : 'Agent');
      const result = await projectDataService.createInboxItemComment(env, projectId, {
        itemId: input.askId,
        threadId: input.threadId ?? null,
        body: input.body,
        clientMutationId: input.clientMutationId ?? null,
        actor: { kind: input.actor.kind, id: input.actor.id, name: actorName },
        mentions: input.mentions,
      });
      return { thread: result.thread, commentId: result.commentId };
    },

    async resolveMentions(projectId, userIds) {
      const ids = [...new Set(userIds.map((id) => id.trim()).filter(Boolean))].slice(0, 20);
      if (ids.length === 0) return [];
      const rows = await env.DATABASE.prepare(
        `SELECT pm.user_id AS user_id, u.name AS name, u.email AS email
           FROM project_members pm JOIN users u ON u.id = pm.user_id
          WHERE pm.project_id = ? AND pm.status = 'active'
            AND pm.user_id IN (${ids.map(() => '?').join(', ')})`
      )
        .bind(projectId, ...ids)
        .all<{ user_id: string; name: string | null; email: string | null }>();
      const byId = new Map((rows.results ?? []).map((row) => [row.user_id, row]));
      return ids.flatMap((userId) => {
        const row = byId.get(userId);
        return row
          ? [{ userId, displayName: row.name?.trim() || row.email?.split('@')[0] || null }]
          : [];
      });
    },

    async notifyComment(input) {
      if (!env.NOTIFICATION) return;
      try {
        const [projectName, actorName] = await Promise.all([
          getProjectName(env, input.projectId),
          input.actor.name
            ? Promise.resolve(input.actor.name)
            : displayName(env, input.actor.userId),
        ]);
        const who = actorName ?? 'A teammate';
        const recipients = new Map<string, 'mention' | 'comment'>();
        for (const mention of input.mentions) recipients.set(mention.userId, 'mention');
        for (const userId of input.participants) {
          if (!recipients.has(userId)) recipients.set(userId, 'comment');
        }
        recipients.delete(input.actor.userId);
        const now = Date.now();
        await Promise.all(
          [...recipients].map(async ([userId, reason]) => {
            // Nobody hears about a task they cannot open (a mention included).
            if (!mayRead(input.readers, userId)) return;
            const notification = {
              projectId: input.projectId,
              type: reason,
              urgency: NOTIFICATION_TYPE_URGENCY[reason],
              title:
                reason === 'mention'
                  ? `${who} mentioned you on the task “${preview(input.title)}”`
                  : `${who} commented on the task “${preview(input.title)}”`,
              body: preview(input.body),
              actionUrl: inboxItemUrl(input.projectId, input.askId),
              metadata: {
                projectName,
                reason,
                inboxItemRef: `ask:${input.askId}`,
                threadId: input.threadId,
                commentId: input.commentId,
                actorUserId: input.actor.userId,
              },
            };
            try {
              await sendNotificationOnce(
                env,
                userId,
                `inbox-task-comment:${input.commentId}`,
                now + 24 * 60 * 60 * 1000,
                notification,
                now
              );
            } catch (error) {
              log.warn('inbox.task_comment_notification_failed', {
                projectId: input.projectId,
                askId: input.askId,
                recipientUserId: userId,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          })
        );
      } catch (error) {
        log.warn('inbox.task_comment_notify_failed', {
          projectId: input.projectId,
          askId: input.askId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },

    async notifyAssigned(input) {
      if (!env.NOTIFICATION || input.userIds.length === 0) return;
      try {
        const projectName = await getProjectName(env, input.projectId);
        await Promise.all(
          input.userIds.map((userId) =>
            sendNotification(env, userId, {
              projectId: input.projectId,
              // Low urgency and in-app only: a task is a to-do, not an interruption.
              type: 'progress',
              urgency: 'low',
              title: `New task for you: ${preview(input.title)}`,
              body: 'An agent handed you a task. It does not block the agent.',
              actionUrl: inboxItemUrl(input.projectId, input.askId),
              metadata: { projectName, inboxItemRef: `ask:${input.askId}` },
            })
          )
        );
      } catch (error) {
        log.warn('inbox.task_assigned_notification_failed', {
          projectId: input.projectId,
          askId: input.askId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
