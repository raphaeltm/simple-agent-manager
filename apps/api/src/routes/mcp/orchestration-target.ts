/**
 * Orchestration target resolution — validates authorization and resolves a
 * same-project task to its workspace, node, and running agent session.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import { log } from '../../lib/logger';
import {
  ACTIVE_STATUSES,
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  type McpTokenData,
} from './_helpers';

export interface ResolvedAgentTarget {
  task: {
    id: string;
    status: string;
    workspaceId: string | null;
    projectId: string;
    /** Stable source-task authority (recovery_source_task_id ?? id). */
    sourceTaskId: string;
  };
  /** The caller's stable source task; null when the caller row was not required. */
  callerSourceTaskId: string | null;
  workspace: {
    id: string;
    nodeId: string;
    nodeStatus: string | null;
    chatSessionId: string | null;
  };
  agentSession: {
    id: string;
  };
}

/**
 * Validate authorization and resolve task → workspace → agent session.
 *
 * Project-scoped communication is intentionally broader than destructive controls:
 * any active task agent in the caller's verified MCP-token project can message any
 * other active task agent in that same project. Destructive lifecycle controls keep
 * direct-parent authorization.
 *
 * Returns a JSON-RPC error response on failure, or the resolved child context on success.
 */
export async function resolveAgentTarget(
  requestId: string | number | null,
  targetTaskId: string,
  tokenData: McpTokenData,
  db: DrizzleD1Database<typeof schema>,
  options: {
    authorization: 'same-project-active-agent' | 'direct-child-control';
    targetLabel: string;
  }
): Promise<JsonRpcResponse | ResolvedAgentTarget> {
  // 1. Validate caller is a task agent
  if (!tokenData.taskId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'Only task agents can use orchestration tools');
  }

  // 2. Query target task in the caller's verified project. This project predicate
  // is the authorization boundary for non-destructive communication.
  const requestedTaskIds = [...new Set([tokenData.taskId, targetTaskId])];
  const taskRows = await db
    .select({
      id: schema.tasks.id,
      status: schema.tasks.status,
      workspaceId: schema.tasks.workspaceId,
      projectId: schema.tasks.projectId,
      parentTaskId: schema.tasks.parentTaskId,
      recoverySourceTaskId: schema.tasks.recoverySourceTaskId,
    })
    .from(schema.tasks)
    .where(
      and(
        inArray(schema.tasks.id, requestedTaskIds),
        eq(schema.tasks.projectId, tokenData.projectId)
      )
    );
  const targetTask = taskRows.find((task) => task.id === targetTaskId);
  const callerTask = taskRows.find((task) => task.id === tokenData.taskId);

  if (options.authorization === 'same-project-active-agent') {
    if (!callerTask) {
      return jsonRpcError(requestId, INVALID_PARAMS, 'Calling task was not found in this project');
    }
    if (!ACTIVE_STATUSES.includes(callerTask.status)) {
      return jsonRpcError(
        requestId,
        INVALID_PARAMS,
        `Calling task is in '${callerTask.status}' status — only active task agents can send messages`
      );
    }
    if (targetTaskId === tokenData.taskId) {
      return jsonRpcError(
        requestId,
        INVALID_PARAMS,
        'Target task must be another active task agent in the same project'
      );
    }
  }

  if (!targetTask) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `${options.targetLabel} not found in this project`
    );
  }

  // 3. Authorization: direct parent only for destructive lifecycle controls.
  if (
    options.authorization === 'direct-child-control' &&
    targetTask.parentTaskId !== tokenData.taskId
  ) {
    log.warn('mcp.orchestration.unauthorized_parent', {
      callerTaskId: tokenData.taskId,
      childTaskId: targetTaskId,
      actualParentTaskId: targetTask.parentTaskId,
      projectId: tokenData.projectId,
    });
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'Only the direct parent task can communicate with a child task'
    );
  }

  // 4. Verify target is in an active status
  if (!ACTIVE_STATUSES.includes(targetTask.status)) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `${options.targetLabel} is in '${targetTask.status}' status — only active tasks can receive messages`
    );
  }

  // 5. Resolve workspace. Require the workspace's own project_id to match the
  // caller project as a defence-in-depth consistency check; the task row alone is
  // not enough if stale/relaxed fixtures disagree.
  if (!targetTask.workspaceId) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `${options.targetLabel} has no workspace assigned yet (it may still be provisioning)`
    );
  }

  const [workspace] = await db
    .select({
      id: schema.workspaces.id,
      nodeId: schema.workspaces.nodeId,
      chatSessionId: schema.workspaces.chatSessionId,
      nodeStatus: schema.nodes.status,
    })
    .from(schema.workspaces)
    .leftJoin(schema.nodes, eq(schema.workspaces.nodeId, schema.nodes.id))
    .where(
      and(
        eq(schema.workspaces.id, targetTask.workspaceId),
        eq(schema.workspaces.projectId, tokenData.projectId)
      )
    )
    .limit(1);

  if (!workspace || !workspace.nodeId) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `${options.targetLabel} workspace or node not found`
    );
  }

  // Verify node is reachable — D1 nodes.status uses 'running' for healthy nodes
  // (not 'active'/'warm', which are NodeLifecycle DO states, not D1 column values)
  if (workspace.nodeStatus !== 'running') {
    log.warn('mcp.orchestration.node_not_running', {
      childTaskId: targetTaskId,
      workspaceId: targetTask.workspaceId,
      nodeId: workspace.nodeId,
      nodeStatus: workspace.nodeStatus,
    });
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `${options.targetLabel} workspace node is not running (status: ${workspace.nodeStatus ?? 'unknown'})`
    );
  }

  // 6. Resolve running agent session
  const [agentSession] = await db
    .select({ id: schema.agentSessions.id })
    .from(schema.agentSessions)
    .where(
      and(
        eq(schema.agentSessions.workspaceId, workspace.id),
        eq(schema.agentSessions.status, 'running')
      )
    )
    .orderBy(desc(schema.agentSessions.createdAt))
    .limit(1);

  if (!agentSession) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `No running agent session found for ${options.targetLabel.toLowerCase()}`
    );
  }

  return {
    task: {
      id: targetTask.id,
      status: targetTask.status,
      workspaceId: targetTask.workspaceId,
      projectId: targetTask.projectId,
      sourceTaskId: targetTask.recoverySourceTaskId ?? targetTask.id,
    },
    callerSourceTaskId: callerTask ? (callerTask.recoverySourceTaskId ?? callerTask.id) : null,
    workspace: {
      id: workspace.id,
      nodeId: workspace.nodeId,
      nodeStatus: workspace.nodeStatus,
      chatSessionId: workspace.chatSessionId,
    },
    agentSession: {
      id: agentSession.id,
    },
  };
}

/** Type guard: check if the resolution result is an error response. */
export function isError(result: JsonRpcResponse | ResolvedAgentTarget): result is JsonRpcResponse {
  return 'jsonrpc' in result;
}
