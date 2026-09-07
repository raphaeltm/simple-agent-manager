import type { ProjectEventFilterV1 } from './project-events';

export type ProjectScheduledAction =
  | { kind: 'message_session'; sessionId: string; prompt: string }
  | {
      kind: 'start_session';
      prompt: string;
      agentProfileId: string | null;
      skillId: string | null;
    };

export type ProjectScheduleState =
  | 'pending'
  | 'processing'
  | 'admitted'
  | 'cancelled'
  | 'expired'
  | 'failed'
  | 'ambiguous';

/** All timestamps are UTC epoch milliseconds; version is a positive integer. */
export type ProjectSchedule = {
  id: string;
  projectId: string;
  creatorUserId: string;
  creatorChatSessionId: string | null;
  reason: string | null;
  action: ProjectScheduledAction;
  state: ProjectScheduleState;
  dueAt: number;
  displayTimezone: string;
  expiresAt: number;
  version: number;
  idempotencyKey: string;
  createdAt: number;
  updatedAt: number;
  nextAttemptAt: number | null;
  attemptCount: number;
  lastError: string | null;
  eventId: string | null;
  deliveryId: string | null;
  resultTaskId: string | null;
  resultSessionId: string | null;
  watchId: string | null;
  sourceEventId: string | null;
};

export type CreateProjectScheduleRequest = {
  action: ProjectScheduledAction;
  dueAt: number;
  displayTimezone: string;
  expiresAt?: number;
  idempotencyKey: string;
  reason?: string | null;
};

export type RescheduleProjectScheduleRequest = {
  expectedVersion: number;
  dueAt: number;
  expiresAt?: number;
  displayTimezone?: string;
};

export type CancelProjectScheduleRequest = {
  expectedVersion: number;
  reason?: string | null;
};

export type ProjectScheduleList = {
  schedules: ProjectSchedule[];
  nextCursor: string | null;
};

export type ProjectScheduleMutationResult = {
  schedule: ProjectSchedule;
  changed: boolean;
  idempotent: boolean;
  /** Cancellation cannot retract an action that has already been admitted. */
  actionAlreadyAdmitted: boolean;
};

export type ProjectStandingWatchState = 'active' | 'paused' | 'revoked';

/** Project-owned policy with finite execution, concurrency and cooldown controls. */
export type ProjectStandingWatch = {
  id: string;
  projectId: string;
  creatorUserId: string;
  reason: string | null;
  filter: ProjectEventFilterV1;
  action: ProjectScheduledAction;
  state: ProjectStandingWatchState;
  version: number;
  idempotencyKey: string;
  cooldownMs: number;
  maxConcurrent: number;
  maxExecutions: number;
  executionCount: number;
  nextEligibleAt: number;
  subscriptionId: string;
  createdAt: number;
  updatedAt: number;
  lastError: string | null;
};

export type CreateProjectStandingWatchRequest = {
  filter: ProjectEventFilterV1;
  action: ProjectScheduledAction;
  idempotencyKey: string;
  reason?: string | null;
  cooldownMs?: number;
  maxConcurrent?: number;
  maxExecutions?: number;
};

export type UpdateProjectStandingWatchRequest = {
  expectedVersion: number;
  filter?: ProjectEventFilterV1;
  action?: ProjectScheduledAction;
  reason?: string | null;
  cooldownMs?: number;
  maxConcurrent?: number;
  maxExecutions?: number;
};

/** Set paused to false to resume an existing, non-revoked watch. */
export type PauseProjectStandingWatchRequest = {
  expectedVersion: number;
  paused: boolean;
  reason?: string | null;
};

export type RevokeProjectStandingWatchRequest = {
  expectedVersion: number;
  reason?: string | null;
};

export type ProjectStandingWatchList = {
  watches: ProjectStandingWatch[];
  nextCursor: string | null;
};

export type ProjectStandingWatchMutationResult = {
  watch: ProjectStandingWatch;
  changed: boolean;
  idempotent: boolean;
};
