const string = { type: 'string' } as const;
const timestamp = { type: 'integer', minimum: 1 } as const;
const action = {
  oneOf: [
    {
      type: 'object',
      properties: { kind: { const: 'message_session' }, sessionId: string, prompt: string },
      required: ['kind', 'sessionId', 'prompt'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        kind: { const: 'start_session' },
        prompt: string,
        agentProfileId: { type: ['string', 'null'] },
        skillId: { type: ['string', 'null'] },
      },
      required: ['kind', 'prompt'],
      additionalProperties: false,
    },
  ],
};
export const PROJECT_SCHEDULE_TOOLS = [
  {
    name: 'create_project_schedule',
    description:
      'Persist a one-off scheduled message to a same-project chat or a new task-backed session. UTC dueAt is epoch milliseconds; displayTimezone is IANA. This survives token expiry and holds no compute. Delivery can be late or queued while busy. No exact-second execution or exactly-once agent side effects are promised. Reuse the same idempotencyKey for retries.',
    inputSchema: {
      type: 'object',
      properties: {
        action,
        dueAt: timestamp,
        displayTimezone: string,
        expiresAt: timestamp,
        idempotencyKey: string,
        reason: string,
      },
      required: ['action', 'dueAt', 'displayTimezone', 'idempotencyKey'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_project_schedules',
    description:
      'List persisted project schedules and their resulting event, delivery and task identities. Optional sessionId includes creator and message target.',
    inputSchema: {
      type: 'object',
      properties: { cursor: string, limit: timestamp, sessionId: string },
      additionalProperties: false,
    },
  },
  {
    name: 'get_project_schedule',
    description:
      'Inspect one schedule, including pending, admitted, expired, failed or ambiguous status. Admitted means durable intent accepted; it does not prove the model executed.',
    inputSchema: {
      type: 'object',
      properties: { scheduleId: string },
      required: ['scheduleId'],
      additionalProperties: false,
    },
  },
  {
    name: 'reschedule_project_schedule',
    description:
      'Reschedule a pending action using the version returned by get_project_schedule. Concurrent changes conflict; already admitted actions cannot be moved.',
    inputSchema: {
      type: 'object',
      properties: {
        scheduleId: string,
        expectedVersion: timestamp,
        dueAt: timestamp,
        expiresAt: timestamp,
        displayTimezone: string,
      },
      required: ['scheduleId', 'expectedVersion', 'dueAt'],
      additionalProperties: false,
    },
  },
  {
    name: 'cancel_project_schedule',
    description:
      'Cancel a schedule by version before action admission. An already admitted action is not retracted; the response explicitly reports this boundary.',
    inputSchema: {
      type: 'object',
      properties: { scheduleId: string, expectedVersion: timestamp, reason: string },
      required: ['scheduleId', 'expectedVersion'],
      additionalProperties: false,
    },
  },
  {
    name: 'reconcile_project_schedule',
    description:
      'Observe canonical task or delivery receipts after exhausted retries. Default receipt-only reconciliation never wakes compute or replays messages. Explicit retrySubmission reopens bounded task submission only when eligible, using the original identities and deadline. Unknown receipts retain standing-watch concurrency. Requires the current expectedVersion.',
    inputSchema: {
      type: 'object',
      properties: { scheduleId: string, expectedVersion: timestamp, retrySubmission: { type: 'boolean' } },
      required: ['scheduleId', 'expectedVersion'],
      additionalProperties: false,
    },
  },
];
