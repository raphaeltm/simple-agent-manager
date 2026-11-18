/**
 * The workspace record a session sleep acts on. Split out of `session-sleep-teardown.ts`
 * (`.claude/rules/18-file-size-limits.md`); re-exported from there.
 */
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';

export async function loadSleepWorkspace(env: Env, workspaceId: string, userId: string) {
  const db = drizzle(env.DATABASE, { schema });
  const [workspace] = await db
    .select({
      id: schema.workspaces.id,
      userId: schema.workspaces.userId,
      projectId: schema.workspaces.projectId,
      chatSessionId: schema.workspaces.chatSessionId,
      status: schema.workspaces.status,
      evictionGeneration: schema.workspaces.evictionGeneration,
      nodeId: schema.workspaces.nodeId,
      nodeRuntime: schema.nodes.runtime,
      nodeStatus: schema.nodes.status,
      // Sleep-requirement inputs (`session-sleep-requirement.ts`).
      nodeCreatedAt: schema.nodes.createdAt,
      nodeRole: schema.nodes.nodeRole,
      nodeClass: schema.nodes.nodeClass,
      nodeAutoProvisioned: sql<number>`EXISTS (SELECT 1 FROM tasks auto_task
        WHERE auto_task.auto_provisioned_node_id = ${schema.workspaces.nodeId})`,
      taskId: schema.tasks.id,
      taskStatus: schema.tasks.status,
      taskCompletedAt: sql<
        string | null
      >`COALESCE(${schema.tasks.completedAt}, ${schema.tasks.updatedAt})`,
      warmNodeTimeoutMs: schema.projects.warmNodeTimeoutMs,
    })
    .from(schema.workspaces)
    .leftJoin(schema.nodes, eq(schema.nodes.id, schema.workspaces.nodeId))
    .leftJoin(
      schema.sessionSummaries,
      eq(schema.sessionSummaries.id, schema.workspaces.chatSessionId)
    )
    .leftJoin(
      schema.tasks,
      or(
        eq(schema.tasks.id, schema.sessionSummaries.taskId),
        and(
          isNull(schema.sessionSummaries.taskId),
          eq(schema.tasks.chatSessionId, schema.workspaces.chatSessionId)
        )
      )
    )
    .leftJoin(schema.projects, eq(schema.projects.id, schema.workspaces.projectId))
    .where(and(eq(schema.workspaces.id, workspaceId), eq(schema.workspaces.userId, userId)))
    .limit(1);
  if (
    !workspace?.projectId ||
    !workspace.chatSessionId ||
    !workspace.nodeId ||
    !workspace.nodeRuntime
  ) {
    throw new Error('Workspace is missing persistent-session ownership metadata');
  }

  return {
    ...workspace,
    projectId: workspace.projectId,
    chatSessionId: workspace.chatSessionId,
    nodeId: workspace.nodeId,
    nodeRuntime: workspace.nodeRuntime,
  };
}

export type SleepWorkspace = Awaited<ReturnType<typeof loadSleepWorkspace>>;
