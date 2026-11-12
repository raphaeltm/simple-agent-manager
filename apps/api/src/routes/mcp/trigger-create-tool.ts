import {
  ResourceRequirementsValidationError,
  serializeModernResourceRequirementsInput,
  serializeResourceRequirementsInput,
} from '@simple-agent-manager/scheduler-core';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import * as v from 'valibot';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { AppError } from '../../middleware/error';
import { CreateTriggerSchema } from '../../schemas/triggers';
import { cronToHumanReadable } from '../../services/cron-utils';
import { readGitHubTriggerConfig } from '../../services/github-trigger-config';
import { createTrigger } from '../../services/trigger-create';
import { areWebhookTriggersEnabled } from '../../services/webhook-trigger-config';
import { readWebhookTriggerConfig } from '../../services/webhook-trigger-setup';
import { requireProjectTaskWrite } from '../task-project-auth';
import {
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
  type McpTokenData,
  sanitizeUserInput,
} from './_helpers';

const SECRET_PARAM_NAMES = ['secret', 'signingSecret', 'signing_secret'];

export async function handleCreateTrigger(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  const sourceType = params.sourceType === undefined ? 'cron' : params.sourceType;
  if (sourceType !== 'cron' && sourceType !== 'github' && sourceType !== 'webhook') {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'sourceType must be "cron", "github", or "webhook"'
    );
  }
  // The signing secret of a signed webhook is saved by a person on the automation's page so it
  // never passes through a transcript. Refuse it here instead of dropping it silently.
  const webhookInput =
    typeof params.webhookConfig === 'object' && params.webhookConfig !== null
      ? (params.webhookConfig as Record<string, unknown>)
      : {};
  if (
    SECRET_PARAM_NAMES.some(
      (name) => params[name] !== undefined || webhookInput[name] !== undefined
    )
  ) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'Do not pass a signing secret to create_trigger. Create the trigger, then ask a person to save the secret at the returned webhookConfig.setup.secretEntryUrl.'
    );
  }
  // Keep MCP's modern resource input contract and retired-field compatibility.
  let resourceRequirementsJson: string | null;
  try {
    resourceRequirementsJson =
      params.resourceRequirements !== undefined
        ? serializeModernResourceRequirementsInput(params.resourceRequirements)
        : serializeResourceRequirementsInput(
            params.resourceRequirementsJson,
            'resourceRequirementsJson'
          );
  } catch (error) {
    if (error instanceof ResourceRequirementsValidationError)
      return jsonRpcError(requestId, INVALID_PARAMS, error.message);
    throw error;
  }
  const parsed = v.safeParse(CreateTriggerSchema, {
    ...params,
    sourceType,
    name: typeof params.name === 'string' ? sanitizeUserInput(params.name.trim()) : params.name,
    cronExpression:
      typeof params.cronExpression === 'string'
        ? params.cronExpression.trim()
        : params.cronExpression,
    cronTimezone:
      typeof params.cronTimezone === 'string' ? params.cronTimezone.trim() : params.cronTimezone,
    agentProfileId:
      typeof params.agentProfileId === 'string'
        ? params.agentProfileId.trim()
        : params.agentProfileId,
    resourceRequirements: undefined,
    resourceRequirementsJson,
  });
  if (!parsed.success) {
    const issue = parsed.issues[0];
    const path = issue.path?.map((item) => String(item.key)).join('.') ?? 'input';
    return jsonRpcError(requestId, INVALID_PARAMS, `${path}: ${issue.message}`);
  }
  try {
    const db = drizzle(env.DATABASE, { schema });
    const project = await db
      .select({ id: schema.projects.id, maxTriggers: schema.projects.maxTriggers })
      .from(schema.projects)
      .where(eq(schema.projects.id, tokenData.projectId))
      .get();
    if (!project) return jsonRpcError(requestId, INVALID_PARAMS, 'Project not found');
    if (sourceType === 'webhook') {
      await requireProjectTaskWrite(db, tokenData.projectId, tokenData.userId);
      if (!areWebhookTriggersEnabled(env))
        return jsonRpcError(requestId, INVALID_PARAMS, 'Webhook triggers are disabled');
    }
    const { created, webhookClaim } = await createTrigger(
      db,
      env,
      project,
      tokenData.userId,
      parsed.output,
      sourceType === 'webhook' ? tokenData : undefined
    );
    log.info('mcp.create_trigger', {
      triggerId: created.id,
      projectId: tokenData.projectId,
      userId: tokenData.userId,
      sourceType,
    });
    return jsonRpcSuccess(requestId, {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            webhookClaim,
            triggerId: created.id,
            id: created.id,
            name: created.name,
            description: created.description,
            maxConcurrent: created.maxConcurrent,
            skipIfRunning: created.skipIfRunning,
            status: created.status,
            sourceType: created.sourceType,
            cronExpression: created.cronExpression,
            cronTimezone: created.cronTimezone,
            nextFireAt: created.nextFireAt,
            promptTemplate: created.promptTemplate,
            agentProfileId: created.agentProfileId,
            taskMode: created.taskMode,
            vmSizeOverride: created.vmSizeOverride,
            resourceRequirementsJson: created.resourceRequirementsJson,
            cronHumanReadable: created.cronExpression
              ? cronToHumanReadable(created.cronExpression, created.cronTimezone ?? 'UTC')
              : undefined,
            githubConfig:
              sourceType === 'github' ? await readGitHubTriggerConfig(db, created.id) : undefined,
            // Address, scheme, and for signed schemes the setup state and the page where a
            // person saves the signing secret. Never a credential.
            webhookConfig:
              sourceType === 'webhook' ? await readWebhookTriggerConfig(env, created) : undefined,
          }),
        },
      ],
    });
  } catch (error) {
    if (error instanceof AppError && error.statusCode < 500)
      return jsonRpcError(requestId, INVALID_PARAMS, error.message);
    throw error;
  }
}
