/**
 * Notification Service — creates notifications by forwarding events
 * to the per-user Notification Durable Object.
 *
 * This service receives events from existing lifecycle hooks (task state
 * changes, MCP tool completions, session callbacks) and routes them to
 * the correct user's Notification DO.
 */

import type { CreateNotificationRequest, NotificationResponse } from '@simple-agent-manager/shared';
import {
  classifyFailure,
  type HumanInputCategory,
  MAX_NOTIFICATION_BODY_LENGTH,
  MAX_NOTIFICATION_TITLE_LENGTH,
  MAX_NOTIFICATION_TITLE_LENGTH_NEEDS_INPUT,
  NOTIFICATION_TYPE_URGENCY,
} from '@simple-agent-manager/shared';

import type { NotificationService } from '../durable-objects/notification';
import { log } from '../lib/logger';

export interface NotificationEnv {
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
export async function getProjectName(
  env: { DATABASE: D1Database },
  projectId: string
): Promise<string> {
  try {
    const row = await env.DATABASE.prepare('SELECT name FROM projects WHERE id = ?')
      .bind(projectId)
      .first<{ name: string }>();
    return row?.name ?? projectId;
  } catch (err) {
    log.warn('notification.get_project_name_failed', {
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
 * via `navigate(notification.actionUrl)` in the inbox Updates list (`InboxUpdatesList`). MUST NOT
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
 * Relative URL of one inbox item (the project inbox page, `?item=<ref>`). Same-origin relative,
 * like `buildActionUrl`; the ref is URL-encoded.
 */
export function buildInboxItemActionUrl(projectId: string, ref: string): string {
  return `/projects/${projectId}/inbox?item=${encodeURIComponent(ref)}`;
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
): Promise<NotificationResponse> {
  const stub = getStub(env, userId);
  return stub.createNotification(userId, notification);
}

/**
 * Send only after atomically claiming an expiring key in the per-user DO.
 * KV may be used as a coarse outer cache, but this claim is the strict
 * concurrency boundary for notification throttles.
 */
export async function sendNotificationOnce(
  env: NotificationEnv,
  userId: string,
  dedupKey: string,
  expiresAt: number,
  notification: CreateNotificationRequest,
  now: number = Date.now()
): Promise<boolean> {
  const stub = getStub(env, userId);
  if (!(await stub.claimNotificationDeduplication(dedupKey, expiresAt, now))) return false;
  await stub.createNotification(userId, notification);
  return true;
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
    /** The task's inbox error item, when one was filed: the notification opens it. */
    inboxRef?: string | null;
  }
): Promise<void> {
  await sendNotification(env, userId, {
    type: 'error',
    urgency: NOTIFICATION_TYPE_URGENCY.error ?? 'high',
    title: `Task failed: ${truncate(opts.taskTitle, MAX_NOTIFICATION_TITLE_LENGTH)}`,
    // The classified plain sentence, never the agent's raw error text (it can carry command
    // fragments, URLs or echoed tokens, and the push body shows on a lock screen).
    body: classifyFailure(opts.errorMessage).explanation,
    projectId: opts.projectId,
    taskId: opts.taskId,
    sessionId: opts.sessionId,
    actionUrl: opts.inboxRef
      ? buildInboxItemActionUrl(opts.projectId, opts.inboxRef)
      : buildActionUrl(opts.projectId, opts.sessionId),
    metadata: {
      projectName: opts.projectName,
    },
  });
}

/**
 * Emit the notification for a newly filed system error inbox item (slice E): `error` for a
 * failed task, chat wake or answer delivery, `cron_failure` for a failing automation. Title and
 * body are the item's own sanitized sentences; the link opens the item.
 */
export async function notifySystemError(
  env: NotificationEnv,
  userId: string,
  opts: ProjectNotificationOpts & {
    type: 'error' | 'cron_failure';
    ref: string;
    title: string;
    body: string;
    taskId?: string | null;
    sessionId?: string | null;
  }
): Promise<void> {
  await sendNotification(env, userId, {
    type: opts.type,
    urgency: NOTIFICATION_TYPE_URGENCY[opts.type] ?? 'high',
    title: truncate(opts.title, MAX_NOTIFICATION_TITLE_LENGTH),
    body: truncate(opts.body, MAX_NOTIFICATION_BODY_LENGTH),
    projectId: opts.projectId,
    taskId: opts.taskId ?? null,
    sessionId: opts.sessionId ?? null,
    actionUrl: buildInboxItemActionUrl(opts.projectId, opts.ref),
    metadata: { projectName: opts.projectName, inboxRef: opts.ref },
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
    attentionMarkerId: string;
    /** The ask's inbox item, when it has one: the notification opens it. */
    inboxRef?: string | null;
    /** Overrides the category label ("Review" for an inbox review item). */
    label?: string;
    /** Replaces "<label> needed" ("Result ready" for an inbox result item). */
    heading?: string;
    /** An inbox item's kind; notifications of different kinds are never merged. */
    inboxKind?: 'review' | 'result';
  }
): Promise<NotificationResponse> {
  const categoryLabel =
    opts.label ??
    (opts.category
      ? opts.category.charAt(0).toUpperCase() + opts.category.slice(1).replaceAll('_', ' ')
      : 'Input');
  const heading = opts.heading ?? `${categoryLabel} needed`;

  return sendNotification(env, userId, {
    type: 'needs_input',
    urgency: NOTIFICATION_TYPE_URGENCY.needs_input ?? 'high',
    title: `${heading}: ${truncate(opts.taskTitle, MAX_NOTIFICATION_TITLE_LENGTH_NEEDS_INPUT)}`,
    body: truncate(opts.context, MAX_NOTIFICATION_BODY_LENGTH),
    projectId: opts.projectId,
    taskId: opts.taskId,
    sessionId: opts.sessionId,
    actionUrl: opts.inboxRef
      ? buildInboxItemActionUrl(opts.projectId, opts.inboxRef)
      : buildActionUrl(opts.projectId, opts.sessionId),
    metadata: {
      projectName: opts.projectName,
      category: opts.category ?? null,
      options: opts.options ?? null,
      attentionMarkerId: opts.attentionMarkerId,
      ...(opts.inboxKind ? { inboxKind: opts.inboxKind } : {}),
    },
  });
}

/** How long the once-per-request claim for an ACP interaction notification is held. */
const INTERACTION_NOTIFICATION_DEDUP_MS = 7 * 24 * 60 * 60 * 1000;

const INTERACTION_COPY: Record<'permission' | 'form' | 'url', { title: string; body: string }> = {
  permission: {
    title: 'Permission needed',
    body: 'The agent is waiting for you to allow or deny what it wants to do next.',
  },
  form: { title: 'Input needed', body: 'The agent is waiting for you to fill in a short form.' },
  url: { title: 'Link to open', body: 'The agent is waiting for you to open a link.' },
};

/**
 * Emit the "needs_input" notification for an ACP permission, form or URL request (inbox slice
 * E): the same high-urgency notification a question sends, once per request (claimed in the
 * Notification DO), linking the request's inbox item. The body never carries the tool call or
 * command the agent asked about.
 */
export async function notifyInteractionRequested(
  env: NotificationEnv,
  userId: string,
  opts: ProjectNotificationOpts & {
    interactionId: string;
    interactionKind: string;
    sessionId: string;
    taskId: string | null;
    topic: string | null;
    inboxRef: string;
  }
): Promise<boolean> {
  const kind =
    opts.interactionKind === 'form' || opts.interactionKind === 'url'
      ? opts.interactionKind
      : 'permission';
  const copy = INTERACTION_COPY[kind];
  const title = opts.topic ? `${copy.title}: ${opts.topic}` : copy.title;
  return sendNotificationOnce(
    env,
    userId,
    `acp-interaction:${opts.interactionId}`,
    Date.now() + INTERACTION_NOTIFICATION_DEDUP_MS,
    {
      type: 'needs_input',
      urgency: NOTIFICATION_TYPE_URGENCY.needs_input ?? 'high',
      title: truncate(title, MAX_NOTIFICATION_TITLE_LENGTH_NEEDS_INPUT),
      body: copy.body,
      projectId: opts.projectId,
      taskId: opts.taskId,
      sessionId: opts.sessionId,
      actionUrl: buildInboxItemActionUrl(opts.projectId, opts.inboxRef),
      metadata: {
        projectName: opts.projectName,
        interactionKind: kind,
        inboxRef: opts.inboxRef,
      },
    }
  );
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
    fullMessage?: string;
    sessionId?: string | null;
  }
): Promise<void> {
  const metadata: Record<string, unknown> = {
    projectName: opts.projectName,
  };
  if (opts.fullMessage) {
    metadata.fullMessage = opts.fullMessage;
  }
  await sendNotification(env, userId, {
    type: 'progress',
    urgency: NOTIFICATION_TYPE_URGENCY.progress ?? 'low',
    title: `Progress: ${truncate(opts.taskTitle, MAX_NOTIFICATION_TITLE_LENGTH)}`,
    body: truncate(opts.message, MAX_NOTIFICATION_BODY_LENGTH),
    projectId: opts.projectId,
    taskId: opts.taskId,
    sessionId: opts.sessionId,
    actionUrl: buildActionUrl(opts.projectId, opts.sessionId),
    metadata,
  });
}

/**
 * Look up a workspace's chat session ID from D1 by its workspace ID.
 * Returns null if the workspace is not found or has no linked session.
 */
export async function getChatSessionId(
  env: { DATABASE: D1Database },
  workspaceId: string
): Promise<string | null> {
  try {
    const row = await env.DATABASE.prepare('SELECT chat_session_id FROM workspaces WHERE id = ?')
      .bind(workspaceId)
      .first<{ chat_session_id: string | null }>();
    return row?.chat_session_id ?? null;
  } catch (err) {
    log.warn('notification.get_chat_session_id_failed', {
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
