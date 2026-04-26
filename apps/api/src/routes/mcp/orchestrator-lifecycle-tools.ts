/**
 * MCP Orchestrator lifecycle tool handlers — status, pause, resume, cancel, override.
 */
import type { SchedulerState } from '@simple-agent-manager/shared';
import { OVERRIDABLE_SCHEDULER_STATES } from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import * as orchestratorService from '../../services/project-orchestrator';
import {
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
  type McpTokenData,
  sanitizeUserInput,
} from './_helpers';

// ─── get_orchestrator_status ─────────────────────────────────────────────────

export async function handleGetOrchestratorStatus(
  requestId: string | number | null,
  _params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const status = await orchestratorService.getOrchestratorStatus(env, tokenData.projectId);
  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: JSON.stringify(status) }],
  });
}

// ─── get_scheduling_queue ────────────────────────────────────────────────────

export async function handleGetSchedulingQueue(
  requestId: string | number | null,
  _params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const queue = await orchestratorService.getSchedulingQueue(env, tokenData.projectId);
  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: JSON.stringify({ queue }) }],
  });
}

// ─── pause_mission ───────────────────────────────────────────────────────────

export async function handlePauseMission(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const missionId = typeof params.missionId === 'string' ? params.missionId.trim() : '';
  if (!missionId) return jsonRpcError(requestId, INVALID_PARAMS, 'missionId is required');

  const ok = await orchestratorService.pauseMission(env, tokenData.projectId, missionId);
  if (!ok) return jsonRpcError(requestId, INVALID_PARAMS, 'Mission not found or not active');

  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: JSON.stringify({ success: true, missionId, status: 'paused' }) }],
  });
}

// ─── resume_mission ──────────────────────────────────────────────────────────

export async function handleResumeMission(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const missionId = typeof params.missionId === 'string' ? params.missionId.trim() : '';
  if (!missionId) return jsonRpcError(requestId, INVALID_PARAMS, 'missionId is required');

  const ok = await orchestratorService.resumeMission(env, tokenData.projectId, missionId);
  if (!ok) return jsonRpcError(requestId, INVALID_PARAMS, 'Mission not found or not paused');

  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: JSON.stringify({ success: true, missionId, status: 'active' }) }],
  });
}

// ─── cancel_mission ──────────────────────────────────────────────────────────

export async function handleCancelMission(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const missionId = typeof params.missionId === 'string' ? params.missionId.trim() : '';
  if (!missionId) return jsonRpcError(requestId, INVALID_PARAMS, 'missionId is required');

  const ok = await orchestratorService.cancelMission(env, tokenData.projectId, missionId);
  if (!ok) return jsonRpcError(requestId, INVALID_PARAMS, 'Mission not found');

  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: JSON.stringify({ success: true, missionId, status: 'cancelled' }) }],
  });
}

// ─── override_task_state ─────────────────────────────────────────────────────

export async function handleOverrideTaskState(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const missionId = typeof params.missionId === 'string' ? params.missionId.trim() : '';
  const taskId = typeof params.taskId === 'string' ? params.taskId.trim() : '';
  const newState = typeof params.newState === 'string' ? params.newState.trim() : '';
  const reason = typeof params.reason === 'string' ? sanitizeUserInput(params.reason.trim()) : '';

  if (!missionId) return jsonRpcError(requestId, INVALID_PARAMS, 'missionId is required');
  if (!taskId) return jsonRpcError(requestId, INVALID_PARAMS, 'taskId is required');
  if (!newState) return jsonRpcError(requestId, INVALID_PARAMS, 'newState is required');
  if (!reason) return jsonRpcError(requestId, INVALID_PARAMS, 'reason is required');

  if (!OVERRIDABLE_SCHEDULER_STATES.includes(newState as SchedulerState)) {
    return jsonRpcError(requestId, INVALID_PARAMS,
      `Invalid state: ${newState}. Must be one of: ${OVERRIDABLE_SCHEDULER_STATES.join(', ')}`);
  }

  const ok = await orchestratorService.overrideTaskState(
    env, tokenData.projectId, missionId, taskId, newState as SchedulerState, reason,
  );
  if (!ok) return jsonRpcError(requestId, INVALID_PARAMS, 'Task not found');

  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: JSON.stringify({ success: true, taskId, newState }) }],
  });
}
