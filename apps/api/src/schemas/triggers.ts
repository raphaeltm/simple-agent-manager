import * as v from 'valibot';

const TriggerSourceTypeSchema = v.picklist(['cron', 'webhook', 'github']);
const TriggerStatusSchema = v.picklist(['active', 'paused', 'disabled']);
const TaskModeSchema = v.picklist(['task', 'conversation']);
const VMSizeSchema = v.picklist(['small', 'medium', 'large']);

const GitHubEventTypeSchema = v.picklist(['issues', 'issue_comment', 'pull_request', 'push']);

const GitHubFiltersSchema = v.optional(
  v.object({
    actions: v.optional(v.array(v.string())),
    labels: v.optional(v.array(v.string())),
    ignoreActors: v.optional(v.array(v.string())),
    commandPrefix: v.optional(v.string()),
    bodyContains: v.optional(v.string()),
    branches: v.optional(v.array(v.string())),
    ignoreDrafts: v.optional(v.boolean()),
  })
);

const GitHubConfigSchema = v.optional(
  v.object({
    eventType: GitHubEventTypeSchema,
    filters: GitHubFiltersSchema,
  })
);

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
  maxConcurrent: v.optional(v.number()),
  githubConfig: GitHubConfigSchema,
  webhookConfig: WebhookConfigSchema,
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
  maxConcurrent: v.optional(v.number()),
  githubConfig: GitHubConfigSchema,
  webhookConfig: WebhookConfigSchema,
});

export const TriggerPreviewSchema = v.strictObject({
  payload: v.optional(v.record(v.string(), v.unknown())),
  headers: v.optional(v.record(v.string(), v.string())),
});

export { WebhookConfigValueSchema };
