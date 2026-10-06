/**
 * Tenant-scoped resolution of the workspace bridging a chat session to its
 * runtime. Recovery states are admitted only for cf-container nodes; VM
 * sessions preserve their fail-fast dead-node guard.
 */
import { and, eq, inArray, or } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { log } from '../lib/logger';
import { errors } from '../middleware/error';

type ChatDb = ReturnType<typeof drizzle<typeof schema>>;

export interface ChatWorkspaceRuntime {
  id: string;
  nodeId: string | null;
  nodeStatus: string | null;
  nodeRuntime: string | null;
}

/**
 * Resolve the workspace bridge, scoped to the owning project and user.
 * `chatSessionId` alone is never sufficient: retaining project/user predicates
 * is the defence against cross-tenant workspace control.
 */
export async function resolveLiveWorkspaceForSession(
  db: ChatDb,
  { projectId, sessionId, userId }: { projectId: string; sessionId: string; userId: string }
): Promise<ChatWorkspaceRuntime | null> {
  const [workspace] = await db
    .select({
      id: schema.workspaces.id,
      nodeId: schema.workspaces.nodeId,
      nodeStatus: schema.nodes.status,
      nodeRuntime: schema.nodes.runtime,
      userId: schema.workspaces.userId,
      projectId: schema.workspaces.projectId,
    })
    .from(schema.workspaces)
    .leftJoin(schema.nodes, eq(schema.workspaces.nodeId, schema.nodes.id))
    .where(
      and(
        eq(schema.workspaces.chatSessionId, sessionId),
        eq(schema.workspaces.projectId, projectId),
        eq(schema.workspaces.userId, userId),
        or(
          inArray(schema.workspaces.status, ['running', 'recovery', 'sleeping']),
          and(eq(schema.nodes.runtime, 'cf-container'), eq(schema.workspaces.status, 'error'))
        )
      )
    )
    .limit(1);

  if (!workspace) return null;

  if (workspace.userId !== userId || workspace.projectId !== projectId) {
    log.error('chat: workspace ownership mismatch on session bridge', {
      sessionId,
      projectId,
      userId,
      workspaceId: workspace.id,
      rowUserId: workspace.userId,
      rowProjectId: workspace.projectId,
      action: 'rejected',
    });
    return null;
  }

  return {
    id: workspace.id,
    nodeId: workspace.nodeId,
    nodeStatus: workspace.nodeStatus,
    nodeRuntime: workspace.nodeRuntime,
  };
}

/**
 * Resolve the workspace and resumable agent session for a chat action. A
 * cf-container Durable Object owns replacement classification, so recoverable
 * D1 states must reach it. Other runtimes still require a running node.
 */
export async function resolveLiveAgentSessionForChat(
  db: ChatDb,
  { projectId, sessionId, userId }: { projectId: string; sessionId: string; userId: string }
): Promise<{
  workspace: { id: string; nodeId: string; nodeStatus: string; nodeRuntime: string };
  agentSession: { id: string };
}> {
  const workspace = await resolveLiveWorkspaceForSession(db, { projectId, sessionId, userId });
  if (!workspace?.nodeId || !workspace.nodeStatus || !workspace.nodeRuntime) {
    throw errors.notFound('No active workspace found for this session');
  }

  const isContainer = workspace.nodeRuntime === 'cf-container';
  const nodeIsReachable = isContainer
    ? ['running', 'sleeping', 'recovery', 'error'].includes(workspace.nodeStatus)
    : workspace.nodeStatus === 'running';
  if (!nodeIsReachable) {
    throw errors.conflict(
      'The workspace node is no longer running. Start a new chat to create a fresh workspace.'
    );
  }

  const agentStatuses = isContainer
    ? ['running', 'sleeping', 'recovery', 'error']
    : ['running', 'sleeping'];
  const [agentSession] = await db
    .select({ id: schema.agentSessions.id })
    .from(schema.agentSessions)
    .where(
      and(
        eq(schema.agentSessions.workspaceId, workspace.id),
        eq(schema.agentSessions.userId, userId),
        inArray(schema.agentSessions.status, agentStatuses)
      )
    )
    .limit(1);

  if (!agentSession) throw errors.notFound('No running agent session found');

  return {
    workspace: {
      id: workspace.id,
      nodeId: workspace.nodeId,
      nodeStatus: workspace.nodeStatus,
      nodeRuntime: workspace.nodeRuntime,
    },
    agentSession,
  };
}
