import { DEFAULT_TRIGGER_DEFAULT_MAX_CONCURRENT } from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { cronToHumanReadable } from '../../services/cron-utils';
import { INVALID_PARAMS, jsonRpcError, type JsonRpcResponse, type McpTokenData } from './_helpers';

export interface TriggerDbRow {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  status: string;
  source_type: string;
  cron_expression: string | null;
  cron_timezone: string | null;
  skip_if_running: number | boolean;
  prompt_template: string;
  agent_profile_id: string | null;
  skill_id: string | null;
  task_mode: string | null;
  vm_size_override: string | null;
  max_concurrent: number | null;
  next_fire_at: string | null;
  created_at: string;
  updated_at: string;
}

function normalizeBoolean(
  value: number | boolean | null | undefined,
  defaultValue: boolean
): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return defaultValue;
}

export function triggerResponse(row: TriggerDbRow, cronHumanReadable?: string) {
  return {
    triggerId: row.id,
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    sourceType: row.source_type,
    cronExpression: row.cron_expression,
    cronTimezone: row.cron_timezone ?? 'UTC',
    skipIfRunning: normalizeBoolean(row.skip_if_running, true),
    promptTemplate: row.prompt_template,
    agentProfileId: row.agent_profile_id,
    skillId: row.skill_id,
    taskMode: row.task_mode ?? 'task',
    vmSizeOverride: row.vm_size_override,
    maxConcurrent: row.max_concurrent ?? DEFAULT_TRIGGER_DEFAULT_MAX_CONCURRENT,
    nextFireAt: row.next_fire_at,
    cronHumanReadable:
      cronHumanReadable ??
      (row.cron_expression
        ? cronToHumanReadable(row.cron_expression, row.cron_timezone ?? 'UTC')
        : undefined),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getTriggerById(env: Env, triggerId: string): Promise<TriggerDbRow | null> {
  return env.DATABASE.prepare(
    `SELECT id, project_id, name, description, status, source_type, cron_expression,
      cron_timezone, skip_if_running, prompt_template, agent_profile_id, skill_id,
      task_mode, vm_size_override, max_concurrent, next_fire_at, created_at, updated_at
     FROM triggers
     WHERE id = ?
     LIMIT 1`
  )
    .bind(triggerId)
    .first<TriggerDbRow>();
}

function validateTriggerOwnership(
  requestId: string | number | null,
  trigger: TriggerDbRow | null,
  triggerId: string,
  tokenData: McpTokenData,
  action: 'update' | 'delete'
): JsonRpcResponse | null {
  if (!trigger) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'Trigger not found in this project');
  }

  if (trigger.project_id !== tokenData.projectId) {
    log.warn(`mcp.${action}_trigger_project_mismatch`, {
      triggerId,
      expectedProjectId: trigger.project_id,
      receivedProjectId: tokenData.projectId,
      callerProjectId: tokenData.projectId,
      action: 'rejected',
    });
    return jsonRpcError(requestId, INVALID_PARAMS, 'Trigger not found in this project');
  }

  return null;
}

type OwnedTriggerResult =
  | { ok: true; triggerId: string; trigger: TriggerDbRow }
  | { ok: false; response: JsonRpcResponse };

export async function resolveOwnedTrigger(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
  action: 'update' | 'delete'
): Promise<OwnedTriggerResult> {
  const triggerId = typeof params.triggerId === 'string' ? params.triggerId.trim() : '';
  if (!triggerId) {
    return {
      ok: false,
      response: jsonRpcError(
        requestId,
        INVALID_PARAMS,
        'triggerId is required and must be a non-empty string'
      ),
    };
  }

  const trigger = await getTriggerById(env, triggerId);
  const ownershipError = validateTriggerOwnership(requestId, trigger, triggerId, tokenData, action);
  if (ownershipError) return { ok: false, response: ownershipError };

  return { ok: true, triggerId, trigger: trigger as TriggerDbRow };
}
