/**
 * MCP tool definitions — durable project event-bus retrieval.
 */

export const EVENT_BUS_TOOLS = [
  {
    name: 'get_event',
    description:
      'Fetch one durable project event by stable event ID when it is visible through a subscription owned by or targeted at the calling agent. Returns normalized metadata and the full payload. Caller identity is derived from the MCP token.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        eventId: {
          type: 'string',
          minLength: 1,
          description: 'Stable event ID from a live notification envelope or subscription listing',
        },
      },
      required: ['eventId'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_subscription_events',
    description:
      'Cursor-paginate durable event deliveries visible through one authorized subscription. Use this after waking to retrieve missed or queued events. Summaries never include payload; call get_event with an event ID for full payload.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        subscriptionId: {
          type: 'string',
          minLength: 1,
          description: 'Authorized durable event-bus subscription ID',
        },
        limit: {
          type: 'number',
          minimum: 1,
          description:
            'Optional page size. Oversized values are capped by MCP_EVENT_BUS_LIST_MAX.',
        },
        cursor: {
          type: 'string',
          minLength: 1,
          description:
            'Opaque cursor returned by the previous list_subscription_events response for this same subscription',
        },
      },
      required: ['subscriptionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'ack_event_delivery',
    description:
      'Idempotently acknowledge a durable event delivery when that subscription delivery policy requires acknowledgement. Rejects deliveries that do not require ack.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        deliveryId: {
          type: 'string',
          minLength: 1,
          description: 'Delivery ID from list_subscription_events or get_event',
        },
      },
      required: ['deliveryId'],
      additionalProperties: false,
    },
  },
];
