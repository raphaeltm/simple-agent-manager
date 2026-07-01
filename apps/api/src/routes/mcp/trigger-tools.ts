/**
 * MCP trigger management tools — create_trigger, update_trigger, delete_trigger.
 */
import {
  DEFAULT_CRON_MIN_INTERVAL_MINUTES,
  DEFAULT_CRON_TEMPLATE_MAX_LENGTH,
  DEFAULT_MAX_TRIGGERS_PER_PROJECT,
  DEFAULT_TRIGGER_DEFAULT_MAX_CONCURRENT,
  DEFAULT_TRIGGER_MAX_CONCURRENT_LIMIT,
  DEFAULT_TRIGGER_NAME_MAX_LENGTH,
} from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { parsePositiveInt } from '../../lib/route-helpers';
import { ulid } from '../../lib/ulid';
import { cronToHumanReadable, cronToNextFire, validateCronExpression } from '../../services/cron-utils';
import {
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
  type McpTokenData,
  sanitizeUserInput,
} from './_helpers';

const VALID_TRIGGER_STATUSES = new Set(['active', 'paused', 'disabled']);
const VALID_TASK_MODES = new Set(['task', 'conversation']);
const VALID_VM_SIZES = new Set(['small', 'medium', 'large']);

interface TriggerDbRow {
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

function normalizeBoolean(value: number | boolean | null | undefined, defaultValue: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return defaultValue;
}

function triggerResponse(row: TriggerDbRow, cronHumanReadable?: string) {
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
    cronHumanReadable: cronHumanReadable ?? (
      row.cron_expression ? cronToHumanReadable(row.cron_expression, row.cron_timezone ?? 'UTC') : undefined
    ),
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
     LIMIT 1`,
  ).bind(triggerId).first<TriggerDbRow>();
}

function validateTriggerOwnership(
  requestId: string | number | null,
  trigger: TriggerDbRow | null,
  triggerId: string,
  tokenData: McpTokenData,
  action: 'update' | 'delete',
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

export async function handleCreateTrigger(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  // --- Validate required fields ---
  const maxNameLength = parsePositiveInt(env.TRIGGER_NAME_MAX_LENGTH, DEFAULT_TRIGGER_NAME_MAX_LENGTH);
  const name = typeof params.name === 'string' ? sanitizeUserInput(params.name.trim()).slice(0, maxNameLength) : '';
  if (!name) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'name is required and must be a non-empty string');
  }

  const cronExpression = typeof params.cronExpression === 'string' ? params.cronExpression.trim() : '';
  if (!cronExpression) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'cronExpression is required');
  }

  const promptTemplate = typeof params.promptTemplate === 'string' ? params.promptTemplate.trim() : '';
  if (!promptTemplate) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'promptTemplate is required and must be non-empty');
  }

  const maxTemplateLength = parsePositiveInt(env.CRON_TEMPLATE_MAX_LENGTH, DEFAULT_CRON_TEMPLATE_MAX_LENGTH);
  if (promptTemplate.length > maxTemplateLength) {
    return jsonRpcError(requestId, INVALID_PARAMS, `promptTemplate must be ${maxTemplateLength} characters or less`);
  }

  // --- Validate cron expression ---
  const minInterval = parsePositiveInt(env.CRON_MIN_INTERVAL_MINUTES, DEFAULT_CRON_MIN_INTERVAL_MINUTES);
  const cronValidation = validateCronExpression(cronExpression, minInterval);
  if (!cronValidation.valid) {
    return jsonRpcError(requestId, INVALID_PARAMS, `Invalid cron expression: ${cronValidation.error}`);
  }

  // --- Validate timezone ---
  const cronTimezone = typeof params.cronTimezone === 'string' ? params.cronTimezone.trim() : 'UTC';
  try {
    Intl.DateTimeFormat('en-US', { timeZone: cronTimezone });
  } catch {
    return jsonRpcError(requestId, INVALID_PARAMS, `Invalid timezone: ${cronTimezone}`);
  }

  // --- Optional fields ---
  const agentProfileId = typeof params.agentProfileId === 'string' ? params.agentProfileId.trim() : null;
  const taskMode = params.taskMode === 'conversation' ? 'conversation' : 'task';
  const vmSizeOverride = ['small', 'medium', 'large'].includes(params.vmSizeOverride as string)
    ? (params.vmSizeOverride as string)
    : null;

  // --- Validate agentProfileId belongs to the project ---
  if (agentProfileId) {
    const profileResult = await env.DATABASE.prepare(
      'SELECT id FROM agent_profiles WHERE id = ? AND project_id = ? LIMIT 1',
    ).bind(agentProfileId, tokenData.projectId).first<{ id: string }>();
    if (!profileResult) {
      return jsonRpcError(requestId, INVALID_PARAMS, 'agentProfileId not found in this project');
    }
  }

  // --- Check name uniqueness ---
  const existingResult = await env.DATABASE.prepare(
    'SELECT id FROM triggers WHERE project_id = ? AND name = ? LIMIT 1',
  ).bind(tokenData.projectId, name).first<{ id: string }>();
  if (existingResult) {
    return jsonRpcError(requestId, INVALID_PARAMS, `Trigger "${name}" already exists in this project`);
  }

  // --- Enforce MAX_TRIGGERS_PER_PROJECT ---
  const maxTriggers = parsePositiveInt(env.MAX_TRIGGERS_PER_PROJECT, DEFAULT_MAX_TRIGGERS_PER_PROJECT);
  const countResult = await env.DATABASE.prepare(
    'SELECT COUNT(*) as cnt FROM triggers WHERE project_id = ?',
  ).bind(tokenData.projectId).first<{ cnt: number }>();
  if ((countResult?.cnt ?? 0) >= maxTriggers) {
    return jsonRpcError(requestId, INVALID_PARAMS, `Maximum triggers per project (${maxTriggers}) reached`);
  }

  // --- Create the trigger ---
  const triggerId = ulid();
  const now = new Date().toISOString();
  const nextFireAt = cronToNextFire(cronExpression, cronTimezone);
  const humanReadable = cronToHumanReadable(cronExpression, cronTimezone);

  await env.DATABASE.prepare(
    `INSERT INTO triggers (
      id, project_id, user_id, name, description, status, source_type,
      cron_expression, cron_timezone, skip_if_running, prompt_template,
      agent_profile_id, task_mode, vm_size_override, max_concurrent,
      next_fire_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, NULL, 'active', 'cron', ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    triggerId,
    tokenData.projectId,
    tokenData.userId,
    name,
    cronExpression,
    cronTimezone,
    promptTemplate,
    agentProfileId,
    taskMode,
    vmSizeOverride,
    DEFAULT_TRIGGER_DEFAULT_MAX_CONCURRENT,
    nextFireAt,
    now,
    now,
  ).run();

  log.info('mcp.create_trigger', {
    triggerId,
    projectId: tokenData.projectId,
    userId: tokenData.userId,
    cronExpression,
    cronTimezone,
  });

  return jsonRpcSuccess(requestId, {
    content: [{
      type: 'text',
      text: JSON.stringify({
        triggerId,
        name,
        status: 'active',
        cronExpression,
        cronTimezone,
        cronHumanReadable: humanReadable,
        nextFireAt,
        promptTemplate,
        taskMode,
        vmSizeOverride,
      }),
    }],
  });
}

export async function handleUpdateTrigger(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const triggerId = typeof params.triggerId === 'string' ? params.triggerId.trim() : '';
  if (!triggerId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'triggerId is required and must be a non-empty string');
  }

