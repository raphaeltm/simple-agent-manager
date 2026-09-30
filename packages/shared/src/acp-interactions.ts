import * as v from 'valibot';

export const ACP_INTERACTION_PROTOCOL_VERSION = 1 as const;
export const ACP_INTERACTION_CAPABILITY_VERSION = 1 as const;

export const ACP_INTERACTION_ATTENTION_SOURCE = 'acp_interaction' as const;
export const ACP_INTERACTION_KIND_VALUES = ['permission', 'form', 'url'] as const;
export const ACP_INTERACTION_STATE_VALUES = [
  'pending',
  'answered',
  'delivery_confirmed',
  'delivery_unconfirmed',
  'interrupted',
  'expired',
  'cancelled',
] as const;
export const ACP_INTERACTION_DECISION_KIND_VALUES = [
  'selected_option',
  'accepted',
  'declined',
  'cancelled',
] as const;
export const ACP_INTERACTION_DELIVERY_OUTCOME_VALUES = [
  'consumed',
  'duplicate',
  'stale_generation',
  'no_waiter',
  'conflict',
  'unknown',
] as const;
export const ACP_RUNTIME_ANSWER_STATUS_VALUES = [
  'consumed',
  'duplicate',
  'stale_generation',
  'no_waiter',
  'conflict',
] as const;

export const DEFAULT_ACP_INTERACTIONS_ENABLED = false;
export const DEFAULT_ACP_INTERACTION_PERMISSION_CONVERSATION_DEADLINE_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_ACP_INTERACTION_PERMISSION_TASK_DEADLINE_MS = 30 * 60 * 1000;
export const DEFAULT_ACP_INTERACTION_MAX_DEADLINE_MS = 4 * 60 * 60 * 1000;
export const DEFAULT_ACP_INTERACTION_DEADLINE_MARGIN_MS = 60 * 1000;
export const DEFAULT_ACP_INTERACTION_MAX_PENDING_PER_SESSION = 8;
export const DEFAULT_ACP_INTERACTION_REQUEST_MAX_BYTES = 32 * 1024;
export const DEFAULT_ACP_INTERACTION_OPTIONS_MAX_COUNT = 16;
export const DEFAULT_ACP_INTERACTION_OPTION_ID_MAX_CHARS = 128;
export const DEFAULT_ACP_INTERACTION_OPTION_NAME_MAX_CHARS = 200;
export const DEFAULT_ACP_INTERACTION_FORM_SCHEMA_MAX_BYTES = 16 * 1024;
export const DEFAULT_ACP_INTERACTION_FORM_SCHEMA_MAX_PROPERTIES = 20;
export const DEFAULT_ACP_INTERACTION_FORM_SCHEMA_MAX_ENUM = 50;
export const DEFAULT_ACP_INTERACTION_ANSWER_MAX_BYTES = 16 * 1024;
export const DEFAULT_ACP_INTERACTION_ANSWER_STRING_MAX_BYTES = 4 * 1024;
export const DEFAULT_ACP_INTERACTION_RETRY_DELAYS_MS = [1000, 5000, 30000, 120000, 300000] as const;
export const DEFAULT_ACP_INTERACTION_RETRY_STEADY_MS = 300000;
export const DEFAULT_ACP_INTERACTION_DELIVERY_WINDOW_MS = 15 * 60 * 1000;
export const DEFAULT_ACP_INTERACTION_SENSITIVE_PURGE_MS = 60 * 60 * 1000;
export const DEFAULT_ACP_INTERACTION_SUMMARY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_ACP_INTERACTION_SUMMARY_LAST_SETTLED = 100;
export const DEFAULT_ACP_INTERACTION_SNAPSHOT_LAST_SETTLED = 20;
export const DEFAULT_ACP_INTERACTION_EXPIRY_BATCH_SIZE = 25;
export const DEFAULT_ACP_INTERACTION_OUTBOX_BATCH_SIZE = 25;
export const DEFAULT_ACP_INTERACTION_DELIVERY_BATCH_SIZE = 1;
export const DEFAULT_ACP_INTERACTION_ALARM_WALL_TIME_MS = 15_000;
export const DEFAULT_ACP_INTERACTION_ALARM_REARM_DELAY_MS = 1_000;
export const DEFAULT_ACP_INTERACTION_RUNTIME_RECEIPT_LIMIT = 256;

export const AcpInteractionIdSchema = v.pipe(v.string(), v.uuid());
export const AcpInteractionGenerationSchema = v.pipe(v.string(), v.uuid());
export const AcpInteractionHashSchema = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u));
export const AcpInteractionKeySchema = v.pipe(v.string(), v.minLength(1), v.maxLength(128));

export const AcpInteractionKindSchema = v.picklist(ACP_INTERACTION_KIND_VALUES);
export const AcpInteractionStateSchema = v.picklist(ACP_INTERACTION_STATE_VALUES);
export const AcpInteractionDecisionKindSchema = v.picklist(ACP_INTERACTION_DECISION_KIND_VALUES);
export const AcpRuntimeAnswerStatusSchema = v.picklist(ACP_RUNTIME_ANSWER_STATUS_VALUES);

export const AcpInteractionOptionSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
  kind: v.picklist(['allow_once', 'allow_always', 'reject_once', 'reject_always', 'custom']),
  name: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(DEFAULT_ACP_INTERACTION_OPTION_NAME_MAX_CHARS)
  ),
});

