import type {
  AdmitProjectEventInput,
  CancelProjectEventSubscriptionInput,
  CreateProjectEventDeliveryBatchInput,
  CreateProjectEventSubscriptionInput,
  ExpireProjectEventSubscriptionsInput,
  GetProjectEventRecentStatusInput,
  GetProjectEventSubscriptionInput,
  ListProjectEventDeliveryAttemptsInput,
  ListProjectEventDeliveryBatchesInput,
  ListProjectEventSubscriptionsInput,
  ProjectEventAdmissionResult,
  ProjectEventDeliveryAttemptListResult,
  ProjectEventDeliveryAttemptMutationResult,
  ProjectEventDeliveryBatchListResult,
  ProjectEventDeliveryBatchMutationResult,
  ProjectEventExpireSubscriptionsResult,
  ProjectEventLimits,
  ProjectEventRecentStatus,
  ProjectEventRetentionResult,
  ProjectEventSubscriptionListResult,
  ProjectEventSubscriptionMutationResult,
  RecordProjectEventDeliveryAttemptInput,
  RunProjectEventRetentionInput,
} from '@simple-agent-manager/shared';

export type {
  AdmitProjectEventInput,
  CancelProjectEventSubscriptionInput,
  CreateProjectEventDeliveryBatchInput,
  CreateProjectEventSubscriptionInput,
  ExpireProjectEventSubscriptionsInput,
  GetProjectEventRecentStatusInput,
  GetProjectEventSubscriptionInput,
  ListProjectEventDeliveryAttemptsInput,
  ListProjectEventDeliveryBatchesInput,
  ListProjectEventSubscriptionsInput,
  ProjectEventAdmissionResult,
  ProjectEventDeliveryAttemptListResult,
  ProjectEventDeliveryAttemptMutationResult,
  ProjectEventDeliveryBatchListResult,
  ProjectEventDeliveryBatchMutationResult,
  ProjectEventExpireSubscriptionsResult,
  ProjectEventLimits,
  ProjectEventRecentStatus,
  ProjectEventRetentionResult,
  ProjectEventSubscriptionListResult,
  ProjectEventSubscriptionMutationResult,
  RecordProjectEventDeliveryAttemptInput,
  RunProjectEventRetentionInput,
};

export const PROJECT_EVENT_NOT_FOUND = 'PROJECT_EVENT_NOT_FOUND';
export const PROJECT_EVENT_VALIDATION = 'PROJECT_EVENT_VALIDATION';
export const PROJECT_EVENT_IDEMPOTENCY_CONFLICT = 'PROJECT_EVENT_IDEMPOTENCY_CONFLICT';
export const PROJECT_EVENT_LIMIT_EXCEEDED = 'PROJECT_EVENT_LIMIT_EXCEEDED';

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
