export const PROJECT_EVENT_CONTRACT_VERSION = 1;
export const PROJECT_EVENT_FILTER_VERSION = 1;

export const PROJECT_EVENT_SEVERITIES = [
  'debug',
  'info',
  'notice',
  'warning',
  'error',
  'critical',
] as const;

export type ProjectEventSeverity = (typeof PROJECT_EVENT_SEVERITIES)[number];

export const PROJECT_EVENT_FILTER_FIELDS = [
  'source',
  'eventType',
  'subjectType',
  'subjectId',
  'severity',
] as const;

export type ProjectEventFilterField = (typeof PROJECT_EVENT_FILTER_FIELDS)[number];

export type ProjectEventFilterV1 = {
  version: typeof PROJECT_EVENT_FILTER_VERSION;
  source?: string | string[];
  eventType?: string | string[];
  subjectType?: string | string[];
  subjectId?: string | string[];
  severity?: ProjectEventSeverity | ProjectEventSeverity[];
};

export type ProjectEventSubject = {
  type: string;
  id: string;
};

export type ProjectEventRawPayloadRef = {
  provider?: string | null;
  uri: string;
  contentHash?: string | null;
};

export type ProjectEventDisplayData = {
  title?: string;
  summary?: string;
  url?: string;
  labels?: string[];
  untrusted: true;
};

export type ProjectEventJsonPrimitive = string | number | boolean | null;
export type ProjectEventJsonValue =
  | ProjectEventJsonPrimitive
  | ProjectEventJsonValue[]
  | { [key: string]: ProjectEventJsonValue };
export type ProjectEventMetadata = { [key: string]: ProjectEventJsonValue };

export type ProjectEventRecordState = 'recorded' | 'conflicted';

export type ProjectEventRecord = {
  id: string;
  projectId: string;
  contractVersion: typeof PROJECT_EVENT_CONTRACT_VERSION;
  source: string;
  eventType: string;
  subject: ProjectEventSubject;
  severity: ProjectEventSeverity;
  deliveryKey: string;
  payloadFingerprint: string;
  metadata: ProjectEventMetadata;
  display: ProjectEventDisplayData;
  rawPayloadRef: ProjectEventRawPayloadRef | null;
  occurredAt: number;
  receivedAt: number;
  updatedAt: number;
  state: ProjectEventRecordState;
  duplicateCount: number;
  conflictCount: number;
  conflictFingerprint: string | null;
  conflictDetectedAt: number | null;
};

export type AdmitProjectEventInput = {
  projectId: string;
  source: string;
  eventType: string;
  subject: ProjectEventSubject;
  severity?: ProjectEventSeverity;
  deliveryKey: string;
  payloadFingerprint: string;
  metadata?: ProjectEventMetadata;
  display?: Partial<Omit<ProjectEventDisplayData, 'untrusted'>>;
  rawPayloadRef?: ProjectEventRawPayloadRef | null;
  occurredAt?: number;
  receivedAt?: number;
};

export type ProjectEventAdmissionOutcome = 'created' | 'duplicate_replay' | 'conflict';

export type ProjectEventAdmissionResult = {
  outcome: ProjectEventAdmissionOutcome;
  event: ProjectEventRecord;
  matches: ProjectEventMatchRecord[];
  conflict?: {
    deliveryKey: string;
    existingFingerprint: string;
    incomingFingerprint: string;
  };
};

export const PROJECT_EVENT_SUBSCRIPTION_OWNER_TYPES = [
  'human',
  'agent',
  'system',
  'policy',
  'standing_watch',
] as const;

export type ProjectEventSubscriptionOwnerType =
  (typeof PROJECT_EVENT_SUBSCRIPTION_OWNER_TYPES)[number];

export type ProjectEventSubscriptionOwner = {
  type: ProjectEventSubscriptionOwnerType;
  id: string;
  name?: string | null;
};

export const PROJECT_EVENT_REQUESTED_DELIVERY_MODES = [
  'record_only',
  'existing_session_prompt',
  'runtime_steer',
  'runtime_interrupt',
  'spawn_task',
] as const;

export type ProjectEventRequestedDeliveryMode =
  (typeof PROJECT_EVENT_REQUESTED_DELIVERY_MODES)[number];

