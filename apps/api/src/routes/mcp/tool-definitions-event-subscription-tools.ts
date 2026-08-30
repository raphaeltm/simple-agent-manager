import {
  PROJECT_EVENT_REQUESTED_DELIVERY_MODES,
  PROJECT_EVENT_SEVERITIES,
  PROJECT_EVENT_SUBSCRIPTION_STATES,
} from '@simple-agent-manager/shared';

const STRING_OR_STRING_ARRAY = {
  anyOf: [
    { type: 'string' },
    {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
    },
  ],
} as const;

const SEVERITY_OR_SEVERITY_ARRAY = {
  anyOf: [
    { type: 'string', enum: PROJECT_EVENT_SEVERITIES },
    {
      type: 'array',
      items: { type: 'string', enum: PROJECT_EVENT_SEVERITIES },
      minItems: 1,
    },
  ],
} as const;

const EVENT_FILTER_SCHEMA = {
  type: 'object' as const,
  properties: {
    version: {
      type: 'integer',
      enum: [1],
      description: 'ProjectData event filter version. The canonical pull model accepts only v1.',
    },
    source: {
      ...STRING_OR_STRING_ARRAY,
      description: 'Exact event source value or bounded set of values.',
    },
    eventType: {
      ...STRING_OR_STRING_ARRAY,
      description: 'Exact event type value or bounded set of values.',
    },
    subjectType: {
      ...STRING_OR_STRING_ARRAY,
      description: 'Exact event subject type value or bounded set of values.',
    },
    subjectId: {
      ...STRING_OR_STRING_ARRAY,
      description: 'Exact event subject id value or bounded set of values.',
    },
    severity: {
      ...SEVERITY_OR_SEVERITY_ARRAY,
      description: 'Exact event severity or bounded set of severities.',
    },
  },
  required: ['version'],
  additionalProperties: false,
};

const DELIVERY_TARGET_SCHEMA = {
  type: 'object' as const,
  properties: {
    sessionId: {
      type: 'string',
      description:
        'Optional safety check. If provided, it must match the calling task chat session.',
    },
    taskId: {
      type: 'string',
      description: 'Optional safety check. If provided, it must match the calling task.',
    },
    agentId: {
      type: 'string',
      description: 'Optional safety check. If provided, it must match the calling agent session.',
    },
  },
  additionalProperties: false,
};

export const PROJECT_EVENT_SUBSCRIPTION_TOOLS = [
  {
    name: 'create_project_event_subscription',
    description:
      'Create or replay a short-lived ProjectData event subscription owned by the calling task agent. Project, owner, session, task, and agent identity are derived from the MCP token; do not provide projectId or owner. After creating, call list_subscription_events with the returned subscriptionId to replay missed/queued matching events, get_event for full stored event details, then ack_event_delivery after processing each delivery. Delivery selection records intent only in this wave and does not inject prompts, steer runtimes, interrupt runtimes, or spawn tasks.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        idempotencyKey: {
          type: 'string',
          description:
            'Stable caller-chosen key for this subscription. Reuse this exact key when retrying the same create.',
        },
        filter: EVENT_FILTER_SCHEMA,
        requestedDelivery: {
          type: 'string',
          enum: PROJECT_EVENT_REQUESTED_DELIVERY_MODES,
          description:
            'Requested delivery policy. The current pull model records this separately from matching/routing and resolves non-record-only modes to recorded_not_injected until a future delivery adapter wave explicitly enables injection.',
        },
        target: DELIVERY_TARGET_SCHEMA,
        reason: {
          type: 'string',
          description: 'Optional diagnostic reason for creating the subscription.',
        },
        expiresAt: {
          type: 'integer',
          description:
            'Optional future millisecond timestamp. Agent subscriptions are capped by the caller MCP token lifetime.',
        },
      },
      required: ['idempotencyKey', 'filter', 'requestedDelivery'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_project_event_subscriptions',
    description:
      'List the calling task agent’s own ProjectData event subscriptions for the current session. Use this to recover the subscriptionId before list_subscription_events. Project and owner are derived from the MCP token.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        state: {
          type: 'string',
          enum: [...PROJECT_EVENT_SUBSCRIPTION_STATES, 'any'],
          description: 'Subscription lifecycle state to list. Defaults to active.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          description: 'Optional list limit; capped by ProjectData event configuration.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_project_event_subscription',
    description:
      'Get one ProjectData event subscription owned by the calling task agent in the current session, including filters, target, and recorded delivery preference. Missing subscriptions error by default; set required=false for optional checks.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        subscriptionId: {
          type: 'string',
          description: 'ProjectData event subscription id to inspect.',
        },
        required: {
          type: 'boolean',
          description:
            'When false, a missing subscription returns subscription:null instead of an error.',
        },
      },
      required: ['subscriptionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'cancel_project_event_subscription',
    description:
      'Cancel one ProjectData event subscription owned by the calling task agent in the current session. Already-cancelled or expired subscriptions are returned idempotently by ProjectData.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        subscriptionId: {
          type: 'string',
          description: 'ProjectData event subscription id to cancel.',
        },
        reason: {
          type: 'string',
          description: 'Optional diagnostic reason for cancellation.',
        },
        required: {
          type: 'boolean',
          description:
            'When false, a missing subscription returns subscription:null instead of an error.',
        },
      },
      required: ['subscriptionId'],
      additionalProperties: false,
    },
  },
];