export const AcpInteractionSafeSummarySchema = v.object({
  interactionId: AcpInteractionIdSchema,
  kind: AcpInteractionKindSchema,
  state: AcpInteractionStateSchema,
  createdAt: v.number(),
  updatedAt: v.number(),
  deadlineAt: v.number(),
  answeredAt: v.nullable(v.number()),
  deliveryState: v.nullable(v.picklist(['pending', 'confirmed', 'unconfirmed', 'interrupted'])),
  attentionMarkerId: v.nullable(v.string()),
  toolCallId: v.nullable(v.string()),
});

export const AcpInteractionEncryptedPayloadSchema = v.object({
  ciphertext: v.string(),
  iv: v.string(),
});

export const AcpInteractionRuntimeCreateSchema = v.object({
  protocolVersion: v.literal(ACP_INTERACTION_PROTOCOL_VERSION),
  interactionId: AcpInteractionIdSchema,
  generation: AcpInteractionGenerationSchema,
  runtimeIdentity: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
  agentSessionId: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  kind: AcpInteractionKindSchema,
  payloadHash: AcpInteractionHashSchema,
  detail: v.unknown(),
  safeSummary: v.object({
    toolCallId: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(256)))),
    optionCount: v.optional(v.number()),
  }),
  deadlineAt: v.number(),
  upstreamRequestId: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(256)))),
});

export const AcpInteractionRuntimeSettleSchema = v.object({
  protocolVersion: v.literal(ACP_INTERACTION_PROTOCOL_VERSION),
  interactionId: AcpInteractionIdSchema,
  generation: AcpInteractionGenerationSchema,
  runtimeIdentity: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
  agentSessionId: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  reason: v.picklist([
    'wrapper_cancelled',
    'connection_closed',
    'connection_replaced',
    'session_stopped',
    'expired',
    'completed',
  ]),
});

export const AcpInteractionAnswerDecisionSchema = v.object({
  kind: AcpInteractionDecisionKindSchema,
  optionId: v.optional(v.string()),
  encryptedAnswer: v.optional(AcpInteractionEncryptedPayloadSchema),
  answerHash: AcpInteractionHashSchema,
});

export const AcpInteractionBrowserAnswerSchema = v.object({
  answerKey: AcpInteractionKeySchema,
  decision: AcpInteractionAnswerDecisionSchema,
});

export const AcpRuntimeAnswerRequestSchema = v.object({
  protocolVersion: v.literal(ACP_INTERACTION_PROTOCOL_VERSION),
  interactionId: AcpInteractionIdSchema,
  generation: AcpInteractionGenerationSchema,
  runtimeIdentity: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
  decision: AcpInteractionAnswerDecisionSchema,
});

export const AcpRuntimeAnswerResponseSchema = v.object({
  status: AcpRuntimeAnswerStatusSchema,
  interactionId: AcpInteractionIdSchema,
  generation: AcpInteractionGenerationSchema,
  runtimeIdentity: v.string(),
});

export const AcpInteractionRuntimeConfigSchema = v.object({
  enabled: v.boolean(),
  protocolVersion: v.literal(ACP_INTERACTION_PROTOCOL_VERSION),
  permissionDeadlineMs: v.pipe(v.number(), v.integer(), v.minValue(1)),
  maxDeadlineMs: v.pipe(v.number(), v.integer(), v.minValue(1)),
  deadlineMarginMs: v.pipe(v.number(), v.integer(), v.minValue(0)),
  requestMaxBytes: v.pipe(v.number(), v.integer(), v.minValue(1)),
  optionsMaxCount: v.pipe(v.number(), v.integer(), v.minValue(1)),
  optionIdMaxChars: v.pipe(v.number(), v.integer(), v.minValue(1)),
  optionNameMaxChars: v.pipe(v.number(), v.integer(), v.minValue(1)),
  receiptLimit: v.pipe(v.number(), v.integer(), v.minValue(1)),
  settleRetryDelaysMs: v.array(v.pipe(v.number(), v.integer(), v.minValue(0))),
  settleRetrySteadyMs: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

export type AcpInteractionKind = v.InferOutput<typeof AcpInteractionKindSchema>;
export type AcpInteractionState = v.InferOutput<typeof AcpInteractionStateSchema>;
export type AcpInteractionSafeSummary = v.InferOutput<typeof AcpInteractionSafeSummarySchema>;
export type AcpInteractionRuntimeCreate = v.InferOutput<typeof AcpInteractionRuntimeCreateSchema>;
export type AcpInteractionRuntimeSettle = v.InferOutput<typeof AcpInteractionRuntimeSettleSchema>;
export type AcpInteractionAnswerDecision = v.InferOutput<typeof AcpInteractionAnswerDecisionSchema>;
export type AcpInteractionBrowserAnswer = v.InferOutput<typeof AcpInteractionBrowserAnswerSchema>;
export type AcpRuntimeAnswerRequest = v.InferOutput<typeof AcpRuntimeAnswerRequestSchema>;
export type AcpRuntimeAnswerResponse = v.InferOutput<typeof AcpRuntimeAnswerResponseSchema>;
export type AcpInteractionRuntimeConfig = v.InferOutput<
  typeof AcpInteractionRuntimeConfigSchema
>;

export interface AcpInteractionCapabilities {
  version: typeof ACP_INTERACTION_CAPABILITY_VERSION;
  answerEndpoint: boolean;
  permissionBridge: boolean;
}

export function buildAcpInteractionAnswerPath(
  workspaceId: string,
  agentSessionId: string,
  interactionId: string
): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/agent-sessions/${encodeURIComponent(
    agentSessionId
  )}/interactions/${encodeURIComponent(interactionId)}/answer`;
}
