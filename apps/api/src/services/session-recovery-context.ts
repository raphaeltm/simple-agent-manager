import { desc, eq, or } from 'drizzle-orm';

import * as schema from '../db/schema';
import type { Db } from './session-recovery-task-guard';

export type RecoveryContext = {
  snapshot: schema.SessionSnapshot;
  project: schema.Project;
  workspace: schema.Workspace;
  user: schema.User;
  sourceTask: schema.Task | null;
};

export async function loadRecoveryContext(
  db: Db,
  projectId: string,
  chatSessionId: string
): Promise<RecoveryContext | null> {
  const snapshot = await db
    .select()
    .from(schema.sessionSnapshots)
    .where(eq(schema.sessionSnapshots.chatSessionId, chatSessionId))
    .get();
  if (!snapshot?.workspaceId || snapshot.projectId !== projectId || !snapshot.sleepingAt) {
    return null;
  }

  const [project, workspace, user] = await Promise.all([
    db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get(),
    db.select().from(schema.workspaces).where(eq(schema.workspaces.id, snapshot.workspaceId)).get(),
    db.select().from(schema.users).where(eq(schema.users.id, snapshot.userId)).get(),
  ]);
  if (!project || !workspace || !user || workspace.userId !== snapshot.userId) return null;

  const sourceTask = await db
    .select()
    .from(schema.tasks)
    .where(
      or(
        eq(schema.tasks.chatSessionId, chatSessionId),
        eq(schema.tasks.workspaceId, snapshot.workspaceId)
      )
    )
    .orderBy(desc(schema.tasks.updatedAt))
    .get();
  return { snapshot, project, workspace, user, sourceTask: sourceTask ?? null };
}
