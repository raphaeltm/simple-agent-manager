/**
 * Shared failure transition for tasks that die before the TaskRunner takes
 * ownership (chat-session creation or runner/instant startup failures).
 * Used by the MCP dispatch and trigger submission paths.
 */
import { eq } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { ulid } from '../lib/ulid';

/**
 * Marks a queued task as failed and records the queued→failed status event.
 * The reason is stored as both the task error message and the event reason.
 */
export async function markQueuedTaskFailed(
  db: DrizzleD1Database<typeof schema>,
  taskId: string,
  reason: string
): Promise<void> {
  const failedAt = new Date().toISOString();
  await db
    .update(schema.tasks)
    .set({ status: 'failed', errorMessage: reason, updatedAt: failedAt })
    .where(eq(schema.tasks.id, taskId));
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
}
