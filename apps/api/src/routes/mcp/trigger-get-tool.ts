/**
 * MCP `get_trigger`: one automation's configuration and, for webhooks, where its setup stands
 * and what its recent calls did. It is how an agent that created a signed webhook learns that a
 * person saved the secret, that the provider confirmed the address, and why calls are refused,
 * and how a different agent resumes an interrupted setup. No token, signing secret or request
 * body is ever in the result.
 */
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { AppError } from '../../middleware/error';
import { readGitHubTriggerConfig } from '../../services/github-trigger-config';
import { toTriggerResponse } from '../../services/trigger-read';
import { getWebhookTriggerLimits } from '../../services/webhook-trigger-config';
import { readWebhookTriggerConfig } from '../../services/webhook-trigger-setup';
import { listWebhookDeliveries } from '../../services/webhook-trigger-store';
import { requireProjectTaskRead } from '../task-project-auth';
import {
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
  type McpTokenData,
} from './_helpers';

const NOT_FOUND = 'Trigger not found in this project';

export async function handleGetTrigger(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  const triggerId = typeof params.triggerId === 'string' ? params.triggerId.trim() : '';
  if (!triggerId) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'triggerId is required and must be a non-empty string'
    );
  }
  const db = drizzle(env.DATABASE, { schema });
  try {
    await requireProjectTaskRead(db, tokenData.projectId, tokenData.userId);
  } catch (error) {
    if (error instanceof AppError && error.statusCode < 500)
      return jsonRpcError(requestId, INVALID_PARAMS, error.message);
    throw error;
  }
  // The project comes from the token and is part of the lookup, so an ID from another project
  // reads exactly like one that does not exist.
  const row = await db
    .select()
    .from(schema.triggers)
    .where(
      and(eq(schema.triggers.id, triggerId), eq(schema.triggers.projectId, tokenData.projectId))
    )
    .get();
  if (!row) return jsonRpcError(requestId, INVALID_PARAMS, NOT_FOUND);

  const trigger = toTriggerResponse(row);
  const result: Record<string, unknown> = {
    triggerId: trigger.id,
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
    promptTemplate: trigger.promptTemplate,
    agentProfileId: trigger.agentProfileId,
    skillId: trigger.skillId,
    taskMode: trigger.taskMode,
    maxConcurrent: trigger.maxConcurrent,
    skipIfRunning: trigger.skipIfRunning,
  };
  if (row.sourceType === 'github') {
    result.githubConfig = await readGitHubTriggerConfig(db, row.id);
  }
  if (row.sourceType === 'webhook') {
    const config = await readWebhookTriggerConfig(env, row);
    if (config) {
      result.webhookConfig = config;
      // The same page the automation's call log shows. Metadata only.
      const calls = await listWebhookDeliveries(
        env,
        row.id,
        undefined,
        getWebhookTriggerLimits(env).deliveryDefaultPageSize
      );
      result.recentCalls = calls.deliveries.map((call) => ({
        outcome: call.outcome,
        reason: call.errorCode,
        httpStatus: call.httpStatus,
        receivedAt: call.receivedAt,
        executionId: call.executionId,
      }));
    }
  }
  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  });
}
