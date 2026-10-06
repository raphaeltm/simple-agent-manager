import { and, desc, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';
import {
  DEFAULT_SESSION_SLEEP_AFTER_MS,
  ensureSessionSnapshotForSleep,
  scheduleSessionSnapshotSleep,
} from './session-snapshots';

export async function queueWorkspaceSessionSleep(
  env: Env,
  input: {
    workspaceId: string;
    userId: string;
    reason: string;
    sleepAfterMs?: number;
    expectedNodeId?: string;
    signal?: AbortSignal;
  }
): Promise<void> {
  input.signal?.throwIfAborted();
  const db = drizzle(env.DATABASE, { schema });
  const [workspace] = await db
    .select({
      id: schema.workspaces.id,
      userId: schema.workspaces.userId,
      projectId: schema.workspaces.projectId,
      chatSessionId: schema.workspaces.chatSessionId,
      nodeId: schema.workspaces.nodeId,
      nodeRuntime: schema.nodes.runtime,
    })
    .from(schema.workspaces)
    .leftJoin(schema.nodes, eq(schema.nodes.id, schema.workspaces.nodeId))
    .where(
      and(eq(schema.workspaces.id, input.workspaceId), eq(schema.workspaces.userId, input.userId))
    )
    .limit(1);
  if (
    !workspace?.projectId ||
    !workspace.chatSessionId ||
    !workspace.nodeId ||
    !workspace.nodeRuntime
  ) {
    throw new Error('Workspace is missing persistent-session ownership metadata');
  }
  input.signal?.throwIfAborted();
  if (input.expectedNodeId && workspace.nodeId !== input.expectedNodeId) {
    throw new Error('Workspace moved from the unhealthy node');
  }
  const [agentSession] = await db
    .select({ id: schema.agentSessions.id })
    .from(schema.agentSessions)
    .where(
      and(
        eq(schema.agentSessions.workspaceId, workspace.id),
        inArray(schema.agentSessions.status, ['running', 'recovery', 'sleeping'])
      )
    )
    .orderBy(desc(schema.agentSessions.createdAt))
    .limit(1);
  if (!agentSession) throw new Error('Workspace has no resumable agent session');

  input.signal?.throwIfAborted();

  const snapshotInput = {
    workspaceId: workspace.id,
    nodeId: workspace.nodeId,
    projectId: workspace.projectId,
    userId: workspace.userId,
    chatSessionId: workspace.chatSessionId,
    agentSessionId: agentSession.id,
    runtime: workspace.nodeRuntime,
  };
  const prepared = input.expectedNodeId
    ? await ensureSessionSnapshotForSleep(db, env, snapshotInput, {
        expectedNodeId: input.expectedNodeId,
      })
    : await ensureSessionSnapshotForSleep(db, env, snapshotInput);
  input.signal?.throwIfAborted();
  if (input.expectedNodeId && !prepared) {
    throw new Error('Workspace moved from the unhealthy node');
  }
  if (input.expectedNodeId) {
    const [current] = await db
      .select({ nodeId: schema.workspaces.nodeId, chatSessionId: schema.workspaces.chatSessionId })
      .from(schema.workspaces)
      .where(
        and(eq(schema.workspaces.id, workspace.id), eq(schema.workspaces.userId, input.userId))
      )
      .limit(1);
    input.signal?.throwIfAborted();
    if (
      current?.nodeId !== input.expectedNodeId ||
      current.chatSessionId !== workspace.chatSessionId
    ) {
      throw new Error('Workspace moved from the unhealthy node');
    }
  }
  const sleepAfterMs =
    input.sleepAfterMs ??
    parsePositiveInt(env.SESSION_SLEEP_AFTER_MS, DEFAULT_SESSION_SLEEP_AFTER_MS);
  const scheduled = await scheduleSessionSnapshotSleep(
    db,
    env,
    workspace.chatSessionId,
    new Date(),
    {
      sleepAfterMs,
      allowIncomplete: true,
      resetAttempts: false,
      ...(input.expectedNodeId
        ? { expectedWorkspaceId: workspace.id, expectedNodeId: input.expectedNodeId }
        : {}),
    }
  );
  if (input.expectedNodeId && !scheduled) {
    throw new Error('Workspace moved from the unhealthy node');
  }
  log.info('session_sleep.queued', {
    workspaceId: workspace.id,
    chatSessionId: workspace.chatSessionId,
    reason: input.reason,
    sleepAfterMs,
  });
}