export const PROJECT_EVENT_RESOLVED_DELIVERY_MODES = [
  'record_only',
  'recorded_not_injected',
  'queued_for_prompt_delivery',
  'runtime_steer',
  'runtime_interrupt',
  'spawn_task',
  'unsupported',
  'unauthorized',
] as const;

export type ProjectEventResolvedDeliveryMode =
  (typeof PROJECT_EVENT_RESOLVED_DELIVERY_MODES)[number];

export type ProjectEventDeliveryPreference = {
  requested: ProjectEventRequestedDeliveryMode;
  resolved: ProjectEventResolvedDeliveryMode;
  target?: {
    sessionId?: string | null;
    taskId?: string | null;
    runtimeId?: string | null;
    agentId?: string | null;
  };
};

export const PROJECT_EVENT_DELIVERY_CAPABILITY_MODES = [
  'record_only',
  'durable_prompt_queue',
  'runtime_steer',
  'runtime_interrupt',
  'spawn_task',
] as const;

export type ProjectEventDeliveryCapabilityMode =
  (typeof PROJECT_EVENT_DELIVERY_CAPABILITY_MODES)[number];

export const PROJECT_EVENT_DELIVERY_ADAPTER_KINDS = [
  'record',
  'durable_queue',
  'runtime_acp',
  'runtime_native',
  'claude_channel',
  'task_spawn',
] as const;

export type ProjectEventDeliveryAdapterKind = (typeof PROJECT_EVENT_DELIVERY_ADAPTER_KINDS)[number];

export type ProjectEventDeliveryAdapterVersionGate = {
  dependencyName?: string | null;
  currentVersion?: string | null;
  minimumVersion?: string | null;
  satisfied: boolean;
};

export type ProjectEventDeliveryAdapterCapability = {
  adapterId: string;
  adapterKind: ProjectEventDeliveryAdapterKind;
  agentType?: string | null;
  protocol?: string | null;
  protocolVersion?: string | null;
  capabilities: ProjectEventDeliveryCapabilityMode[];
  durableAck: boolean;
  available: boolean;
  versionGate?: ProjectEventDeliveryAdapterVersionGate | null;
};

export type ProjectEventDeliveryAuthorization = {
  allowPromptQueue: boolean;
  allowRuntimeSteer: boolean;
  allowRuntimeInterrupt: boolean;
  allowTaskSpawn: boolean;
};

export const PROJECT_EVENT_DELIVERY_TARGET_STATES = [
  'active',
  'busy',
  'idle',
  'unknown',
  'terminal',
] as const;

export type ProjectEventDeliveryTargetState = (typeof PROJECT_EVENT_DELIVERY_TARGET_STATES)[number];

export const PROJECT_EVENT_DELIVERY_ADAPTER_ACTIONS = [
  'record_only',
  'recorded_not_injected',
  'queue_prompt_delivery',
  'runtime_steer',
  'runtime_interrupt',
  'spawn_task',
  'unsupported',
  'unauthorized',
] as const;

export type ProjectEventDeliveryAdapterAction =
  (typeof PROJECT_EVENT_DELIVERY_ADAPTER_ACTIONS)[number];

export const PROJECT_EVENT_DELIVERY_RESOLUTION_REASONS = [
  'record_only_requested',
  'adapter_supported',
  'queue_fallback',
  'recorded_not_injected_baseline',
  'unsupported_delivery',
  'unauthorized_delivery',
  'target_terminal',
  'subscription_inactive',
  'ambiguous_delivery',
] as const;

export type ProjectEventDeliveryResolutionReason =
  (typeof PROJECT_EVENT_DELIVERY_RESOLUTION_REASONS)[number];

export type ProjectEventDeliveryAdapterDecision = {
  action: ProjectEventDeliveryAdapterAction;
  reason: ProjectEventDeliveryResolutionReason;
  adapterId: string | null;
  adapterKind: ProjectEventDeliveryAdapterKind | null;
  capability: ProjectEventDeliveryCapabilityMode | null;
  agentType: string | null;
  protocol: string | null;
  protocolVersion: string | null;
  durableAck: boolean;
  supported: boolean;
  authorized: boolean;
  terminal: boolean;
};

