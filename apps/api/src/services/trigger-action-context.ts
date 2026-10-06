import type { WebhookTriggerConfig } from '@simple-agent-manager/shared';

import type * as schema from '../db/schema';
import { buildGitHubContext } from './github-trigger-context';
import type { GitHubWebhookEvent } from './github-trigger-filter';
import { buildCronContext } from './trigger-template';
import { buildWebhookContext, selectWebhookHeaders } from './webhook-trigger-payload';

export type TriggerActionSourceConfig =
  | { sourceType: 'cron' }
  | { sourceType: 'github'; eventType: string }
  | { sourceType: 'webhook'; config: WebhookTriggerConfig };

interface TriggerActionContextInput {
  trigger: schema.TriggerRow;
  project: { id: string; name: string; repository: string | null };
  source: TriggerActionSourceConfig;
  now: Date;
  executionId: string;
  sequenceNumber: number;
  preview?: { payload?: Record<string, unknown>; headers?: Record<string, string> };
}

function manualGitHubEvent(eventType: string, repository: string | null): GitHubWebhookEvent {
  return {
    event: eventType,
    action: 'manual',
    sender: { login: 'manual', type: 'User' },
    repository: { full_name: repository ?? '' },
  };
}

/** Build the source-specific context used by both preview and manual execution actions. */
export function buildTriggerActionContext(input: TriggerActionContextInput) {
  const { trigger, project, source, now, executionId, sequenceNumber } = input;
  if (source.sourceType === 'webhook') {
    return buildWebhookContext({
      body: input.preview?.payload ?? {},
      headers: selectWebhookHeaders(input.preview?.headers ?? {}, source.config.includedHeaders),
      receivedAt: now.toISOString(),
      deliveryId: 'manual',
      sourceLabel: source.config.sourceLabel,
      trigger,
      projectName: project.name,
      executionId,
      sequenceNumber,
    });
  }
  if (source.sourceType === 'github') {
    return buildGitHubContext(
      manualGitHubEvent(source.eventType, project.repository),
      trigger,
      project,
      executionId,
      sequenceNumber
    );
  }
  return buildCronContext(
    {
      id: trigger.id,
      name: trigger.name,
      description: trigger.description,
      triggerCount: trigger.triggerCount,
      cronTimezone: trigger.cronTimezone ?? 'UTC',
      projectId: trigger.projectId,
    },
    now,
    project.name,
    executionId,
    sequenceNumber
  );
}
