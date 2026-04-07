/**
 * Orchestration tools — MCP tools for parent agents to monitor and inspect child tasks.
 *
 * These tools require a task-scoped MCP token and enforce parent-child authorization.
 */
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../index';
import { parsePositiveInt } from '../../lib/route-helpers';
import * as projectDataService from '../../services/project-data';
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
  type McpTokenData,
} from './_helpers';

// ─── Configurable defaults (Constitution Principle XI) ──────────────────────

/** Max chars of task description to return in subtask summary. Override via ORCHESTRATOR_SUMMARY_DESCRIPTION_MAX_LENGTH. */
const DEFAULT_SUMMARY_DESCRIPTION_MAX_LENGTH = 500;

// ─── get_subtask_summary ────────────────────────────────────────────────────

export async function handleGetSubtaskSummary(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  if (!tokenData.taskId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'This tool requires a task-scoped MCP token');
  }

  const childTaskId = params.taskId;
  if (typeof childTaskId !== 'string' || !childTaskId.trim()) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'taskId is required');
  }

  try {
    const db = drizzle(env.DATABASE, { schema });

    // Query the child task
    const [childTask] = await db
      .select({
        id: schema.tasks.id,
        title: schema.tasks.title,
        status: schema.tasks.status,
        description: schema.tasks.description,
        outputSummary: schema.tasks.outputSummary,
        outputBranch: schema.tasks.outputBranch,
        completedAt: schema.tasks.completedAt,
        errorMessage: schema.tasks.errorMessage,
        executionStep: schema.tasks.executionStep,
        parentTaskId: schema.tasks.parentTaskId,
      })
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.id, childTaskId),
          eq(schema.tasks.projectId, tokenData.projectId),
        ),
      )
      .limit(1);

    if (!childTask) {
      return jsonRpcError(requestId, INVALID_PARAMS, `Task ${childTaskId} not found in this project`);
    }

    // Authorization: only direct parent may call this tool
    if (childTask.parentTaskId !== tokenData.taskId) {
      return jsonRpcError(
        requestId,
        INVALID_PARAMS,
        `Access denied: you are not the parent of task ${childTaskId}`,
      );
    }

    // Get session message count from the ProjectData DO (best-effort)
    let sessionMessageCount: number | null = null;
    try {
      const sessions = await projectDataService.getSessionsByTaskIds(
        env,
        tokenData.projectId,
        [childTaskId],
      );
      if (sessions.length > 0) {
        const first = sessions[0];
        if (first) {
          sessionMessageCount = (first.messageCount as number) ?? null;
        }
      }
    } catch {
      // Best-effort — DO may be unavailable
    }

    const descMaxLen = parsePositiveInt(
      env.ORCHESTRATOR_SUMMARY_DESCRIPTION_MAX_LENGTH,
      DEFAULT_SUMMARY_DESCRIPTION_MAX_LENGTH,
    );

    return jsonRpcSuccess(requestId, {
      content: [{
        type: 'text',
        text: JSON.stringify({
          id: childTask.id,
          title: childTask.title,
          status: childTask.status,
          outputSummary: childTask.outputSummary,
          outputBranch: childTask.outputBranch,
          completedAt: childTask.completedAt,
          errorMessage: childTask.errorMessage,
          executionStep: childTask.executionStep,
          description: childTask.description?.slice(0, descMaxLen) ?? null,
          sessionMessageCount,
        }, null, 2),
      }],
    });
  } catch (e) {
    return jsonRpcError(
      requestId,
      INTERNAL_ERROR,
      `Failed to get subtask summary: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
