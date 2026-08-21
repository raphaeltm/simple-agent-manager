import {
  TRIGGER_SOURCE_TYPES,
  TRIGGER_STATUSES,
  type TriggerSourceType,
  type TriggerStatus,
} from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { listTriggerRows, toTriggerResponse } from '../../services/trigger-read';
import {
  getMcpLimits,
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
  type McpTokenData,
} from './_helpers';

const VALID_TRIGGER_STATUSES = new Set<TriggerStatus>(TRIGGER_STATUSES);
const VALID_TRIGGER_SOURCE_TYPES = new Set<TriggerSourceType>(TRIGGER_SOURCE_TYPES);

export async function handleListTriggers(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  if (
    params.status !== undefined &&
    (typeof params.status !== 'string' ||
      !VALID_TRIGGER_STATUSES.has(params.status as TriggerStatus))
  ) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'status must be "active", "paused", or "disabled"'
    );
  }
  if (
    params.sourceType !== undefined &&
    (typeof params.sourceType !== 'string' ||
      !VALID_TRIGGER_SOURCE_TYPES.has(params.sourceType as TriggerSourceType))
  ) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'sourceType must be "cron", "webhook", "github", or "incident"'
    );
  }
  if (
    params.limit !== undefined &&
    (typeof params.limit !== 'number' || !Number.isFinite(params.limit) || params.limit <= 0)
  ) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'limit must be a positive number');
  }

  const limits = getMcpLimits(env);
  const requestedLimit = typeof params.limit === 'number' ? params.limit : limits.triggerListLimit;
  const limit = Math.min(Math.max(1, Math.floor(requestedLimit)), limits.triggerListMax);
  const status = params.status as TriggerStatus | undefined;
  const sourceType = params.sourceType as TriggerSourceType | undefined;
  const db = drizzle(env.DATABASE, { schema });
  const rows = await listTriggerRows(db, tokenData.projectId, { status, sourceType, limit });
  const triggers = rows.map((row) => {
    const trigger = toTriggerResponse(row);
    return {
      id: trigger.id,
      name: trigger.name,
      description: trigger.description,
      status: trigger.status,
      sourceType: trigger.sourceType,
      cronExpression: trigger.cronExpression,
      cronTimezone: trigger.cronTimezone,
      cronHumanReadable: trigger.cronHumanReadable ?? null,
      nextFireAt: trigger.nextFireAt,
      lastTriggeredAt: trigger.lastTriggeredAt,
      triggerCount: trigger.triggerCount,
      taskMode: trigger.taskMode,
      agentProfileId: trigger.agentProfileId,
      skillId: trigger.skillId,
      maxConcurrent: trigger.maxConcurrent,
      skipIfRunning: trigger.skipIfRunning,
    };
  });

  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: JSON.stringify({ triggers }, null, 2) }],
  });
}
