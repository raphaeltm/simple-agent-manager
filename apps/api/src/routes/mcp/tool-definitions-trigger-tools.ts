/**
 * MCP tool definitions — trigger management tools.
 */
import { TRIGGER_SOURCE_TYPES, TRIGGER_STATUSES } from '@simple-agent-manager/shared';

import { resourceRequirementsMcpProperty } from './tool-definitions-shared-fields';

const githubConfigProperty = {
  type: 'object',
  description:
    'GitHub event configuration. Requires eventType; filters are replaced as a complete set on update. Use filters: {} to clear filters.',
  properties: {
    eventType: { type: 'string', enum: ['issues', 'issue_comment', 'pull_request', 'push'] },
    filters: {
      type: 'object',
      properties: {
        actions: { type: 'array', items: { type: 'string' } },
        labels: { type: 'array', items: { type: 'string' } },
        ignoreActors: { type: 'array', items: { type: 'string' } },
        commandPrefix: { type: 'string' },
        bodyContains: { type: 'string' },
        branches: { type: 'array', items: { type: 'string' } },
        ignoreDrafts: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  required: ['eventType'],
  additionalProperties: false,
};

export const TRIGGER_TOOLS = [
  {
    name: 'list_triggers',
    description:
      'List automation triggers in the current project. ' +
      'Returns bounded operational metadata for cron, webhook, GitHub, and private incident triggers without prompt templates, webhook credentials/configuration, or execution history.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        status: {
          type: 'string',
          description: 'Optional trigger status filter.',
          enum: [...TRIGGER_STATUSES],
        },
        sourceType: {
          type: 'string',
          description: 'Optional trigger source filter.',
          enum: [...TRIGGER_SOURCE_TYPES],
        },
        limit: {
          type: 'number',
          description: 'Maximum number of triggers to return. The server applies a configured cap.',
          minimum: 1,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'create_trigger',
    description:
      'Create a cron schedule or GitHub event automation trigger in the current project. ' +
      'The trigger will automatically submit tasks based on the prompt template at the specified schedule. ' +
      'Use this when a user asks to schedule recurring tasks (e.g., "run this every day at 9am"). ' +
      'Omitting sourceType preserves cron behavior; github requires githubConfig.eventType and no cron fields. Create webhook triggers and manage their one-time credentials through the UI or REST API.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Human-readable name for the trigger (max 100 characters)',
        },
        sourceType: {
          type: 'string',
          enum: ['cron', 'github'],
          description: 'Defaults to cron. GitHub triggers require githubConfig.',
        },
        githubConfig: githubConfigProperty,
        cronExpression: {
          type: 'string',
          description:
            'Required when sourceType is cron or omitted. Standard 5-field cron expression (minute hour day month weekday). ' +
            'Examples: "0 9 * * *" (daily at 9am), "0 9 * * 1-5" (weekdays at 9am), "*/30 * * * *" (every 30 min)',
        },
        cronTimezone: {
          type: 'string',
          description:
            'IANA timezone for the schedule (e.g., "America/New_York", "UTC"). Defaults to UTC.',
        },
        promptTemplate: {
          type: 'string',
          description:
            'The prompt sent to the agent each time the trigger fires. ' +
            'Supports {{variable}} interpolation: {{schedule.time}}, {{schedule.date}}, {{schedule.dayOfWeek}}, {{trigger.name}}, {{project.name}}, {{execution.sequenceNumber}}. GitHub triggers support {{github.title}}, {{github.body}}, {{github.action}}, {{github.actor}}, and {{github.comment}}.',
        },
        agentProfileId: {
          type: 'string',
          description: 'Optional agent profile to use. Defaults to project default.',
        },
        taskMode: {
          type: 'string',
          description:
            'Task mode: "task" (fire-and-forget) or "conversation" (interactive). Defaults to "task".',
          enum: ['task', 'conversation'],
        },
        vmSizeOverride: {
          type: 'string',
          description:
            'Deprecated legacy VM size override (small, medium, large). Prefer resourceRequirements; the canonical compatibility adapter translates legacy tiers.',
          enum: ['small', 'medium', 'large'],
        },
        resourceRequirements: resourceRequirementsMcpProperty({
          nullable: true,
          description:
            'Modern workload requirements for this trigger layer. Known fields: minVcpu, minMemoryGb, minDiskGb, and exclusiveNode. Placement uses explicit CPU, memory, and disk reservations. Omitted fields inherit; explicit false is preserved.',
        }),
        resourceRequirementsJson: {
          type: ['string', 'null'],
          description:
            'Compatibility JSON string for trigger workload requirements. Prefer resourceRequirements.',
        },
      },
      required: ['name', 'promptTemplate'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_trigger',
    description:
      'Update an existing automation trigger in the current project. ' +
      'Use this to rename a trigger, pause/resume it, change its prompt template, profile, skill, task mode, VM size, or concurrency limit. ' +
      'Cron schedule fields apply only to cron triggers. githubConfig applies only to GitHub triggers and replaces eventType/filters; sourceType cannot be changed. Webhook filters, included headers, and credential rotation are managed through the UI or REST API.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        triggerId: {
          type: 'string',
          description: 'ID of the trigger to update.',
        },
        name: {
          type: 'string',
          description: 'Human-readable name for the trigger.',
        },
        description: {
          type: ['string', 'null'],
          description: 'Optional trigger description. Use null to clear it.',
        },
        status: {
          type: 'string',
          description: 'Trigger status. Paused or disabled triggers do not schedule future runs.',
          enum: ['active', 'paused', 'disabled'],
        },
        githubConfig: githubConfigProperty,
        cronExpression: {
          type: 'string',
          description:
            'Optional cron-only schedule update. Standard 5-field cron expression (minute hour day month weekday). ' +
            'Changing this recomputes the next fire time for active triggers.',
        },
        cronTimezone: {
          type: 'string',
          description: 'IANA timezone for the schedule (e.g., "America/New_York", "UTC").',
        },
        skipIfRunning: {
          type: 'boolean',
          description:
            'Whether to skip a scheduled run when a previous execution is still queued or running.',
        },
        promptTemplate: {
          type: 'string',
          description:
            'The prompt sent to the agent each time the trigger fires. ' +
            'Supports {{variable}} interpolation.',
        },
        agentProfileId: {
          type: ['string', 'null'],
          description: 'Agent profile to use for triggered tasks. Use null to clear the override.',
        },
        skillId: {
          type: ['string', 'null'],
          description: 'Skill to use for triggered tasks. Use null to clear the override.',
        },
        taskMode: {
          type: 'string',
          description: 'Task mode: "task" (fire-and-forget) or "conversation" (interactive).',
          enum: ['task', 'conversation'],
        },
        vmSizeOverride: {
          type: ['string', 'null'],
          description:
            'Deprecated legacy VM size override. Use null to clear the override. Prefer resourceRequirements.',
          enum: ['small', 'medium', 'large', null],
        },
        resourceRequirements: resourceRequirementsMcpProperty({
          nullable: true,
          description:
            'Modern workload requirements for this trigger layer. Known fields: minVcpu, minMemoryGb, minDiskGb, and exclusiveNode. Placement uses explicit CPU, memory, and disk reservations. Omitted fields inherit; explicit false is preserved. Use null to clear.',
        }),
        resourceRequirementsJson: {
          type: ['string', 'null'],
          description:
            'Compatibility JSON string for trigger workload requirements. Prefer resourceRequirements. Use null to clear.',
        },
        maxConcurrent: {
          type: 'number',
          description: 'Maximum queued/running executions allowed for this trigger.',
        },
      },
      required: ['triggerId'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_trigger',
    description:
      'Delete an automation trigger in the current project. ' +
      'This also deletes its execution history and source-specific configuration.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        triggerId: {
          type: 'string',
          description: 'ID of the trigger to delete.',
        },
      },
      required: ['triggerId'],
      additionalProperties: false,
    },
  },
];