  const trigger = await getTriggerById(env, triggerId);
  const ownershipError = validateTriggerOwnership(requestId, trigger, triggerId, tokenData, 'update');
  if (ownershipError) return ownershipError;

  const existingTrigger = trigger as TriggerDbRow;
  const updates: string[] = ['updated_at = ?'];
  const values: unknown[] = [new Date().toISOString()];
  const bodyFields = Object.keys(params).filter((key) => key !== 'triggerId');

  if (params.name !== undefined) {
    const maxNameLength = parsePositiveInt(env.TRIGGER_NAME_MAX_LENGTH, DEFAULT_TRIGGER_NAME_MAX_LENGTH);
    if (typeof params.name !== 'string') {
      return jsonRpcError(requestId, INVALID_PARAMS, 'name must be a string');
    }
    const name = sanitizeUserInput(params.name.trim());
    if (!name) {
      return jsonRpcError(requestId, INVALID_PARAMS, 'name cannot be empty');
    }
    if (name.length > maxNameLength) {
      return jsonRpcError(requestId, INVALID_PARAMS, `name must be ${maxNameLength} characters or less`);
    }
    if (name !== existingTrigger.name) {
      const existingName = await env.DATABASE.prepare(
        'SELECT id FROM triggers WHERE project_id = ? AND name = ? AND id != ? LIMIT 1',
      ).bind(tokenData.projectId, name, triggerId).first<{ id: string }>();
      if (existingName) {
        return jsonRpcError(requestId, INVALID_PARAMS, `Trigger "${name}" already exists in this project`);
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
    const agentProfileId = typeof params.agentProfileId === 'string' ? params.agentProfileId.trim() : null;
    if (agentProfileId) {
      const profile = await env.DATABASE.prepare(
        'SELECT id FROM agent_profiles WHERE id = ? AND project_id = ? LIMIT 1',
      ).bind(agentProfileId, tokenData.projectId).first<{ id: string }>();
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
        'SELECT id FROM skills WHERE id = ? AND project_id = ? LIMIT 1',
      ).bind(skillId, tokenData.projectId).first<{ id: string }>();
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
    if (params.vmSizeOverride !== null && (
      typeof params.vmSizeOverride !== 'string' || !VALID_VM_SIZES.has(params.vmSizeOverride)
    )) {
      return jsonRpcError(requestId, INVALID_PARAMS, 'vmSizeOverride must be "small", "medium", "large", or null');
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
      DEFAULT_TRIGGER_MAX_CONCURRENT_LIMIT,
    );
    if (params.maxConcurrent < 1 || params.maxConcurrent > maxConcurrentLimit) {
      return jsonRpcError(requestId, INVALID_PARAMS, `maxConcurrent must be between 1 and ${maxConcurrentLimit}`);
    }
    updates.push('max_concurrent = ?');
    values.push(params.maxConcurrent);
  }

  if (params.promptTemplate !== undefined) {
    if (typeof params.promptTemplate !== 'string') {
      return jsonRpcError(requestId, INVALID_PARAMS, 'promptTemplate must be a string');
    }
    const maxTemplateLength = parsePositiveInt(env.CRON_TEMPLATE_MAX_LENGTH, DEFAULT_CRON_TEMPLATE_MAX_LENGTH);
    if (params.promptTemplate.length > maxTemplateLength) {
      return jsonRpcError(requestId, INVALID_PARAMS, `promptTemplate must be ${maxTemplateLength} characters or less`);
    }
    updates.push('prompt_template = ?');
    values.push(params.promptTemplate);
  }

  let recomputeNextFire = false;
  let newCronExpression = existingTrigger.cron_expression;
  let newTimezone = existingTrigger.cron_timezone ?? 'UTC';
  let cronHumanReadable = newCronExpression ? cronToHumanReadable(newCronExpression, newTimezone) : undefined;

  if (params.cronExpression !== undefined) {
    if (typeof params.cronExpression !== 'string' || !params.cronExpression.trim()) {
      return jsonRpcError(requestId, INVALID_PARAMS, 'cronExpression must be a non-empty string');
    }
    const cronExpression = params.cronExpression.trim();
    const minInterval = parsePositiveInt(env.CRON_MIN_INTERVAL_MINUTES, DEFAULT_CRON_MIN_INTERVAL_MINUTES);
    const validation = validateCronExpression(cronExpression, minInterval);
    if (!validation.valid) {
      return jsonRpcError(requestId, INVALID_PARAMS, `Invalid cron expression: ${validation.error}`);
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
      return jsonRpcError(requestId, INVALID_PARAMS, 'status must be "active", "paused", or "disabled"');
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

  const effectiveStatus = typeof params.status === 'string' ? params.status : existingTrigger.status;
  if (recomputeNextFire) {
    cronHumanReadable = newCronExpression ? cronToHumanReadable(newCronExpression, newTimezone) : undefined;
  }
  if (recomputeNextFire && effectiveStatus === 'active' && newCronExpression) {
    updates.push('next_fire_at = ?');
    values.push(cronToNextFire(newCronExpression, newTimezone));
  }

  if (bodyFields.length === 0) {
    return jsonRpcSuccess(requestId, {
      content: [{ type: 'text', text: JSON.stringify(triggerResponse(existingTrigger, cronHumanReadable)) }],
    });
  }

  await env.DATABASE.prepare(
    `UPDATE triggers SET ${updates.join(', ')} WHERE id = ? AND project_id = ?`,
  ).bind(...values, triggerId, tokenData.projectId).run();

  const updated = await env.DATABASE.prepare(
    `SELECT id, project_id, name, description, status, source_type, cron_expression,
      cron_timezone, skip_if_running, prompt_template, agent_profile_id, skill_id,
      task_mode, vm_size_override, max_concurrent, next_fire_at, created_at, updated_at
     FROM triggers
     WHERE id = ? AND project_id = ?
     LIMIT 1`,
  ).bind(triggerId, tokenData.projectId).first<TriggerDbRow>();

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

export async function handleDeleteTrigger(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const triggerId = typeof params.triggerId === 'string' ? params.triggerId.trim() : '';
  if (!triggerId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'triggerId is required and must be a non-empty string');
  }

  const trigger = await getTriggerById(env, triggerId);
  const ownershipError = validateTriggerOwnership(requestId, trigger, triggerId, tokenData, 'delete');
  if (ownershipError) return ownershipError;

  await env.DATABASE.prepare('DELETE FROM github_trigger_configs WHERE trigger_id = ?').bind(triggerId).run();
  await env.DATABASE.prepare('DELETE FROM trigger_executions WHERE trigger_id = ?').bind(triggerId).run();
  await env.DATABASE.prepare('DELETE FROM triggers WHERE id = ? AND project_id = ?')
    .bind(triggerId, tokenData.projectId)
    .run();

  log.info('mcp.delete_trigger', {
    triggerId,
    projectId: tokenData.projectId,
    userId: tokenData.userId,
  });

  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: JSON.stringify({ success: true, triggerId }) }],
  });
}
