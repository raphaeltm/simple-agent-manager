/**
 * MCP tool definitions — orchestration tools (agent-to-agent communication and control).
 */

export const ORCHESTRATION_TOOLS = [
  // ─── Orchestration tools (agent-to-agent communication & control) ───
  {
    name: 'send_message_to_subtask',
    description:
      'Send a message to a running child task\'s agent. The message is injected as a user-role prompt into the child\'s ACP session. ' +
      'Only the direct parent task can message a child — grandparents and siblings are rejected. ' +
      'Returns { delivered: true } on success, or { delivered: false, reason: "agent_busy" } if the child agent is currently processing.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        taskId: {
          type: 'string',
          description: 'The child task ID to send the message to',
        },
        message: {
          type: 'string',
          description: 'The message to inject into the child agent\'s session (max 32768 chars)',
        },
      },
      required: ['taskId', 'message'],
      additionalProperties: false,
    },
  },
  {
    name: 'stop_subtask',
    description:
      'Gracefully stop a running child task\'s agent session. If a reason is provided, it is sent as a warning message ' +
      'before the hard stop (with a configurable grace period). The task status is updated to "failed" with the stop reason. ' +
      'Only the direct parent task can stop a child.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        taskId: {
          type: 'string',
          description: 'The child task ID to stop',
        },
        reason: {
          type: 'string',
          description: 'Optional reason for stopping — sent as a warning message to the child before the hard stop',
        },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'retry_subtask',
    description:
      'Stop a failed or stalled child task and dispatch a replacement with optionally modified instructions. ' +
      'Only the direct parent can retry a subtask. The replacement inherits the same dispatch depth and project defaults. ' +
      'Rate-limited: max retries per task apply (configurable via ORCHESTRATOR_MAX_RETRIES_PER_TASK).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        taskId: {
          type: 'string',
          description: 'The task ID of the child task to retry',
        },
        newDescription: {
          type: 'string',
          description: 'Optional replacement description. If omitted, the original description is reused with failure context appended.',
        },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_dependency',
    description:
      'Add a dependency edge between two tasks in the execution graph. The first task (taskId) will depend on the second task (dependsOnTaskId). ' +
      'Caller must be the parent of both tasks. Cycle detection prevents circular dependencies. ' +
      'Idempotent: adding the same dependency twice is a no-op.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        taskId: {
          type: 'string',
          description: 'The task that should depend on another task',
        },
        dependsOnTaskId: {
          type: 'string',
          description: 'The task that must complete first',
        },
      },
      required: ['taskId', 'dependsOnTaskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'remove_pending_subtask',
    description:
      'Remove a not-yet-started (queued) child task from the execution graph. The task is marked as cancelled and all dependency edges are cleaned up. ' +
      'Only the direct parent can remove a subtask. Cannot remove running tasks — use retry_subtask for those.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        taskId: {
          type: 'string',
          description: 'The task ID of the queued child task to remove',
        },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
];
