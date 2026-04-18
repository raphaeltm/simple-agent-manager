import { and, eq } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { errors } from './error';

export type AppDb = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Defence-in-depth identity check. The query WHERE clause already filters on
 * `userId`, so in normal operation a row is only returned when it belongs to
 * the caller. This extra check guards against future regressions where the
 * WHERE clause might be weakened (typo, refactor, or ORM bug) — if for any
 * reason a row with a mismatched `userId` reaches us, we reject it as
 * `notFound` rather than treating it as a valid match.
 *
 * MEDIUM #8: explicit post-query check for cross-user IDOR defence-in-depth.
 */
function assertOwnership<T extends { userId: string }>(
  row: T | undefined,
  userId: string,
  resource: string
): T {
  if (!row || row.userId !== userId) {
    throw errors.notFound(resource);
  }
  return row;
}

export async function requireOwnedProject(
  db: AppDb,
  projectId: string,
  userId: string
): Promise<schema.Project> {
  const rows = await db
    .select()
    .from(schema.projects)
    .where(and(eq(schema.projects.id, projectId), eq(schema.projects.userId, userId)))
    .limit(1);

  return assertOwnership(rows[0], userId, 'Project');
}

export async function requireOwnedTask(
  db: AppDb,
  projectId: string,
  taskId: string,
  userId: string
): Promise<schema.Task> {
  const rows = await db
    .select()
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.id, taskId),
        eq(schema.tasks.projectId, projectId),
        eq(schema.tasks.userId, userId)
      )
    )
    .limit(1);

  // Task has an additional projectId invariant beyond userId.
  const task = rows[0];
  if (!task || task.userId !== userId || task.projectId !== projectId) {
    throw errors.notFound('Task');
  }
  return task;
}

export async function requireOwnedWorkspace(
  db: AppDb,
  workspaceId: string,
  userId: string
): Promise<schema.Workspace> {
  const rows = await db
    .select()
    .from(schema.workspaces)
    .where(and(eq(schema.workspaces.id, workspaceId), eq(schema.workspaces.userId, userId)))
    .limit(1);

  return assertOwnership(rows[0], userId, 'Workspace');
}
