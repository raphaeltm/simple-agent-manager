/**
 * Notification Service — creates notifications by forwarding events
 * to the per-user Notification Durable Object.
 *
 * This service receives events from existing lifecycle hooks (task state
 * changes, MCP tool completions, session callbacks) and routes them to
 * the correct user's Notification DO.
 */

import type { CreateNotificationRequest } from '@simple-agent-manager/shared';
import { NOTIFICATION_TYPE_URGENCY } from '@simple-agent-manager/shared';
import type { NotificationService } from '../durable-objects/notification';

interface NotificationEnv {
  NOTIFICATION: DurableObjectNamespace;
}

function getStub(env: NotificationEnv, userId: string): DurableObjectStub<NotificationService> {
  return env.NOTIFICATION.get(
    env.NOTIFICATION.idFromName(userId)
  ) as DurableObjectStub<NotificationService>;
}

/**
 * Send a notification to a specific user via their Notification DO.
 *
 * This is a fire-and-forget operation — callers should use waitUntil()
 * and catch errors so notification failures don't break the main flow.
 */
export async function sendNotification(
  env: NotificationEnv,
  userId: string,
  notification: CreateNotificationRequest
): Promise<void> {
  const stub = getStub(env, userId);
  await stub.createNotification(userId, notification);
}

/**
 * Emit a "task_complete" notification when a task finishes successfully.
 */
export async function notifyTaskComplete(
  env: NotificationEnv,
  userId: string,
  opts: {
    projectId: string;
    taskId: string;
    taskTitle: string;
    sessionId?: string | null;
    outputPrUrl?: string | null;
    outputBranch?: string | null;
  }
): Promise<void> {
  const actionUrl = `/projects/${opts.projectId}`;
  const body = opts.outputPrUrl
    ? `PR ready for review: ${opts.outputPrUrl}`
    : opts.outputBranch
      ? `Output on branch: ${opts.outputBranch}`
      : 'Task finished successfully';

  await sendNotification(env, userId, {
    type: 'task_complete',
    urgency: NOTIFICATION_TYPE_URGENCY.task_complete ?? 'medium',
    title: `Task completed: ${truncate(opts.taskTitle, 80)}`,
    body,
    projectId: opts.projectId,
    taskId: opts.taskId,
    sessionId: opts.sessionId,
    actionUrl,
    metadata: {
      outputPrUrl: opts.outputPrUrl ?? null,
      outputBranch: opts.outputBranch ?? null,
    },
  });
}

/**
 * Emit an "error" notification when a task fails.
 */
export async function notifyTaskFailed(
  env: NotificationEnv,
  userId: string,
  opts: {
    projectId: string;
    taskId: string;
    taskTitle: string;
    errorMessage?: string | null;
    sessionId?: string | null;
  }
): Promise<void> {
  await sendNotification(env, userId, {
    type: 'error',
    urgency: NOTIFICATION_TYPE_URGENCY.error ?? 'high',
    title: `Task failed: ${truncate(opts.taskTitle, 80)}`,
    body: opts.errorMessage ?? 'Task encountered an error',
    projectId: opts.projectId,
    taskId: opts.taskId,
    sessionId: opts.sessionId,
    actionUrl: `/projects/${opts.projectId}`,
  });
}

/**
 * Emit a "session_ended" notification when an agent finishes a chat turn.
 */
export async function notifySessionEnded(
  env: NotificationEnv,
  userId: string,
  opts: {
    projectId: string;
    sessionId: string;
    taskId?: string | null;
    taskTitle?: string | null;
  }
): Promise<void> {
  const title = opts.taskTitle
    ? `Agent finished: ${truncate(opts.taskTitle, 80)}`
    : 'Agent finished — your turn';

  await sendNotification(env, userId, {
    type: 'session_ended',
    urgency: NOTIFICATION_TYPE_URGENCY.session_ended ?? 'medium',
    title,
    body: 'The agent has completed its turn. You can continue the conversation.',
    projectId: opts.projectId,
    taskId: opts.taskId,
    sessionId: opts.sessionId,
    actionUrl: `/projects/${opts.projectId}`,
  });
}

/**
 * Emit a "pr_created" notification when a PR is created.
 */
export async function notifyPrCreated(
  env: NotificationEnv,
  userId: string,
  opts: {
    projectId: string;
    taskId: string;
    taskTitle: string;
    prUrl: string;
    branchName?: string | null;
  }
): Promise<void> {
  await sendNotification(env, userId, {
    type: 'pr_created',
    urgency: NOTIFICATION_TYPE_URGENCY.pr_created ?? 'medium',
    title: `PR created: ${truncate(opts.taskTitle, 80)}`,
    body: `Pull request is ready for review`,
    projectId: opts.projectId,
    taskId: opts.taskId,
    actionUrl: `/projects/${opts.projectId}`,
    metadata: {
      prUrl: opts.prUrl,
      branchName: opts.branchName ?? null,
    },
  });
}

function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 1) + '\u2026';
}
