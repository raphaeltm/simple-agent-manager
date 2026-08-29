export type {
  AckProjectEventDeliveryInput,
  AdmitProjectEventInput,
  CancelProjectEventSubscriptionInput,
  CreateProjectEventDeliveryBatchInput,
  CreateProjectEventSubscriptionInput,
  ExpireProjectEventSubscriptionsInput,
  GetProjectEventInput,
  GetProjectEventRecentStatusInput,
  GetProjectEventSubscriptionInput,
  ListProjectEventDeliveryAttemptsInput,
  ListProjectEventDeliveryBatchesInput,
  ListProjectEventSubscriptionEventsInput,
  ListProjectEventSubscriptionsInput,
  ProjectEventAdmissionResult,
  ProjectEventDeliveryAckResult,
  ProjectEventDeliveryAdapterAction,
  ProjectEventDeliveryAdapterCapability,
  ProjectEventDeliveryAdapterDecision,
  ProjectEventDeliveryAdapterKind,
  ProjectEventDeliveryAdapterVersionGate,
  ProjectEventDeliveryAttemptListResult,
  ProjectEventDeliveryAttemptMutationResult,
  ProjectEventDeliveryAuthorization,
  ProjectEventDeliveryBatchListResult,
  ProjectEventDeliveryBatchMutationResult,
  ProjectEventDeliveryCapabilityMode,
  ProjectEventDeliveryModelSummary,
  ProjectEventDeliveryResolution,
  ProjectEventDeliveryResolutionReason,
  ProjectEventDeliverySummaryEvent,
  ProjectEventDeliveryTargetState,
  ProjectEventExpireSubscriptionsResult,
  ProjectEventLimits,
  ProjectEventRecentStatus,
  ProjectEventRetentionResult,
  ProjectEventSubscriptionEvent,
  ProjectEventSubscriptionEventListResult,
  ProjectEventSubscriptionListResult,
  ProjectEventSubscriptionMutationResult,
  RecordProjectEventDeliveryAttemptInput,
  RunProjectEventRetentionInput,
} from '@simple-agent-manager/shared';

export const PROJECT_EVENT_NOT_FOUND = 'PROJECT_EVENT_NOT_FOUND';
export const PROJECT_EVENT_VALIDATION = 'PROJECT_EVENT_VALIDATION';
export const PROJECT_EVENT_IDEMPOTENCY_CONFLICT = 'PROJECT_EVENT_IDEMPOTENCY_CONFLICT';
export const PROJECT_EVENT_LIMIT_EXCEEDED = 'PROJECT_EVENT_LIMIT_EXCEEDED';
export const PROJECT_EVENT_CURSOR_INVALID = 'PROJECT_EVENT_CURSOR_INVALID';
export const PROJECT_EVENT_ACK_POLICY = 'PROJECT_EVENT_ACK_POLICY';
export const PROJECT_EVENT_ACK_STATE = 'PROJECT_EVENT_ACK_STATE';

export class ProjectEventNotFoundError extends Error {
  readonly code = PROJECT_EVENT_NOT_FOUND;

  constructor(
    readonly resource:
      | 'Project event'
      | 'Event subscription'
      | 'Event match'
      | 'Delivery batch'
      | 'Delivery attempt'
  ) {
    super(`${resource} not found`);
    this.name = 'ProjectEventNotFoundError';
  }
}

export class ProjectEventValidationError extends Error {
  readonly code = PROJECT_EVENT_VALIDATION;

  constructor(message: string) {
    super(message);
    this.name = 'ProjectEventValidationError';
  }
}

export class ProjectEventIdempotencyConflictError extends Error {
  readonly code = PROJECT_EVENT_IDEMPOTENCY_CONFLICT;

  constructor(message = 'idempotency key belongs to a different event subscription mutation') {
    super(message);
    this.name = 'ProjectEventIdempotencyConflictError';
  }
}

export class ProjectEventLimitExceededError extends Error {
  readonly code = PROJECT_EVENT_LIMIT_EXCEEDED;

  constructor(message: string) {
    super(message);
    this.name = 'ProjectEventLimitExceededError';
  }
}

export class ProjectEventCursorError extends Error {
  readonly code = PROJECT_EVENT_CURSOR_INVALID;

  constructor(message = 'Invalid cursor') {
    super(message);
    this.name = 'ProjectEventCursorError';
  }
}

export class ProjectEventAckPolicyError extends Error {
  readonly code = PROJECT_EVENT_ACK_POLICY;

  constructor(message = 'Delivery does not require acknowledgement') {
    super(message);
    this.name = 'ProjectEventAckPolicyError';
  }
}

export class ProjectEventAckStateError extends Error {
  readonly code = PROJECT_EVENT_ACK_STATE;

  constructor(message = 'Delivery cannot be acknowledged in its current state') {
    super(message);
    this.name = 'ProjectEventAckStateError';
  }
}
