/**
 * MCP tool definitions — trigger management tools.
 */
import type { McpToolDefinition } from './_helpers';

export const TRIGGER_TOOLS: McpToolDefinition[] = [
  {
    name: 'create_trigger',
    description:
      'Create a new automation trigger that runs tasks on a cron schedule. ' +
      'The trigger will automatically submit tasks based on the prompt template at the specified schedule. ' +
      'Use this when a user asks to schedule recurring tasks (e.g., "run this every day at 9am").',
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
          description: 'IANA timezone for the schedule (e.g., "America/New_York", "UTC"). Defaults to UTC.',
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
          description: 'Task mode: "task" (fire-and-forget) or "conversation" (interactive). Defaults to "task".',
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
];
