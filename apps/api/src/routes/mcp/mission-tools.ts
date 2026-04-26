/**
 * MCP Mission tool handlers — create/get missions, publish state entries & handoff packets.
 *
 * Missions metadata lives in D1 (cross-project queryable).
 * State entries and handoff packets live in ProjectData DO (per-project, high-write).
 */
import {
  DEFAULT_MISSION_DESCRIPTION_MAX_LENGTH,
  DEFAULT_MISSION_MAX_PER_PROJECT,
  DEFAULT_MISSION_TITLE_MAX_LENGTH,
  isMissionStateEntryType,
  MISSION_STATE_ENTRY_TYPES,
} from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import * as projectDataService from '../../services/project-data';
import {
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
  type McpTokenData,
  sanitizeUserInput,
} from './_helpers';

// ─── create_mission ────────────────���────────────────────────────────────────

export async function handleCreateMission(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const title = typeof params.title === 'string'
    ? sanitizeUserInput(params.title.trim()).slice(0, DEFAULT_MISSION_TITLE_MAX_LENGTH)
    : '';
  if (!title) return jsonRpcError(requestId, INVALID_PARAMS, 'title is required');

  const description = typeof params.description === 'string'
    ? sanitizeUserInput(params.description.trim()).slice(0, DEFAULT_MISSION_DESCRIPTION_MAX_LENGTH)
    : null;

  const budgetConfig = params.budgetConfig && typeof params.budgetConfig === 'object'
    ? JSON.stringify(params.budgetConfig)
    : null;

  // Enforce per-project limit
  const maxPerProject = Number(env.MISSION_MAX_PER_PROJECT) || DEFAULT_MISSION_MAX_PER_PROJECT;
  const countRow = await env.DATABASE.prepare(
    'SELECT COUNT(*) as cnt FROM missions WHERE project_id = ?',
  ).bind(tokenData.projectId).first<{ cnt: number }>();
  if (countRow && countRow.cnt >= maxPerProject) {
    return jsonRpcError(requestId, INVALID_PARAMS, `Maximum missions per project (${maxPerProject}) reached`);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DATABASE.prepare(
    `INSERT INTO missions (id, project_id, user_id, title, description, status, budget_config, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'planning', ?, ?, ?)`,
  ).bind(id, tokenData.projectId, tokenData.userId, title, description, budgetConfig, now, now).run();

  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: JSON.stringify({ id, status: 'planning', title }) }],
  });
}

// ─── get_mission ───────────────────────────────────────────��────────────────

export async function handleGetMission(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const missionId = typeof params.missionId === 'string' ? params.missionId.trim() : '';
  if (!missionId) return jsonRpcError(requestId, INVALID_PARAMS, 'missionId is required');

  const mission = await env.DATABASE.prepare(
    'SELECT * FROM missions WHERE id = ? AND project_id = ?',
  ).bind(missionId, tokenData.projectId).first();
  if (!mission) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'Mission not found');
  }

  // Get task summary for this mission
  const taskSummary = await env.DATABASE.prepare(
    `SELECT status, COUNT(*) as cnt FROM tasks WHERE mission_id = ? GROUP BY status`,
  ).bind(missionId).all();

  const tasks: Record<string, number> = {};
  for (const row of taskSummary.results ?? []) {
    const status = row.status as string;
    const count = row.cnt as number;
    tasks[status] = count;
  }

  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: JSON.stringify({
      id: mission.id,
      title: mission.title,
      description: mission.description,
      status: mission.status,
      rootTaskId: mission.root_task_id,
      budgetConfig: mission.budget_config ? JSON.parse(mission.budget_config as string) : null,
      taskSummary: tasks,
      createdAt: mission.created_at,
      updatedAt: mission.updated_at,
    }) }],
  });
}

// ─── publish_mission_state ──────────────────��───────────────────────────────

