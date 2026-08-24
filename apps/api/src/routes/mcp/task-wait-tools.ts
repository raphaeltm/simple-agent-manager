import { TASK_TERMINAL_STATUSES } from '@simple-agent-manager/shared';

import { resolveDurableExecutionConfig } from '../../durable-objects/project-data/durable-execution-config';
import { resolveTaskWaitConfig } from '../../durable-objects/project-data/task-wait-config';
import type { Env } from '../../env';
import * as projectDataService from '../../services/project-data';
import {
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
  type McpTokenData,
} from './_helpers';

interface TaskLineageRow {
  id: string;
  status: string;
  parent_task_id: string | null;
  chat_session_id: string | null;
}

const WAIT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function textResult(requestId: string | number | null, payload: Record<string, unknown>) {
  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  });
}

export async function handleWaitForSubtasks(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  if (!tokenData.taskId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'Only task agents can wait for subtasks');
  }
  const deliveryConfig = resolveDurableExecutionConfig(env);
  if (!deliveryConfig.deliveryEnabled) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'Durable parent wake delivery is disabled; use bounded foreground polling instead'
    );
  }
  const waitConfig = resolveTaskWaitConfig(env);
  const waitKey = typeof params.waitKey === 'string' ? params.waitKey.trim() : '';
  if (!WAIT_KEY_PATTERN.test(waitKey)) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'waitKey must be a stable 1-128 character workflow-step identifier'
    );
  }
  if (!Array.isArray(params.taskIds)) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'taskIds must be a non-empty array');
  }
  const taskIds = [
    ...new Set(
      params.taskIds
        .filter((taskId): taskId is string => typeof taskId === 'string')
        .map((taskId) => taskId.trim())
        .filter(Boolean)
    ),
  ];
  if (taskIds.length === 0 || taskIds.length !== params.taskIds.length) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'taskIds must contain unique, non-empty task ID strings'
    );
  }
  if (taskIds.length > waitConfig.maxChildren) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `taskIds exceeds the configured child limit (${waitConfig.maxChildren})`
    );
  }
  const condition = params.condition ?? 'all';
  if (condition !== 'all' && condition !== 'any') {
    return jsonRpcError(requestId, INVALID_PARAMS, 'condition must be "all" or "any"');
  }
  let waitDurationMs = waitConfig.maxDurationMs;
  if (params.wakeAfterSeconds !== undefined) {
    if (
      typeof params.wakeAfterSeconds !== 'number' ||
      !Number.isSafeInteger(params.wakeAfterSeconds) ||
      params.wakeAfterSeconds <= 0
    ) {
      return jsonRpcError(requestId, INVALID_PARAMS, 'wakeAfterSeconds must be a positive integer');
    }
    waitDurationMs = params.wakeAfterSeconds * 1000;
    if (!Number.isSafeInteger(waitDurationMs) || waitDurationMs > waitConfig.maxDurationMs) {
      return jsonRpcError(
        requestId,
        INVALID_PARAMS,
        `wakeAfterSeconds exceeds the configured maximum (${Math.floor(waitConfig.maxDurationMs / 1000)})`
      );
    }
  }

  const ids = [tokenData.taskId, ...taskIds];
  const placeholders = ids.map(() => '?').join(', ');
  const lineage = await env.DATABASE.prepare(
    `SELECT id, status, parent_task_id, chat_session_id
		 FROM tasks
		 WHERE project_id = ? AND id IN (${placeholders})`
  )
    .bind(tokenData.projectId, ...ids)
    .all<TaskLineageRow>();
  const rows = new Map((lineage.results ?? []).map((row) => [row.id, row]));
  const parent = rows.get(tokenData.taskId);
  if (!parent) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'Calling task was not found in this project');
  }
  if ((TASK_TERMINAL_STATUSES as readonly string[]).includes(parent.status)) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'A terminal parent task cannot start a wait');
  }
  for (const childTaskId of taskIds) {
    const child = rows.get(childTaskId);
    if (!child) {
      return jsonRpcError(
        requestId,
        INVALID_PARAMS,
        `Child task ${childTaskId} was not found in this project`
      );
    }
    if (child.parent_task_id !== tokenData.taskId) {
      return jsonRpcError(
        requestId,
        INVALID_PARAMS,
        `Task ${childTaskId} is not a direct child of the calling task`
      );
    }
  }
  const parentSessionId = parent.chat_session_id;
  if (!parentSessionId) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'Calling task has no durable chat session to wake'
    );
  }
  if (tokenData.chatSessionId && tokenData.chatSessionId !== parentSessionId) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'Calling token session does not match the parent task durable session'
    );
  }

  const now = Date.now();
  const registered = await projectDataService.registerTaskWait(env, tokenData.projectId, {
    parentTaskId: tokenData.taskId,
    parentSessionId,
    idempotencyKey: waitKey,
    condition,
    childTaskIds: taskIds,
    wakeDeadline: now + waitDurationMs,
  });
  if (!registered.subscription) {
    throw new Error('Task wait registration returned no durable subscription');
  }
  return textResult(requestId, {
    registered: true,
    created: registered.created,
    waitId: registered.subscription.id,
    waitKey: registered.subscription.idempotencyKey,
    state: registered.subscription.state,
    condition: registered.subscription.condition,
    taskIds: registered.subscription.children.map(
      (child: { childTaskId: string }) => child.childTaskId
    ),
    wakeDeadline: new Date(registered.subscription.wakeDeadline).toISOString(),
    instruction:
      'Persist your workflow state, then end this turn immediately. SAM will durably wake this session when the wait resolves; do not poll in the background.',
  });
}