export type ProjectEventDeliverySummaryEvent = {
  id: string;
  source: string;
  eventType: string;
  subject: ProjectEventSubject;
  severity: ProjectEventSeverity;
  display: ProjectEventDisplayData;
  occurredAt: number;
  receivedAt: number;
};

export type ProjectEventDeliveryModelSummary = {
  version: typeof PROJECT_EVENT_CONTRACT_VERSION;
  eventCount: number;
  events: ProjectEventDeliverySummaryEvent[];
  truncated: boolean;
};

export type ProjectEventDeliveryResolution = {
  requestedDelivery: ProjectEventRequestedDeliveryMode;
  resolvedDelivery: ProjectEventResolvedDeliveryMode;
  batchState: ProjectEventDeliveryBatchState;
  target: NonNullable<ProjectEventDeliveryPreference['target']>;
  adapterDecision: ProjectEventDeliveryAdapterDecision;
  terminalReason: string | null;
  modelVisibleSummary: ProjectEventDeliveryModelSummary;
};

export const PROJECT_EVENT_SUBSCRIPTION_STATES = ['active', 'cancelled', 'expired'] as const;
export type ProjectEventSubscriptionState = (typeof PROJECT_EVENT_SUBSCRIPTION_STATES)[number];

export type ProjectEventSubscriptionRecord = {
  id: string;
  projectId: string;
  contractVersion: typeof PROJECT_EVENT_CONTRACT_VERSION;
  owner: ProjectEventSubscriptionOwner;
  idempotencyKey: string;
  filter: ProjectEventFilterV1;
  filterFingerprint: string;
  matchKeyCount: number;
  deliveryPreference: ProjectEventDeliveryPreference;
  state: ProjectEventSubscriptionState;
  reason: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  cancelledAt: number | null;
  cancelledBy: ProjectEventSubscriptionOwner | null;
  cancelReason: string | null;
  lastMatchedAt: number | null;
};

export type ProjectEventSubscriptionMutationResult = {
  subscription: ProjectEventSubscriptionRecord;
  idempotent: boolean;
  changed: boolean;
};

export type CreateProjectEventSubscriptionInput = {
  projectId: string;
  owner: ProjectEventSubscriptionOwner;
  idempotencyKey: string;
  filter: ProjectEventFilterV1;
  deliveryPreference: ProjectEventDeliveryPreference;
  reason?: string | null;
  expiresAt?: number | null;
};

export type ListProjectEventSubscriptionsInput = {
  projectId: string;
  state?: ProjectEventSubscriptionState | 'any' | null;
  owner?: ProjectEventSubscriptionOwner | null;
  limit?: number | null;
};

export type GetProjectEventSubscriptionInput = {
  projectId: string;
  subscriptionId: string;
};

export type CancelProjectEventSubscriptionInput = {
  projectId: string;
  subscriptionId: string;
  cancelledBy: ProjectEventSubscriptionOwner;
  reason?: string | null;
};

export type ExpireProjectEventSubscriptionsInput = {
  projectId: string;
  now?: number;
  limit?: number | null;
};

export type ProjectEventExpireSubscriptionsResult = {
  expired: number;
};

export type ProjectEventSubscriptionListResult = {
  subscriptions: ProjectEventSubscriptionRecord[];
  hasMore: boolean;
};

export type ProjectEventMatchState =
  | 'matched'
  | 'batch_created'
  | 'recorded_not_injected'
  | 'expired'
  | 'cancelled';

export type ProjectEventMatchRecord = {
  id: string;
  projectId: string;
  eventId: string;
  subscriptionId: string;
  state: ProjectEventMatchState;
  matchedAt: number;
  lifecycleCheckedAt: number;
  batchId: string | null;
  reason: string | null;
};

export const PROJECT_EVENT_DELIVERY_BATCH_STATES = [
  'pending',
  'recorded_not_injected',
  'delivered',
  'acked',
  'failed',
  'ambiguous',
  'expired',
  'cancelled',
] as const;

export type ProjectEventDeliveryBatchState = (typeof PROJECT_EVENT_DELIVERY_BATCH_STATES)[number];

