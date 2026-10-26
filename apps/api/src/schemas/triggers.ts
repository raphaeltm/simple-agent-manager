import { areGitHubTriggerActionsValid } from '@simple-agent-manager/shared';
import * as v from 'valibot';

import { ResourceRequirementsSchema } from './resource-requirements';

const TriggerSourceTypeSchema = v.picklist(['cron', 'webhook', 'github', 'incident', 'email']);
const TriggerStatusSchema = v.picklist(['active', 'paused', 'disabled']);
const TaskModeSchema = v.picklist(['task', 'conversation']);
const VMSizeSchema = v.picklist(['small', 'medium', 'large']);

const GitHubEventTypeSchema = v.picklist(['issues', 'issue_comment', 'pull_request', 'push']);

const GitHubFiltersSchema = v.optional(
  v.strictObject({
    actions: v.optional(v.array(v.string())),
    labels: v.optional(v.array(v.string())),
    ignoreActors: v.optional(v.array(v.string())),
    commandPrefix: v.optional(v.string()),
    bodyContains: v.optional(v.string()),
    branches: v.optional(v.array(v.string())),
    ignoreDrafts: v.optional(v.boolean()),
  })
);

export const GitHubConfigValueSchema = v.pipe(
  v.strictObject({
    eventType: GitHubEventTypeSchema,
    filters: GitHubFiltersSchema,
    subjectAffinity: v.optional(v.boolean()),
    queueMaxPending: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(1))),
    queueTtlSeconds: v.optional(
      v.pipe(
        v.number(),
        v.safeInteger(),
        v.minValue(1),
        v.check((seconds) => {
          const deadline = new Date(Date.now() + seconds * 1000);
          return Number.isFinite(deadline.getTime()) && deadline.toISOString().length === 24;
        }, 'Queue lifetime is outside the supported date range')
      )
    ),
  }),
  v.check(
    (config) => areGitHubTriggerActionsValid(config.eventType, config.filters?.actions),
    'Actions must be valid for the selected GitHub event; push has no actions'
  )
);
const GitHubConfigSchema = v.optional(GitHubConfigValueSchema);

const WebhookFilterValueSchema = v.union([v.string(), v.number(), v.boolean(), v.null_()]);

const WebhookFilterSchema = v.pipe(
  v.strictObject({
    path: v.pipe(
      v.string(),
      v.minLength(1),
      v.check(
        (path) =>
          path
            .split('.')
            .every((part) => part && !['__proto__', 'prototype', 'constructor'].includes(part)),
        'Filter path contains a forbidden segment'
      )
    ),
    operator: v.picklist(['exists', 'equals', 'contains']),
    value: v.optional(WebhookFilterValueSchema),
  }),
  v.check(
    (filter) =>
      filter.operator === 'exists' ? filter.value === undefined : filter.value !== undefined,
    'Filter value is required for equals/contains and forbidden for exists'
  )
);

const WebhookConfigValueSchema = v.strictObject({
  sourceLabel: v.optional(v.string()),
  filterMode: v.optional(v.picklist(['all', 'any'])),
  filters: v.optional(v.array(WebhookFilterSchema)),
  includedHeaders: v.optional(
    v.pipe(
      v.array(
        v.pipe(
          v.string(),
          v.minLength(1),
          v.check(
            (header) =>
              /^[a-z0-9!#$%&'*+.^_`|~-]+$/i.test(header) &&
              !/(authorization|cookie|signature|token|api-key)/i.test(header),
            'Header is invalid or sensitive'
          )
        )
      )
    )
  ),
});

const WebhookConfigSchema = v.optional(WebhookConfigValueSchema);

/** Allowed senders are compared lower-cased; the per-trigger count cap is an admin setting. */
const AllowedSenderSchema = v.pipe(
  v.string(),
  v.trim(),
  v.toLowerCase(),
  v.maxLength(254, 'Allowed sender is too long'),
  v.email('Each allowed sender must be an email address')
);

const EmailConfigValueSchema = v.strictObject({
  allowedSenders: v.optional(
    v.pipe(v.array(AllowedSenderSchema), v.minLength(1, 'Add at least one allowed sender'))
  ),
});

const EmailConfigSchema = v.optional(EmailConfigValueSchema);

export const CreateTriggerSchema = v.object({
  name: v.string(),
  description: v.optional(v.string()),
  sourceType: TriggerSourceTypeSchema,
  cronExpression: v.optional(v.string()),
  cronTimezone: v.optional(v.string()),
  skipIfRunning: v.optional(v.boolean()),
  promptTemplate: v.string(),
  agentProfileId: v.optional(v.string()),
  skillId: v.optional(v.string()),
  taskMode: v.optional(TaskModeSchema),
  vmSizeOverride: v.optional(VMSizeSchema),
  resourceRequirements: v.optional(v.nullable(ResourceRequirementsSchema)),
  resourceRequirementsJson: v.optional(v.nullable(v.string())),
  maxConcurrent: v.optional(v.number()),
  githubConfig: GitHubConfigSchema,
  webhookConfig: WebhookConfigSchema,
  emailConfig: EmailConfigSchema,
});

export const UpdateTriggerSchema = v.object({
  name: v.optional(v.string()),
  description: v.optional(v.nullable(v.string())),
  status: v.optional(TriggerStatusSchema),
  cronExpression: v.optional(v.string()),
  cronTimezone: v.optional(v.string()),
  skipIfRunning: v.optional(v.boolean()),
  promptTemplate: v.optional(v.string()),
  agentProfileId: v.optional(v.nullable(v.string())),
  skillId: v.optional(v.nullable(v.string())),
  taskMode: v.optional(TaskModeSchema),
  vmSizeOverride: v.optional(v.nullable(VMSizeSchema)),
  resourceRequirements: v.optional(v.nullable(ResourceRequirementsSchema)),
  resourceRequirementsJson: v.optional(v.nullable(v.string())),
  maxConcurrent: v.optional(v.number()),
  githubConfig: GitHubConfigSchema,
  webhookConfig: WebhookConfigSchema,
  emailConfig: EmailConfigSchema,
});

export const TriggerPreviewSchema = v.strictObject({
  payload: v.optional(v.record(v.string(), v.unknown())),
  headers: v.optional(v.record(v.string(), v.string())),
});

export { EmailConfigValueSchema, WebhookConfigValueSchema };
