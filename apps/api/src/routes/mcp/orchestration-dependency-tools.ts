/**
 * MCP orchestration dependency tools — task dependency management and removal
 * of pending child tasks.
 *
 * Split out of `orchestration-tools.ts`, which exceeded the 800-line ceiling in
 * `.claude/rules/18-file-size-limits.md`. That module keeps `retry_subtask` (the
 * placement/credential-heavy path) and re-exports these two so no importer had
 * to change.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { ulid } from '../../lib/ulid';
import { syncTriggerExecutionStatus } from '../../services/trigger-execution-sync';
import {
  ACTIVE_STATUSES,
  getMcpLimits,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
  type McpTokenData,
} from './_helpers';

// ─── add_dependency ─────────────────────────────────────────────────────────

export async function handleAddDependency(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  const limits = getMcpLimits(env);
  const db = drizzle(env.DATABASE, { schema });

  // Validate params
  const taskId = typeof params.taskId === 'string' ? params.taskId.trim() : '';
  const dependsOnTaskId =
    typeof params.dependsOnTaskId === 'string' ? params.dependsOnTaskId.trim() : '';

  if (!taskId || !dependsOnTaskId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'taskId and dependsOnTaskId are required');
  }

  if (taskId === dependsOnTaskId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'A task cannot depend on itself');
  }

  // Verify both tasks belong to the same project
  const tasks = await db
    .select({
      id: schema.tasks.id,
      projectId: schema.tasks.projectId,
      parentTaskId: schema.tasks.parentTaskId,
    })
    .from(schema.tasks)
    .where(
      and(
        inArray(schema.tasks.id, [taskId, dependsOnTaskId]),
        eq(schema.tasks.projectId, tokenData.projectId)
      )
    );

  if (tasks.length !== 2) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'One or both tasks not found in this project');
  }

  // Authorization: caller must be parent of both tasks, or caller is a sibling
  const taskA = tasks.find((t) => t.id === taskId);
  const taskB = tasks.find((t) => t.id === dependsOnTaskId);
  if (!taskA || !taskB) {
    // tasks.length === 2 with an inArray([taskId, dependsOnTaskId]) filter and
    // distinct ids (checked above) guarantees both are present — this should
    // never happen.
    return jsonRpcError(
      requestId,
      INTERNAL_ERROR,
      'Task lookup mismatch while checking dependency'
    );
  }

  const callerIsParentOfBoth =
    taskA.parentTaskId === tokenData.taskId && taskB.parentTaskId === tokenData.taskId;

  // Allow if caller IS the dependent task (taskId) and both share the same parent.
  // Restricting to taskId only prevents a task from declaring itself as a blocker
  // for siblings — a task can only add dependencies on itself, not block others.
  const callerIsSibling =
    tokenData.taskId === taskId &&
    taskA.parentTaskId != null &&
    taskA.parentTaskId === taskB.parentTaskId;

  if (!callerIsParentOfBoth && !callerIsSibling) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'Caller must be the parent of both tasks, or both tasks must be siblings under the caller'
    );
  }

  // Check max edges for the project — use raw SQL for cross-table join
  const projectEdgeCount = await env.DATABASE.prepare(
    `SELECT count(*) as count FROM task_dependencies td
     JOIN tasks t ON td.task_id = t.id
     WHERE t.project_id = ?`
  )
    .bind(tokenData.projectId)
    .first<{ count: number }>();

  if ((projectEdgeCount?.count ?? 0) >= limits.orchestratorDependencyMaxEdges) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `Dependency edge limit reached (${projectEdgeCount?.count}/${limits.orchestratorDependencyMaxEdges}). ` +
        'Cannot add more dependency edges to this project.'
    );
  }

  // Cycle detection: pre-fetch all project edges, then BFS in memory
  // This avoids N+1 queries — one query gets all edges for the project
  const allEdges = await db
    .select({
      fromTask: schema.taskDependencies.taskId,
      toTask: schema.taskDependencies.dependsOnTaskId,
    })
    .from(schema.taskDependencies)
    .innerJoin(schema.tasks, eq(schema.taskDependencies.taskId, schema.tasks.id))
    .where(eq(schema.tasks.projectId, tokenData.projectId));

  // Build adjacency list: taskId -> [dependsOnTaskIds]
  const adjacency = new Map<string, string[]>();
  for (const edge of allEdges) {
    const existing = adjacency.get(edge.fromTask);
    if (existing) {
      existing.push(edge.toTask);
    } else {
      adjacency.set(edge.fromTask, [edge.toTask]);
    }
  }

  // BFS from dependsOnTaskId — if we can reach taskId, adding this edge creates a cycle
  // Hard cap on iterations to prevent runaway memory/CPU in misconfigured environments
  const MAX_BFS_ITERATIONS = 500;
  const visited = new Set<string>();
  const queue = [dependsOnTaskId];
  let bfsIterations = 0;

  while (queue.length > 0) {
    if (++bfsIterations > MAX_BFS_ITERATIONS) {
      return jsonRpcError(
        requestId,
        INTERNAL_ERROR,
        'Dependency graph too complex for cycle check'
      );
    }
    const current = queue.shift();
    if (current === undefined) {
      // queue.length > 0 was just checked above, so this should never happen.
      continue;
    }
    if (current === taskId) {
      return jsonRpcError(
        requestId,
        INVALID_PARAMS,
        'Adding this dependency would create a cycle in the task graph'
      );
    }
    if (visited.has(current)) continue;
    visited.add(current);

    const deps = adjacency.get(current) ?? [];
    for (const dep of deps) {
      if (!visited.has(dep)) {
        queue.push(dep);
      }
    }
  }

  // Insert the dependency edge
  try {
    await db.insert(schema.taskDependencies).values({
      taskId,
      dependsOnTaskId,
      createdBy: tokenData.userId,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    // Primary key violation means the edge already exists
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (errorMsg.includes('UNIQUE') || errorMsg.includes('PRIMARY KEY')) {
      return jsonRpcSuccess(requestId, {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              added: true,
              message: 'Dependency already exists (idempotent)',
            }),
          },
        ],
      });
    }
    throw err;
  }

  log.info('orchestration.add_dependency.success', {
    taskId,
    dependsOnTaskId,
    projectId: tokenData.projectId,
    addedBy: tokenData.taskId,
  });

  return jsonRpcSuccess(requestId, {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ added: true }),
      },
    ],
  });
}

// ─── remove_pending_subtask ─────────────────────────────────────────────────

export async function handleRemovePendingSubtask(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  const db = drizzle(env.DATABASE, { schema });

  // Validate taskId param
  const childTaskId = typeof params.taskId === 'string' ? params.taskId.trim() : '';
  if (!childTaskId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'taskId is required');
  }

  // Fetch the child task
  const [childTask] = await db
    .select({
      id: schema.tasks.id,
      parentTaskId: schema.tasks.parentTaskId,
      status: schema.tasks.status,
      projectId: schema.tasks.projectId,
    })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.id, childTaskId), eq(schema.tasks.projectId, tokenData.projectId)))
    .limit(1);

  if (!childTask) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'Task not found in this project');
  }

  // Authorization: caller must be direct parent
  if (childTask.parentTaskId !== tokenData.taskId) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'Only the direct parent task can remove a pending subtask'
    );
  }

  // Only queued tasks can be removed — running tasks must use retry_subtask
  if (childTask.status !== 'queued') {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `Cannot remove task in '${childTask.status}' status. Only 'queued' tasks can be removed. ` +
        (ACTIVE_STATUSES.includes(childTask.status)
          ? 'Use retry_subtask to stop and retry running tasks.'
          : 'Task has already completed.')
    );
  }

  const now = new Date().toISOString();

  // Cancel the task
  await db
    .update(schema.tasks)
    .set({
      status: 'cancelled',
      completedAt: now,
      updatedAt: now,
    })
    .where(eq(schema.tasks.id, childTaskId));

  // Sync trigger execution status (best-effort) — without this, cron triggers
  // with skipIfRunning=true permanently stop firing because the execution stays 'running'.
  await syncTriggerExecutionStatus(env.DATABASE, childTaskId, 'cancelled');

  // Record status event
  await db.insert(schema.taskStatusEvents).values({
    id: ulid(),
    taskId: childTaskId,
    fromStatus: 'queued',
    toStatus: 'cancelled',
    actorType: 'agent',
    actorId: tokenData.workspaceId,
    reason: `Removed by parent task ${tokenData.taskId}`,
    createdAt: now,
  });

  // Clean up dependency edges
  await env.DATABASE.prepare(
    'DELETE FROM task_dependencies WHERE task_id = ? OR depends_on_task_id = ?'
  )
    .bind(childTaskId, childTaskId)
    .run();

  log.info('orchestration.remove_pending_subtask.success', {
    taskId: childTaskId,
    parentTaskId: tokenData.taskId,
    projectId: tokenData.projectId,
  });

  return jsonRpcSuccess(requestId, {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ removed: true, taskId: childTaskId }),
      },
    ],
  });
}
