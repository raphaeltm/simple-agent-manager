/**
 * MCP trigger management tools — create_trigger.
 */
import {
  DEFAULT_CRON_MIN_INTERVAL_MINUTES,
  DEFAULT_CRON_TEMPLATE_MAX_LENGTH,
  DEFAULT_MAX_TRIGGERS_PER_PROJECT,
  DEFAULT_TRIGGER_DEFAULT_MAX_CONCURRENT,
} from '@simple-agent-manager/shared';

import type { Env } from '../../index';
import { log } from '../../lib/logger';
import { parsePositiveInt } from '../../lib/route-helpers';
import { ulid } from '../../lib/ulid';
import { cronToHumanReadable, cronToNextFire, validateCronExpression } from '../../services/cron-utils';
import {
  type JsonRpcResponse,
  jsonRpcError,
  jsonRpcSuccess,
  INVALID_PARAMS,
  type McpTokenData,
  sanitizeUserInput,
} from './_helpers';

export async function handleCreateTrigger(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  // --- Validate required fields ---
  const name = typeof params.name === 'string' ? sanitizeUserInput(params.name.trim()).slice(0, 100) : '';
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
