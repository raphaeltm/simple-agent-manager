/**
 * MCP tool definitions — orchestration tools (agent-to-agent communication and control).
 */

export const ORCHESTRATION_TOOLS = [
  {
    name: 'wait_for_subtasks',
    description:
      'Register a durable wait on same-project tasks, then end the current turn. SAM wakes the calling session through durable prompt delivery when all or any selected tasks become terminal, or when the finite wake deadline is reached. Use this instead of background polling. Persist workflow state before calling.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        taskIds: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Unique same-project task IDs to observe',
        },
        waitKey: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
          pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$',
          description:
            'Stable workflow-step idempotency key. Persist and reuse this exact value if registration is retried.',
        },
        condition: {
          type: 'string',
          enum: ['all', 'any'],
          description:
            'Wake after all children are terminal (default) or after any child is terminal',
        },
        wakeAfterSeconds: {
          type: 'integer',
          minimum: 1,
          description: 'Optional finite wake deadline in seconds; capped by server configuration',
        },
      },
      required: ['taskIds', 'waitKey'],
      additionalProperties: false,
    },
  },
  // ─── Durable messaging tools ───────────────────────────────────────
  {
    name: 'send_durable_message',
    description:
      'Send a durable message to an active same-project task agent. The message is persisted in the mailbox and will be delivered ' +
      'even if the target agent is busy. Message classes control urgency: "notify" (best-effort), "deliver" (durable, ack optional), ' +
      '"interrupt" (preempts current work), "preempt_and_replan" (requires ack + replanning), ' +
      '"shutdown_with_final_prompt" (delivers final message with highest urgency — session termination is a Phase 2 feature). ' +
      'Returns the message ID and delivery state.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        targetTaskId: {
          type: 'string',
          description: 'The same-project target task ID to send the message to',
        },
        message: {
          type: 'string',
          description: 'The message content to deliver (max 32768 chars)',
        },
        messageClass: {
          type: 'string',
          enum: [
            'notify',
            'deliver',
            'interrupt',
            'preempt_and_replan',
            'shutdown_with_final_prompt',
          ],
          description: 'Message urgency class (default: "deliver")',
        },
        metadata: {
          type: 'object',
          description: 'Optional metadata to attach to the message (JSON object)',
        },
      },
      required: ['targetTaskId', 'message'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_pending_messages',
    description:
      "Get all unacknowledged messages for the calling agent's session, ordered by urgency " +
      '(shutdown_with_final_prompt first, then preempt_and_replan, interrupt, deliver, notify). ' +
      'Messages are automatically marked as "delivered" when retrieved. ' +
      'Call this at turn boundaries to check for orchestrator directives.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'ack_message',
    description:
      'Acknowledge receipt and processing of a durable message. Required for all message classes except "notify". ' +
      'Unacknowledged messages will be re-delivered after the ack timeout. ' +
      'Call this after you have acted on the message content.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        messageId: {
          type: 'string',
          description: 'The message ID to acknowledge',
        },
      },
      required: ['messageId'],
      additionalProperties: false,
    },
  },
  // ─── Orchestration tools (agent-to-agent communication & control) ───
  {
    name: 'send_message_to_subtask',
    description:
      'Send a message to a running same-project task agent. The message is injected as a user-role prompt into the target ACP session. ' +
      'Any active task agent in the project can message any other active task agent in the same project; cross-project targets are rejected. ' +
      'Returns { delivered: true } on success, or { delivered: false, reason: "agent_busy" } if the target agent is currently processing.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        taskId: {
          type: 'string',
          description: 'The same-project target task ID to send the message to',
        },
        message: {
          type: 'string',
          description: "The message to inject into the target agent's session (max 32768 chars)",
        },
      },
      required: ['taskId', 'message'],
      additionalProperties: false,
    },
  },
  {
    name: 'stop_subtask',
    description:
      "Gracefully stop a running child task's agent session. If a reason is provided, it is sent as a warning message " +
      'before the hard stop (with a configurable grace period). The task status is updated to "cancelled" with the stop reason. ' +
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
          description:
            'Optional reason for stopping — sent as a warning message to the child before the hard stop',
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
          description:
            'Optional replacement description. If omitted, the original description is reused with failure context appended.',
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
