/**
 * MCP trigger management tool — update_trigger.
 * Create/delete live in focused modules and are re-exported for compatibility.
 */
import {
  DEFAULT_CRON_MIN_INTERVAL_MINUTES,
  DEFAULT_CRON_TEMPLATE_MAX_LENGTH,
  DEFAULT_TRIGGER_MAX_CONCURRENT_LIMIT,
  DEFAULT_TRIGGER_NAME_MAX_LENGTH,
} from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { parsePositiveInt } from '../../lib/route-helpers';
import {
  cronToHumanReadable,
  cronToNextFire,
  validateCronExpression,
} from '../../services/cron-utils';
import {
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
  type McpTokenData,
  sanitizeUserInput,
} from './_helpers';
import { resolveOwnedTrigger, type TriggerDbRow, triggerResponse } from './trigger-tool-shared';

const VALID_TRIGGER_STATUSES = new Set(['active', 'paused', 'disabled']);
const VALID_TASK_MODES = new Set(['task', 'conversation']);
const VALID_VM_SIZES = new Set(['small', 'medium', 'large']);

export async function handleUpdateTrigger(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  const ownedTrigger = await resolveOwnedTrigger(requestId, params, tokenData, env, 'update');
  if (!ownedTrigger.ok) return ownedTrigger.response;
  const { triggerId, trigger: existingTrigger } = ownedTrigger;
  const updates: string[] = ['updated_at = ?'];
  const values: unknown[] = [new Date().toISOString()];
  const bodyFields = Object.keys(params).filter((key) => key !== 'triggerId');

  if (params.name !== undefined) {
    const maxNameLength = parsePositiveInt(
      env.TRIGGER_NAME_MAX_LENGTH,
      DEFAULT_TRIGGER_NAME_MAX_LENGTH
    );
    if (typeof params.name !== 'string') {
      return jsonRpcError(requestId, INVALID_PARAMS, 'name must be a string');
    }
    const name = sanitizeUserInput(params.name.trim());
    if (!name) {
      return jsonRpcError(requestId, INVALID_PARAMS, 'name cannot be empty');
    }
    if (name.length > maxNameLength) {
      return jsonRpcError(
        requestId,
        INVALID_PARAMS,
        `name must be ${maxNameLength} characters or less`
      );
    }
    if (name !== existingTrigger.name) {
      const existingName = await env.DATABASE.prepare(
        'SELECT id FROM triggers WHERE project_id = ? AND name = ? AND id != ? LIMIT 1'
      )
        .bind(tokenData.projectId, name, triggerId)
        .first<{ id: string }>();
      if (existingName) {
        return jsonRpcError(
          requestId,
          INVALID_PARAMS,
          `Trigger "${name}" already exists in this project`
        );
      }
    }
    updates.push('name = ?');
    values.push(name);
  }

  if (params.description !== undefined) {
    if (params.description !== null && typeof params.description !== 'string') {
      return jsonRpcError(requestId, INVALID_PARAMS, 'description must be a string or null');
    }
    updates.push('description = ?');
    values.push(params.description === null ? null : sanitizeUserInput(params.description.trim()));
  }

  if (params.skipIfRunning !== undefined) {
    if (typeof params.skipIfRunning !== 'boolean') {
      return jsonRpcError(requestId, INVALID_PARAMS, 'skipIfRunning must be a boolean');
    }
    updates.push('skip_if_running = ?');
    values.push(params.skipIfRunning ? 1 : 0);
  }

  if (params.agentProfileId !== undefined) {
    if (params.agentProfileId !== null && typeof params.agentProfileId !== 'string') {
      return jsonRpcError(requestId, INVALID_PARAMS, 'agentProfileId must be a string or null');
    }
    const agentProfileId =
      typeof params.agentProfileId === 'string' ? params.agentProfileId.trim() : null;
    if (agentProfileId) {
      const profile = await env.DATABASE.prepare(
        'SELECT id FROM agent_profiles WHERE id = ? AND project_id = ? LIMIT 1'
      )
        .bind(agentProfileId, tokenData.projectId)
        .first<{ id: string }>();
      if (!profile) {
        return jsonRpcError(requestId, INVALID_PARAMS, 'agentProfileId not found in this project');
      }
    }
    updates.push('agent_profile_id = ?');
    values.push(agentProfileId);
  }

  if (params.skillId !== undefined) {
    if (params.skillId !== null && typeof params.skillId !== 'string') {
      return jsonRpcError(requestId, INVALID_PARAMS, 'skillId must be a string or null');
    }
    const skillId = typeof params.skillId === 'string' ? params.skillId.trim() : null;
    if (skillId) {
      const skill = await env.DATABASE.prepare(
        'SELECT id FROM skills WHERE id = ? AND project_id = ? LIMIT 1'
      )
        .bind(skillId, tokenData.projectId)
        .first<{ id: string }>();
      if (!skill) {
        return jsonRpcError(requestId, INVALID_PARAMS, 'skillId not found in this project');
      }
    }
    updates.push('skill_id = ?');
    values.push(skillId);
  }

  if (params.taskMode !== undefined) {
    if (typeof params.taskMode !== 'string' || !VALID_TASK_MODES.has(params.taskMode)) {
      return jsonRpcError(requestId, INVALID_PARAMS, 'taskMode must be "task" or "conversation"');
    }
    updates.push('task_mode = ?');
    values.push(params.taskMode);
  }

  if (params.vmSizeOverride !== undefined) {
    if (
      params.vmSizeOverride !== null &&
      (typeof params.vmSizeOverride !== 'string' || !VALID_VM_SIZES.has(params.vmSizeOverride))
    ) {
      return jsonRpcError(
        requestId,
        INVALID_PARAMS,
        'vmSizeOverride must be "small", "medium", "large", or null'
      );
    }
    updates.push('vm_size_override = ?');
    values.push(params.vmSizeOverride);
  }

  if (params.maxConcurrent !== undefined) {
    if (typeof params.maxConcurrent !== 'number' || !Number.isInteger(params.maxConcurrent)) {
      return jsonRpcError(requestId, INVALID_PARAMS, 'maxConcurrent must be an integer');
    }
    const maxConcurrentLimit = parsePositiveInt(
      env.TRIGGER_MAX_CONCURRENT_LIMIT,
      DEFAULT_TRIGGER_MAX_CONCURRENT_LIMIT
    );
    if (params.maxConcurrent < 1 || params.maxConcurrent > maxConcurrentLimit) {
      return jsonRpcError(
        requestId,
        INVALID_PARAMS,
        `maxConcurrent must be between 1 and ${maxConcurrentLimit}`
      );
    }
    updates.push('max_concurrent = ?');
    values.push(params.maxConcurrent);
  }

  if (params.promptTemplate !== undefined) {
    if (typeof params.promptTemplate !== 'string') {
      return jsonRpcError(requestId, INVALID_PARAMS, 'promptTemplate must be a string');
    }
    const maxTemplateLength = parsePositiveInt(
      env.CRON_TEMPLATE_MAX_LENGTH,
      DEFAULT_CRON_TEMPLATE_MAX_LENGTH
    );
    if (params.promptTemplate.length > maxTemplateLength) {
      return jsonRpcError(
        requestId,
        INVALID_PARAMS,
        `promptTemplate must be ${maxTemplateLength} characters or less`
      );
    }
    updates.push('prompt_template = ?');
    values.push(params.promptTemplate);
  }

  let recomputeNextFire = false;
  let newCronExpression = existingTrigger.cron_expression;
  let newTimezone = existingTrigger.cron_timezone ?? 'UTC';
  let cronHumanReadable = newCronExpression
    ? cronToHumanReadable(newCronExpression, newTimezone)
    : undefined;

  if (params.cronExpression !== undefined) {
    if (typeof params.cronExpression !== 'string' || !params.cronExpression.trim()) {
      return jsonRpcError(requestId, INVALID_PARAMS, 'cronExpression must be a non-empty string');
    }
    const cronExpression = params.cronExpression.trim();
    const minInterval = parsePositiveInt(
      env.CRON_MIN_INTERVAL_MINUTES,
      DEFAULT_CRON_MIN_INTERVAL_MINUTES
    );
    const validation = validateCronExpression(cronExpression, minInterval);
    if (!validation.valid) {
      return jsonRpcError(
        requestId,
        INVALID_PARAMS,
        `Invalid cron expression: ${validation.error}`
      );
    }
    updates.push('cron_expression = ?');
    values.push(cronExpression);
    newCronExpression = cronExpression;
    recomputeNextFire = true;
  }

  if (params.cronTimezone !== undefined) {
    if (typeof params.cronTimezone !== 'string' || !params.cronTimezone.trim()) {
      return jsonRpcError(requestId, INVALID_PARAMS, 'cronTimezone must be a non-empty string');
    }
    const cronTimezone = params.cronTimezone.trim();
    try {
      Intl.DateTimeFormat('en-US', { timeZone: cronTimezone });
    } catch {
      return jsonRpcError(requestId, INVALID_PARAMS, `Invalid timezone: ${cronTimezone}`);
    }
    updates.push('cron_timezone = ?');
    values.push(cronTimezone);
    newTimezone = cronTimezone;
    recomputeNextFire = true;
  }

  if (params.status !== undefined) {
    if (typeof params.status !== 'string' || !VALID_TRIGGER_STATUSES.has(params.status)) {
      return jsonRpcError(
        requestId,
        INVALID_PARAMS,
        'status must be "active", "paused", or "disabled"'
      );
    }
    updates.push('status = ?');
    values.push(params.status);
    if (params.status === 'paused' || params.status === 'disabled') {
      updates.push('next_fire_at = ?');
      values.push(null);
    } else if (existingTrigger.status === 'paused' || existingTrigger.status === 'disabled') {
      recomputeNextFire = true;
    }
  }

  const effectiveStatus =
    typeof params.status === 'string' ? params.status : existingTrigger.status;
  if (recomputeNextFire) {
    cronHumanReadable = newCronExpression
      ? cronToHumanReadable(newCronExpression, newTimezone)
      : undefined;
  }
  if (recomputeNextFire && effectiveStatus === 'active' && newCronExpression) {
    updates.push('next_fire_at = ?');
    values.push(cronToNextFire(newCronExpression, newTimezone));
  }

  if (bodyFields.length === 0) {
    return jsonRpcSuccess(requestId, {
      content: [
        { type: 'text', text: JSON.stringify(triggerResponse(existingTrigger, cronHumanReadable)) },
      ],
    });
  }

  await env.DATABASE.prepare(
    `UPDATE triggers SET ${updates.join(', ')} WHERE id = ? AND project_id = ?`
  )
    .bind(...values, triggerId, tokenData.projectId)
    .run();

  const updated = await env.DATABASE.prepare(
    `SELECT id, project_id, name, description, status, source_type, cron_expression,
      cron_timezone, skip_if_running, prompt_template, agent_profile_id, skill_id,
      task_mode, vm_size_override, max_concurrent, next_fire_at, created_at, updated_at
     FROM triggers
     WHERE id = ? AND project_id = ?
     LIMIT 1`
  )
    .bind(triggerId, tokenData.projectId)
    .first<TriggerDbRow>();

  if (!updated) {
    log.error('mcp.update_trigger_lost_scope', {
      triggerId,
      projectId: tokenData.projectId,
      action: 'rejected',
    });
    return jsonRpcError(requestId, INVALID_PARAMS, 'Trigger not found in this project');
  }

  log.info('mcp.update_trigger', {
    triggerId,
    projectId: tokenData.projectId,
    userId: tokenData.userId,
    fields: bodyFields,
  });

  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: JSON.stringify(triggerResponse(updated, cronHumanReadable)) }],
  });
}

export { handleCreateTrigger } from './trigger-create-tool';
export { handleDeleteTrigger } from './trigger-delete-tool';
export { handleListTriggers } from './trigger-list-tool';
