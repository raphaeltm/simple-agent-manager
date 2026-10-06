import { and, desc, eq } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { stopAgentSessionOnNode } from '../../services/node-agent';
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  type McpTokenData,
} from './_helpers';

export async function stopActiveChildAgentForRetry(
  requestId: string | number | null,
  childTask: typeof schema.tasks.$inferSelect,
  tokenData: McpTokenData,
  env: Env,
  db: DrizzleD1Database<typeof schema>
): Promise<{ chatSessionId: string | null } | JsonRpcResponse> {
  if (!childTask.workspaceId) {
    return { chatSessionId: null };
  }

  const [agentSession] = await db
    .select({ id: schema.agentSessions.id })
    .from(schema.agentSessions)
    .where(
      and(
        eq(schema.agentSessions.workspaceId, childTask.workspaceId),
        eq(schema.agentSessions.status, 'running')
      )
    )
    .orderBy(desc(schema.agentSessions.createdAt))
    .limit(1);

  if (!agentSession) {
    return { chatSessionId: null };
  }

  const [workspace] = await db
    .select({
      id: schema.workspaces.id,
      nodeId: schema.workspaces.nodeId,
      nodeStatus: schema.nodes.status,
      chatSessionId: schema.workspaces.chatSessionId,
    })
    .from(schema.workspaces)
    .leftJoin(schema.nodes, eq(schema.workspaces.nodeId, schema.nodes.id))
    .where(eq(schema.workspaces.id, childTask.workspaceId))
    .limit(1);

  if (!workspace?.nodeId) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'Cannot retry active child task because its workspace or node was not found'
    );
  }

  if (workspace.nodeStatus !== 'running') {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `Cannot retry active child task because its node is not running (status: ${workspace.nodeStatus ?? 'unknown'})`
    );
  }

  try {
    await stopAgentSessionOnNode(
      workspace.nodeId,
      workspace.id,
      agentSession.id,
      env,
      tokenData.userId
    );
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log.error('orchestration.retry_stop_agent_failed', {
      childTaskId: childTask.id,
      workspaceId: workspace.id,
      nodeId: workspace.nodeId,
      agentSessionId: agentSession.id,
      error: errorMsg,
    });
    return jsonRpcError(
      requestId,
      INTERNAL_ERROR,
      `Failed to stop active child agent before retry: ${errorMsg}`
    );
  }

  const now = new Date().toISOString();
  await db
    .update(schema.agentSessions)
    .set({
      status: 'stopped',
      stoppedAt: now,
      errorMessage: null,
      updatedAt: now,
    })
    .where(eq(schema.agentSessions.id, agentSession.id));

  return { chatSessionId: workspace.chatSessionId ?? null };
}
