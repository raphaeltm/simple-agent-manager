/**
 * MCP tool definitions — trigger management tools.
 */

export const TRIGGER_TOOLS = [
  {
    name: 'create_trigger',
    description:
      'Create a new automation trigger that runs tasks on a cron schedule. ' +
      'The trigger will automatically submit tasks based on the prompt template at the specified schedule. ' +
      'Use this when a user asks to schedule recurring tasks (e.g., "run this every day at 9am"). ' +
      'This MCP tool creates cron triggers only; create webhook triggers and manage their one-time credentials through the UI or REST API.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Human-readable name for the trigger (max 100 characters)',
        },
        cronExpression: {
          type: 'string',
          description:
            'Standard 5-field cron expression (minute hour day month weekday). ' +
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
            'Supports {{variable}} interpolation: {{schedule.time}}, {{schedule.date}}, {{schedule.dayOfWeek}}, {{trigger.name}}, {{project.name}}, {{execution.sequenceNumber}}.',
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
          description: 'VM size override (small, medium, large). Defaults to project default.',
          enum: ['small', 'medium', 'large'],
        },
      },
      required: ['name', 'cronExpression', 'promptTemplate'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_trigger',
    description:
      'Update an existing automation trigger in the current project. ' +
      'Use this to rename a trigger, pause/resume it, change its prompt template, profile, skill, task mode, VM size, or concurrency limit. ' +
      'Cron schedule fields apply to cron triggers. Webhook filters, included headers, and credential rotation are managed through the UI or REST API.',
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
        cronExpression: {
          type: 'string',
          description:
            'Standard 5-field cron expression (minute hour day month weekday). ' +
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
          description: 'VM size override. Use null to clear the override.',
          enum: ['small', 'medium', 'large', null],
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