export type ProjectEventDeliveryBatchRecord = {
  id: string;
  projectId: string;
  subscriptionId: string;
  idempotencyKey: string;
  state: ProjectEventDeliveryBatchState;
  ackRequired: boolean;
  requestedDelivery: ProjectEventRequestedDeliveryMode;
  resolvedDelivery: ProjectEventResolvedDeliveryMode;
  adapterDecision: ProjectEventDeliveryAdapterDecision;
  target: NonNullable<ProjectEventDeliveryPreference['target']>;
  matchIds: string[];
  eventCount: number;
  createdAt: number;
  updatedAt: number;
  deliveredAt: number | null;
  ackedAt: number | null;
  ackedBy: ProjectEventSubscriptionOwner | null;
  terminalAt: number | null;
  terminalReason: string | null;
};

export type ProjectEventDeliveryBatchMutationResult = {
  batch: ProjectEventDeliveryBatchRecord;
  idempotent: boolean;
  changed: boolean;
};

export type CreateProjectEventDeliveryBatchInput = {
  projectId: string;
  subscriptionId: string;
  matchIds: string[];
  idempotencyKey: string;
  requestedDelivery?: ProjectEventRequestedDeliveryMode | null;
  resolvedDelivery?: ProjectEventResolvedDeliveryMode | null;
  target?: NonNullable<ProjectEventDeliveryPreference['target']>;
  adapterCapabilities?: ProjectEventDeliveryAdapterCapability[] | null;
  authorization?: Partial<ProjectEventDeliveryAuthorization> | null;
  targetState?: ProjectEventDeliveryTargetState | null;
  targetTerminalReason?: string | null;
  terminalReason?: string | null;
};

export type ListProjectEventDeliveryBatchesInput = {
  projectId: string;
  subscriptionId?: string | null;
  state?: ProjectEventDeliveryBatchState | 'any' | null;
  limit?: number | null;
};

export type ProjectEventDeliveryBatchListResult = {
  batches: ProjectEventDeliveryBatchRecord[];
  hasMore: boolean;
};

export type ProjectEventAgentVisibility = {
  owner: ProjectEventSubscriptionOwner;
  target: NonNullable<ProjectEventDeliveryPreference['target']>;
};

export type ProjectEventPullDeliveryInfo = {
  id: string;
  subscriptionId: string;
  state: ProjectEventDeliveryBatchState;
  ackRequired: boolean;
  requestedDelivery: ProjectEventRequestedDeliveryMode;
  resolvedDelivery: ProjectEventResolvedDeliveryMode;
  createdAt: number;
  deliveredAt: number | null;
  acknowledgedAt: number | null;
};

export type ProjectEventPullDeliveryRecord = ProjectEventPullDeliveryInfo & {
  eventId: string | null;
  eventIds: string[];
};

export type ProjectEventSubscriptionEventSummary = Pick<
  ProjectEventRecord,
  | 'id'
  | 'source'
  | 'eventType'
  | 'subject'
  | 'severity'
  | 'metadata'
  | 'display'
  | 'occurredAt'
  | 'receivedAt'
> & {
  matchId: string;
  payloadRefAvailable: boolean;
  delivery: ProjectEventPullDeliveryInfo;
};

export type ProjectEventSubscriptionEvent = ProjectEventSubscriptionEventSummary &
  Pick<
    ProjectEventRecord,
    | 'projectId'
    | 'contractVersion'
    | 'deliveryKey'
    | 'payloadFingerprint'
    | 'rawPayloadRef'
    | 'updatedAt'
    | 'state'
    | 'duplicateCount'
    | 'conflictCount'
    | 'conflictFingerprint'
    | 'conflictDetectedAt'
  >;

export type ListProjectEventSubscriptionEventsInput = {
  projectId: string;
  subscriptionId: string;
  visibility: ProjectEventAgentVisibility;
  limit?: number | null;
  cursor?: string | null;
  cursorMaxLength?: number | null;
};

export type ProjectEventSubscriptionEventListResult = {
  subscriptionId: string;
  events: ProjectEventSubscriptionEventSummary[];
  nextCursor: string | null;
  hasMore: boolean;
};

