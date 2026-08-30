/**
 * Shared failure transition for tasks that die before the TaskRunner takes
 * ownership (chat-session creation or runner/instant startup failures).
 * Used by the MCP dispatch and trigger submission paths.
 */
import { and, eq } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { ulid } from '../lib/ulid';
import { recordTaskLifecycleEventBestEffort } from './project-lifecycle-events';

export interface MarkQueuedTaskFailedEventContext {
  env: Env;
  projectId: string;
  source: string;
  workspaceId?: string | null;
  sessionId?: string | null;
  nodeId?: string | null;
}

/**
 * Marks a still-queued task as failed and records the queued→failed status
 * event. The reason is stored as both the task error message and the event
 * reason.
 *
 * The update is optimistically locked on `status = 'queued'` so a concurrent
 * handler that already advanced or terminally transitioned the task (e.g.
 * `launchInstantSession`'s own failure path, or a TaskRunner DO that started
 * despite a thrown ack) is never clobbered. Returns true when this call
 * performed the transition.
 */
export async function markQueuedTaskFailed(
  db: DrizzleD1Database<typeof schema>,
  taskId: string,
  reason: string,
  eventContext?: MarkQueuedTaskFailedEventContext
): Promise<boolean> {
  const failedAt = new Date().toISOString();
  const result = await db
    .update(schema.tasks)
    .set({ status: 'failed', errorMessage: reason, updatedAt: failedAt })
    .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.status, 'queued')));
  if (!result.meta.changes) {
    return false;
  }
  await db.insert(schema.taskStatusEvents).values({
    id: ulid(),
    taskId,
    fromStatus: 'queued',
    toStatus: 'failed',
    actorType: 'system',
    actorId: null,
    reason,
    createdAt: failedAt,
  });
  if (eventContext) {
    await recordTaskLifecycleEventBestEffort(eventContext.env, {
      projectId: eventContext.projectId,
      taskId,
      status: 'failed',
      fromStatus: 'queued',
      workspaceId: eventContext.workspaceId,
      sessionId: eventContext.sessionId,
      nodeId: eventContext.nodeId,
      actorType: 'system',
      actorId: null,
      reason,
      source: eventContext.source,
      occurredAt: failedAt,
    });
  }
  return true;
}