export async function handlePublishMissionState(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const missionId = typeof params.missionId === 'string' ? params.missionId.trim() : '';
  if (!missionId) return jsonRpcError(requestId, INVALID_PARAMS, 'missionId is required');

  const entryType = typeof params.entryType === 'string' ? params.entryType : '';
  if (!isMissionStateEntryType(entryType)) {
    return jsonRpcError(requestId, INVALID_PARAMS,
      `Invalid entryType. Valid: ${MISSION_STATE_ENTRY_TYPES.join(', ')}`);
  }

  const title = typeof params.title === 'string'
    ? sanitizeUserInput(params.title.trim()).slice(0, DEFAULT_MISSION_TITLE_MAX_LENGTH)
    : '';
  if (!title) return jsonRpcError(requestId, INVALID_PARAMS, 'title is required');

  const content = typeof params.content === 'string'
    ? sanitizeUserInput(params.content.trim())
    : null;

  // Verify mission belongs to this project
  const mission = await env.DATABASE.prepare(
    'SELECT id FROM missions WHERE id = ? AND project_id = ?',
  ).bind(missionId, tokenData.projectId).first();
  if (!mission) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'Mission not found in this project');
  }

  const result = await projectDataService.createMissionStateEntry(
    env, tokenData.projectId, missionId, entryType,
    title, content, tokenData.taskId,
  );

  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: JSON.stringify({ id: result.id, entryType, title }) }],
  });
}

// ─── get_mission_state ──────────────────────────────────────────────────────

export async function handleGetMissionState(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const missionId = typeof params.missionId === 'string' ? params.missionId.trim() : '';
  if (!missionId) return jsonRpcError(requestId, INVALID_PARAMS, 'missionId is required');

  const entryType = typeof params.entryType === 'string' ? params.entryType : null;
  if (entryType && !isMissionStateEntryType(entryType)) {
    return jsonRpcError(requestId, INVALID_PARAMS,
      `Invalid entryType. Valid: ${MISSION_STATE_ENTRY_TYPES.join(', ')}`);
  }

  // Verify mission belongs to this project
  const mission = await env.DATABASE.prepare(
    'SELECT id FROM missions WHERE id = ? AND project_id = ?',
  ).bind(missionId, tokenData.projectId).first();
  if (!mission) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'Mission not found in this project');
  }

  const entries = await projectDataService.getMissionStateEntries(
    env, tokenData.projectId, missionId, entryType,
  );

  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: JSON.stringify({ missionId, entries }) }],
  });
}

// ─── publish_handoff ────────────────────────────────────────────────────────

export async function handlePublishHandoff(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const missionId = typeof params.missionId === 'string' ? params.missionId.trim() : '';
  if (!missionId) return jsonRpcError(requestId, INVALID_PARAMS, 'missionId is required');

  const summary = typeof params.summary === 'string'
    ? sanitizeUserInput(params.summary.trim())
    : '';
  if (!summary) return jsonRpcError(requestId, INVALID_PARAMS, 'summary is required');

  const toTaskId = typeof params.toTaskId === 'string' ? params.toTaskId.trim() : null;
  const facts = Array.isArray(params.facts) ? params.facts : [];
  const openQuestions = Array.isArray(params.openQuestions)
    ? params.openQuestions.filter((q): q is string => typeof q === 'string')
    : [];
  const artifactRefs = Array.isArray(params.artifactRefs) ? params.artifactRefs : [];
  const suggestedActions = Array.isArray(params.suggestedActions)
    ? params.suggestedActions.filter((a): a is string => typeof a === 'string')
    : [];

  // Verify mission belongs to this project
  const mission = await env.DATABASE.prepare(
    'SELECT id FROM missions WHERE id = ? AND project_id = ?',
  ).bind(missionId, tokenData.projectId).first();
  if (!mission) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'Mission not found in this project');
  }

  const result = await projectDataService.createHandoffPacket(
    env, tokenData.projectId, missionId, tokenData.taskId, toTaskId,
    summary, facts, openQuestions, artifactRefs, suggestedActions,
  );

  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: JSON.stringify({ id: result.id, missionId, fromTaskId: tokenData.taskId }) }],
  });
}

// ─── get_handoff ────────────────────────────────────────────��───────────────

export async function handleGetHandoff(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const missionId = typeof params.missionId === 'string' ? params.missionId.trim() : '';
  if (!missionId) return jsonRpcError(requestId, INVALID_PARAMS, 'missionId is required');

  // Verify mission belongs to this project
  const mission = await env.DATABASE.prepare(
    'SELECT id FROM missions WHERE id = ? AND project_id = ?',
  ).bind(missionId, tokenData.projectId).first();
  if (!mission) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'Mission not found in this project');
  }

  const packets = await projectDataService.getHandoffPackets(env, tokenData.projectId, missionId);

  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: JSON.stringify({ missionId, handoffs: packets }) }],
  });
}