export type GetProjectEventInput = {
  projectId: string;
  eventId: string;
  visibility: ProjectEventAgentVisibility;
};

export type AckProjectEventDeliveryInput = {
  projectId: string;
  deliveryId: string;
  visibility: ProjectEventAgentVisibility;
  acknowledgedBy: ProjectEventSubscriptionOwner;
};

export type ProjectEventDeliveryAckResult = {
  acknowledged: true;
  idempotent: boolean;
  delivery: ProjectEventPullDeliveryRecord;
};

export const PROJECT_EVENT_DELIVERY_ATTEMPT_STATES = [
  'recorded_not_injected',
  'accepted',
  'retry',
  'failed',
  'ambiguous',
] as const;

export type ProjectEventDeliveryAttemptState =
  (typeof PROJECT_EVENT_DELIVERY_ATTEMPT_STATES)[number];

export type ProjectEventDeliveryAttemptRecord = {
  id: string;
  projectId: string;
  batchId: string;
  idempotencyKey: string;
  attemptNumber: number;
  state: ProjectEventDeliveryAttemptState;
  adapter: string | null;
  protocolVersion: string | null;
  runtimeId: string | null;
  receiptId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: number;
  completedAt: number | null;
  createdAt: number;
};

export type ProjectEventDeliveryAttemptMutationResult = {
  attempt: ProjectEventDeliveryAttemptRecord;
  batch: ProjectEventDeliveryBatchRecord;
  idempotent: boolean;
  changed: boolean;
};

export type RecordProjectEventDeliveryAttemptInput = {
  projectId: string;
  batchId: string;
  idempotencyKey: string;
  state: ProjectEventDeliveryAttemptState;
  adapter?: string | null;
  protocolVersion?: string | null;
  runtimeId?: string | null;
  receiptId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  startedAt?: number;
  completedAt?: number | null;
};

export type ListProjectEventDeliveryAttemptsInput = {
  projectId: string;
  batchId?: string | null;
  state?: ProjectEventDeliveryAttemptState | 'any' | null;
  limit?: number | null;
};

export type ProjectEventDeliveryAttemptListResult = {
  attempts: ProjectEventDeliveryAttemptRecord[];
  hasMore: boolean;
};

export type ProjectEventStorageAccountingRecord = {
  projectId: string;
  category: string;
  recordCount: number;
  estimatedBytes: number;
  oldestCreatedAt: number | null;
  newestCreatedAt: number | null;
  measuredAt: number;
};

export type ProjectEventRetentionResult = {
  deletedEvents: number;
  deletedMatches: number;
  deletedBatches: number;
  deletedAttempts: number;
  expiredSubscriptions: number;
  accounting: ProjectEventStorageAccountingRecord[];
};

export type RunProjectEventRetentionInput = {
  projectId: string;
  now?: number;
  limit?: number | null;
};

export type GetProjectEventRecentStatusInput = {
  projectId: string;
  limit?: number | null;
};

export type ProjectEventRecentStatus = {
  projectId: string;
  events: ProjectEventRecord[];
  matches: ProjectEventMatchRecord[];
  batches: ProjectEventDeliveryBatchRecord[];
  attempts: ProjectEventDeliveryAttemptRecord[];
  accounting: ProjectEventStorageAccountingRecord[];
  hasMore: boolean;
};

export type ProjectEventLimits = {
  maxActiveSubscriptionsPerProject: number;
  maxFilterValuesPerField: number;
  maxFilterMatchKeysPerSubscription: number;
  maxFilterStringBytes: number;
  maxMetadataBytes: number;
  maxMetadataDepth: number;
  maxMetadataKeys: number;
  maxMetadataArrayItems: number;
  maxDisplayBytes: number;
  maxDisplayLabels: number;
  maxRawPayloadRefBytes: number;
  maxReasonBytes: number;
  maxMatchesPerEvent: number;
  maxDeliveryBatchEvents: number;
  maxAttemptsPerBatch: number;
  listLimitDefault: number;
  listLimitMax: number;
  subscriptionEventCursorMaxLength: number;
  recentStatusLimit: number;
  retentionDays: number;
  retentionBatchRows: number;
};
