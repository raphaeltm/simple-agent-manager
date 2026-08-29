/**
 * MCP tool definitions — ProjectData event retrieval and acknowledgement.
 */

export const PROJECT_EVENT_TOOLS = [
  {
    name: 'list_subscription_events',
    description:
      'Replay durable ProjectData events for one active, unexpired subscription visible to the calling task agent. Use after create_project_event_subscription and whenever the agent wakes or polls: create a subscription with filters, call list_subscription_events with the subscriptionId to receive payload-free event summaries and delivery IDs, keep calling with the opaque nextCursor for the same subscription until hasMore is false, then call get_event for any event that needs full stored details and ack_event_delivery after processing each delivery. Project, task, session, workspace, owner, and agent identity are derived from the MCP token.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        subscriptionId: {
          type: 'string',
          minLength: 1,
          description:
            'ProjectData event subscription ID returned by create_project_event_subscription or list_project_event_subscriptions.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          description:
            'Optional page size. Values are capped by PROJECT_EVENT_LIST_MAX and default from PROJECT_EVENT_LIST_LIMIT.',
        },
        cursor: {
          type: 'string',
          minLength: 1,
          description:
            'Opaque cursor returned by the previous list_subscription_events response for this same subscription. Do not modify or reuse it with another subscription.',
        },
      },
      required: ['subscriptionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_event',
    description:
      'Fetch one durable ProjectData event by stable event ID when it is visible through an active, unexpired subscription owned by or targeted at the calling task agent. Use this only after a list_subscription_events summary or live notification identifies an event that needs full stored details such as rawPayloadRef, deliveryKey, payloadFingerprint, and conflict counters. Identity is derived from the MCP token.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        eventId: {
          type: 'string',
          minLength: 1,
          description:
            'Stable ProjectData event ID from list_subscription_events or a notification.',
        },
      },
      required: ['eventId'],
      additionalProperties: false,
    },
  },
  {
    name: 'ack_event_delivery',
    description:
      'Idempotently acknowledge a ProjectData event delivery after the agent has processed it. Use the deliveryId returned by list_subscription_events or get_event. Repeated calls for the same already-acked delivery return idempotent=true. Acks are scoped to the active, unexpired subscription visible to the caller, and the batch state becomes acked; this does not inject prompts, steer runtimes, interrupt runtimes, or spawn tasks.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        deliveryId: {
          type: 'string',
          minLength: 1,
          description: 'ProjectData delivery batch ID returned in an event delivery envelope.',
        },
      },
      required: ['deliveryId'],
      additionalProperties: false,
    },
  },
];
