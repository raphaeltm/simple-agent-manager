/**
 * Notification Service — creates notifications by forwarding events
 * to the per-user Notification Durable Object.
 *
 * This service receives events from existing lifecycle hooks (task state
 * changes, MCP tool completions, session callbacks) and routes them to
 * the correct user's Notification DO.
 */

import type { CreateNotificationRequest } from '@simple-agent-manager/shared';
import { NOTIFICATION_TYPE_URGENCY, MAX_NOTIFICATION_BODY_LENGTH, MAX_NOTIFICATION_TITLE_LENGTH, MAX_NOTIFICATION_TITLE_LENGTH_NEEDS_INPUT, type HumanInputCategory } from '@simple-agent-manager/shared';
import type { NotificationService } from '../durable-objects/notification';

interface NotificationEnv {
  NOTIFICATION: DurableObjectNamespace;
  DATABASE: D1Database;
}

/**
 * Look up a project's name from D1 by its ID.
 * Returns a fallback string if the project is not found (defensive — notification
 * creation should never fail because of a missing project name).
 *
 * Uses raw D1 queries instead of Drizzle because this service only receives
 * `{ DATABASE: D1Database }`, not the full Env needed for a Drizzle instance.
 */
export async function getProjectName(env: { DATABASE: D1Database }, projectId: string): Promise<string> {
  try {
    const row = await env.DATABASE.prepare('SELECT name FROM projects WHERE id = ?')
      .bind(projectId)
      .first<{ name: string }>();
    return row?.name ?? projectId;
  } catch (err) {
    console.warn('getProjectName: D1 query failed, falling back to projectId', {
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return projectId;
  }
}

/**
 * Common opts shared by all notification helper functions.
 * `projectName` is required alongside `projectId` so the frontend can
 * display human-readable group headers without a fallback to truncated IDs.
 */
interface ProjectNotificationOpts {
  projectId: string;
  projectName: string;
}

function getStub(env: NotificationEnv, userId: string): DurableObjectStub<NotificationService> {
  return env.NOTIFICATION.get(
    env.NOTIFICATION.idFromName(userId)
  ) as DurableObjectStub<NotificationService>;
}

/**
 * Build the actionUrl for a notification, deep-linking to the chat session
 * when a sessionId is available.
 *
 * Returns a frontend-relative path consumed exclusively by the React app
 * via `navigate(notification.actionUrl)` in NotificationCenter. MUST NOT
 * be used for server-side redirects, web push click_action, or external
 * integrations — those require absolute `https://app.${BASE_DOMAIN}/...` URLs.
 *
 * sessionId is always an internal UUID from the ProjectData DO. Empty strings
 * are treated as absent (falls back to the project URL).
 */
export function buildActionUrl(projectId: string, sessionId?: string | null): string {
  if (sessionId) {
    return `/projects/${projectId}/chat/${sessionId}`;
  }
  return `/projects/${projectId}`;
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
  opts: ProjectNotificationOpts & {
    taskId: string;
    taskTitle: string;
    sessionId?: string | null;
    outputPrUrl?: string | null;
    outputBranch?: string | null;
  }
): Promise<void> {
  const actionUrl = buildActionUrl(opts.projectId, opts.sessionId);
  const body = opts.outputPrUrl
    ? `PR ready for review: ${opts.outputPrUrl}`
    : opts.outputBranch
      ? `Output on branch: ${opts.outputBranch}`
      : 'Task finished successfully';

  await sendNotification(env, userId, {
    type: 'task_complete',
    urgency: NOTIFICATION_TYPE_URGENCY.task_complete ?? 'medium',
    title: `Task completed: ${truncate(opts.taskTitle, MAX_NOTIFICATION_TITLE_LENGTH)}`,
    body,
    projectId: opts.projectId,
    taskId: opts.taskId,
    sessionId: opts.sessionId,
    actionUrl,
    metadata: {
      projectName: opts.projectName,
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
  opts: ProjectNotificationOpts & {
    taskId: string;
    taskTitle: string;
    errorMessage?: string | null;
    sessionId?: string | null;
  }
): Promise<void> {
  await sendNotification(env, userId, {
    type: 'error',
    urgency: NOTIFICATION_TYPE_URGENCY.error ?? 'high',
    title: `Task failed: ${truncate(opts.taskTitle, MAX_NOTIFICATION_TITLE_LENGTH)}`,
    body: opts.errorMessage ?? 'Task encountered an error',
    projectId: opts.projectId,
    taskId: opts.taskId,
    sessionId: opts.sessionId,
    actionUrl: buildActionUrl(opts.projectId, opts.sessionId),
    metadata: {
      projectName: opts.projectName,
    },
  });
}

/**
 * Emit a "session_ended" notification when an agent finishes a chat turn.
 */
export async function notifySessionEnded(
  env: NotificationEnv,
  userId: string,
  opts: ProjectNotificationOpts & {
    sessionId?: string | null;
    taskId?: string | null;
    taskTitle?: string | null;
  }
): Promise<void> {
  const title = opts.taskTitle
    ? `Agent finished: ${truncate(opts.taskTitle, MAX_NOTIFICATION_TITLE_LENGTH)}`
    : 'Agent finished — your turn';

  await sendNotification(env, userId, {
    type: 'session_ended',
    urgency: NOTIFICATION_TYPE_URGENCY.session_ended ?? 'medium',
    title,
    body: 'The agent has completed its turn. You can continue the conversation.',
    projectId: opts.projectId,
    taskId: opts.taskId,
    sessionId: opts.sessionId,
    actionUrl: buildActionUrl(opts.projectId, opts.sessionId),
    metadata: {
      projectName: opts.projectName,
    },
  });
}

/**
 * Emit a "pr_created" notification when a PR is created.
 */
export async function notifyPrCreated(
  env: NotificationEnv,
  userId: string,
  opts: ProjectNotificationOpts & {
    taskId: string;
    taskTitle: string;
    prUrl: string;
    branchName?: string | null;
    sessionId?: string | null;
  }
): Promise<void> {
  await sendNotification(env, userId, {
    type: 'pr_created',
    urgency: NOTIFICATION_TYPE_URGENCY.pr_created ?? 'medium',
    title: `PR created: ${truncate(opts.taskTitle, MAX_NOTIFICATION_TITLE_LENGTH)}`,
    body: `Pull request is ready for review`,
    projectId: opts.projectId,
    taskId: opts.taskId,
    sessionId: opts.sessionId,
    actionUrl: buildActionUrl(opts.projectId, opts.sessionId),
    metadata: {
      projectName: opts.projectName,
      prUrl: opts.prUrl,
      branchName: opts.branchName ?? null,
    },
  });
}

/**
 * Emit a "needs_input" notification when an agent requests human input.
 */
export async function notifyNeedsInput(
  env: NotificationEnv,
  userId: string,
  opts: ProjectNotificationOpts & {
    taskId: string;
    taskTitle: string;
    context: string;
    category?: HumanInputCategory | null;
    options?: string[] | null;
    sessionId?: string | null;
  }
): Promise<void> {
  const categoryLabel = opts.category
    ? opts.category.charAt(0).toUpperCase() + opts.category.slice(1).replaceAll('_', ' ')
    : 'Input';

  await sendNotification(env, userId, {
    type: 'needs_input',
    urgency: NOTIFICATION_TYPE_URGENCY.needs_input ?? 'high',
    title: `${categoryLabel} needed: ${truncate(opts.taskTitle, MAX_NOTIFICATION_TITLE_LENGTH_NEEDS_INPUT)}`,
    body: truncate(opts.context, MAX_NOTIFICATION_BODY_LENGTH),
    projectId: opts.projectId,
    taskId: opts.taskId,
    sessionId: opts.sessionId,
    actionUrl: buildActionUrl(opts.projectId, opts.sessionId),
    metadata: {
      projectName: opts.projectName,
      category: opts.category ?? null,
      options: opts.options ?? null,
    },
  });
}

/**
 * Emit a "progress" notification when an agent reports a status update.
 */
export async function notifyProgress(
  env: NotificationEnv,
  userId: string,
  opts: ProjectNotificationOpts & {
    taskId: string;
    taskTitle: string;
    message: string;
    sessionId?: string | null;
  }
): Promise<void> {
  await sendNotification(env, userId, {
    type: 'progress',
    urgency: NOTIFICATION_TYPE_URGENCY.progress ?? 'low',
    title: `Progress: ${truncate(opts.taskTitle, MAX_NOTIFICATION_TITLE_LENGTH)}`,
    body: truncate(opts.message, MAX_NOTIFICATION_BODY_LENGTH),
    projectId: opts.projectId,
    taskId: opts.taskId,
    sessionId: opts.sessionId,
    actionUrl: buildActionUrl(opts.projectId, opts.sessionId),
    metadata: {
      projectName: opts.projectName,
    },
  });
}

/**
 * Look up a workspace's chat session ID from D1 by its workspace ID.
 * Returns null if the workspace is not found or has no linked session.
 */
export async function getChatSessionId(env: { DATABASE: D1Database }, workspaceId: string): Promise<string | null> {
  try {
    const row = await env.DATABASE.prepare('SELECT chat_session_id FROM workspaces WHERE id = ?')
      .bind(workspaceId)
      .first<{ chat_session_id: string | null }>();
    return row?.chat_session_id ?? null;
  } catch (err) {
    console.warn('getChatSessionId: D1 query failed', {
      workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 1) + '\u2026';
}
