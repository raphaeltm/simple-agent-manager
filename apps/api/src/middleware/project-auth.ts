import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../db/schema';
import { errors } from './error';

export type AppDb = ReturnType<typeof drizzle<typeof schema>>;

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

  const project = rows[0];
  if (!project) {
    throw errors.notFound('Project');
  }

  return project;
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

  const task = rows[0];
  if (!task) {
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

  const workspace = rows[0];
  if (!workspace) {
    throw errors.notFound('Workspace');
  }

  return workspace;
}
