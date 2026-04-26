/**
 * MCP tool definitions — project orchestrator (scheduling, mission lifecycle, status).
 */

export const ORCHESTRATOR_LIFECYCLE_TOOLS = [
  {
    name: 'get_orchestrator_status',
    description:
      'Get the current orchestrator status for this project, including active missions, ' +
      'scheduling queue, and recent decisions.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'get_scheduling_queue',
    description:
      'Get the scheduling queue showing tasks pending dispatch by the orchestrator.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'pause_mission',
    description:
      'Pause a mission — running tasks continue but no new tasks are dispatched. ' +
      'Returns success:true if the mission was active and is now paused.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        missionId: {
          type: 'string',
          description: 'The mission ID to pause',
        },
      },
      required: ['missionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'resume_mission',
    description:
      'Resume a paused mission — re-enables task scheduling. ' +
      'Returns success:true if the mission was paused and is now active.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        missionId: {
          type: 'string',
          description: 'The mission ID to resume',
        },
      },
      required: ['missionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'cancel_mission',
    description:
      'Cancel a mission — marks all pending tasks as cancelled and removes the mission ' +
      'from orchestration. Running tasks are NOT stopped (use stop_subtask for that).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        missionId: {
          type: 'string',
          description: 'The mission ID to cancel',
        },
      },
      required: ['missionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'override_task_state',
    description:
      'Override a task\'s scheduler state manually. Use when the orchestrator\'s computed state ' +
      'is incorrect or when you need to force a task into a specific state. ' +
      'Allowed states: schedulable, blocked_human, cancelled, failed.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        missionId: {
          type: 'string',
          description: 'The mission the task belongs to',
        },
        taskId: {
          type: 'string',
          description: 'The task ID to override',
        },
        newState: {
          type: 'string',
          description: 'The new scheduler state',
          enum: ['schedulable', 'blocked_human', 'cancelled', 'failed'],
        },
        reason: {
          type: 'string',
          description: 'Reason for the override (logged for auditability)',
        },
      },
      required: ['missionId', 'taskId', 'newState', 'reason'],
      additionalProperties: false,
    },
  },
];
