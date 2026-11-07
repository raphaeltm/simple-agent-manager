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
      'Send a message to an active same-project task agent. It is recorded on your shared agent-dm channel; the recipient gets a ' +
      'SAM notice naming the event and reads your text with get_event, which shows you as the verified sender. Your text is never ' +
      "posted into the recipient's chat, so it cannot be mistaken for a human message. " +
      'Message classes control urgency: "notify" and "deliver" join the recipient\'s running turn when its runtime supports live ' +
      'steering, or wait for its next turn. "interrupt", "preempt_and_replan" and "shutdown_with_final_prompt" stop the recipient\'s ' +
      'in-flight turn (the same transport as the user stop button) so the notice is its next prompt; use them only when the peer ' +
      'must see the message immediately. Returns the event ID, channel and transport "agent_message_channel". Accepted never means ' +
      'read or acted on. If agent message channels are unavailable on this installation, the send is refused with the reason.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        targetTaskId: {
          type: 'string',
          description: 'The same-project target task ID to send the message to',
        },
        message: {
          type: 'string',
          description:
            'The message for the recipient to read with get_event. At most PROJECT_EVENT_CHANNEL_MESSAGE_MAX_BYTES bytes (4096 by default); put longer detail in a file, PR or idea and send a pointer.',
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
        deliveryIntent: {
          type: 'string',
          enum: ['queue', 'steer'],
          description:
            "Accepted for compatibility. Every notify/deliver notice already joins a running turn when the recipient's runtime " +
            'can steer, so "queue" and "steer" deliver the same way. "steer" is rejected with an urgent messageClass.',
        },
        metadata: {
          type: 'object',
          description: 'Optional metadata to attach to the message (JSON object)',
        },
        idempotencyKey: {
          type: 'string',
          description:
            'Optional retry key. Reusing it after a lost response replays the same message instead of sending a second one ' +
            '(honored by agent message channels).',
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
      'Call this at turn boundaries to check for orchestrator directives. ' +
      'Messages from other agents are not listed here: they arrive as a SAM notice with event IDs for get_event.',
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
      'Send a message to a running same-project task agent. Any active task agent in the project can message any other; ' +
      'cross-project targets are rejected. The message is recorded on your shared agent-dm channel, the target gets a SAM notice ' +
      'and reads it with get_event, and the response reports { accepted: true, delivered: false, transport: "agent_message_channel" }. ' +
      "Your text is never posted into the target's chat. If agent message channels are unavailable, the send is refused with the reason.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        taskId: {
          type: 'string',
          description: 'The same-project target task ID to send the message to',
        },
        message: {
          type: 'string',
          description:
            'The message for the target agent to read with get_event. At most PROJECT_EVENT_CHANNEL_MESSAGE_MAX_BYTES bytes (4096 by default); put longer detail in a file, PR or idea and send a pointer.',
        },
        idempotencyKey: {
          type: 'string',
          description:
            'Optional retry key. Reusing it after a lost response replays the same message ' +
            '(honored by agent message channels).',
        },
      },
      required: ['taskId', 'message'],
      additionalProperties: false,
    },
  },
  {
    name: 'stop_subtask',
    description:
      "Gracefully stop a running child task's agent session. If a reason is provided, the child first gets a SAM notice that " +
      'it is being stopped (with a configurable grace period); the notice names you but does not quote your reason. The task ' +
      'status is updated to "cancelled" with the stop reason. Only the direct parent task can stop a child.',
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
            'Optional reason for stopping, recorded on the task. Providing one also gives the child a warning notice and a grace period',
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
