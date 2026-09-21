// FILE SIZE EXCEPTION: DO proxy service — splitting creates import complexity without meaningful benefit. See .claude/rules/18-file-size-limits.md
/**
 * Service layer for interacting with the per-project Durable Object.
 *
 * Provides typed wrapper methods that resolve the DO stub from a projectId
 * and forward calls to the ProjectData DO via RPC.
 *
 * See: specs/018-project-first-architecture/research.md (Decision 3)
 */
import type {
  AckProjectEventDeliveryInput,
  AdmitProjectEventInput,
  AgentMailboxMessage,
  CancelProjectEventSubscriptionInput,
  CatchUpProjectEventChannelInput,
  CheckpointEpisode,
  CheckpointEpisodeTransitionInput,
  CommentAuthor,
  CommentReply,
  CommentStatus,
  CreateCheckpointEpisodeInput,
  CreateProjectEventDeliveryBatchInput,
  CreateProjectEventSubscriptionInput,
  DeliveryState,
  ExpireProjectEventSubscriptionsInput,
  FollowProjectEventChannelInput,
  FollowProjectEventChannelResult,
  GetProjectEventInput,
  GetProjectEventRecentStatusInput,
  GetProjectEventSubscriptionInput,
  LibraryFileCommentMutationResponse,
  ListProjectEventChannelsInput,
  ListProjectEventDeliveryAttemptsInput,
  ListProjectEventDeliveryBatchesInput,
  ListProjectEventSubscriptionEventsInput,
  ListProjectEventSubscriptionsInput,
  MessageClass,
  MessageCommentListResponse,
  MessageCommentMutationResponse,
  MessageCommentReplyMutationResponse,
  MessageCommentThread,
  ProjectEventAdmissionResult,
  ProjectEventChannelHistory,
  ProjectEventChannelHistoryInput,
  ProjectEventChannelList,
  ProjectEventDeliveryAckResult,
  ProjectEventDeliveryAttemptListResult,
  ProjectEventDeliveryAttemptMutationResult,
  ProjectEventDeliveryBatchListResult,
  ProjectEventDeliveryBatchMutationResult,
  ProjectEventExpireSubscriptionsResult,
  ProjectEventRecentStatus,
  ProjectEventRetentionResult,
  ProjectEventSubscriptionEvent,
  ProjectEventSubscriptionEventListResult,
  ProjectEventSubscriptionListResult,
  ProjectEventSubscriptionMutationResult,
  PublishProjectEventChannelInput,
  PublishProjectEventChannelResult,
  RecordProjectEventDeliveryAttemptInput,
  RunProjectEventRetentionInput,
  SessionActivityTerminalReason,
} from '@simple-agent-manager/shared';
import { resolveHandoffLimits, resolveMissionStateLimits } from '@simple-agent-manager/shared';

import type { ProjectData } from '../durable-objects/project-data';
import type {
  CreateCommentReplyInput,
  CreateCommentThreadInput,
  CreateFileCommentReplyInput,
  CreateFileCommentThreadInput,
  ListCommentThreadsInput,
  ListFileCommentThreadsInput,
  ListFileCommentThreadsResult,
  ListProjectCommentThreadsInput,
  ProjectCommentInboxResult,
  UpdateCommentStatusInput,
  UpdateFileCommentStatusInput,
} from '../durable-objects/project-data/comment-contracts';
import {
  CommentNotFoundError,
  CommentValidationError,
} from '../durable-objects/project-data/comment-contracts';
import type { ProjectDataGroupedFtsCleanupResult } from '../durable-objects/project-data/grouped-fts-cleanup';
import {
  ProjectEventAckPolicyError,
  ProjectEventAckStateError,
  ProjectEventCursorError,
  ProjectEventIdempotencyConflictError,
  ProjectEventLimitExceededError,
  ProjectEventNotFoundError,
  ProjectEventValidationError,
} from '../durable-objects/project-data/project-events-contracts';
import type {
  ProjectDataStorageReliefMeasureInput,
  ProjectDataStorageReliefMeasureResult,
} from '../durable-objects/project-data/storage-relief-measurement';
import type {
  TerminalSessionReconciliationInput,
  TerminalSessionReconciliationStats,
} from '../durable-objects/project-data/terminal-session-reconciliation';
import type {
  ArchivedToolPayloadListResult,
  ArchivedToolPayloadQuery,
  MessageToolContentResult,
} from '../durable-objects/project-data/tool-payload-archive';
import {
  type ProjectDataManualToolPayloadCleanupInput,
  type ProjectDataManualToolPayloadCleanupResult,
  ProjectDataManualToolPayloadCleanupStateError,
} from '../durable-objects/project-data/tool-payload-cleanup-types';
export {
  CommentIdempotencyConflictError,
  CommentLimitExceededError,
  CommentNotFoundError,
  CommentValidationError,
} from '../durable-objects/project-data/comment-contracts';
export {
  ProjectEventAckPolicyError,
  ProjectEventAckStateError,
  ProjectEventCursorError,
  ProjectEventIdempotencyConflictError,
  ProjectEventLimitExceededError,
  ProjectEventNotFoundError,
  ProjectEventValidationError,
} from '../durable-objects/project-data/project-events-contracts';
import type { ValidateProjectEventWakeRecoveryAuthorityInput } from '../durable-objects/project-data/project-events-wake-delivery';
import type {
  AcceptedPromptDelivery,
  AcceptPromptDeliveryInput,
} from '../durable-objects/project-data/prompt-delivery';
import type {
  CreateReservedTaskSessionWithInitialMessageInput,
  CreateReservedTaskSessionWithInitialMessageResult,
  SessionIdentityGuard as ProjectDataSessionIdentityGuard,
} from '../durable-objects/project-data/sessions';
import type { RegisterTaskWaitInput } from '../durable-objects/project-data/task-waits';
import type { Env } from '../env';
import { log } from '../lib/logger';
import {
  PROJECT_DATA_ARCHIVE_DEFAULT_SEARCH_CONCURRENCY,
  PROJECT_DATA_ARCHIVE_DEFAULT_SEARCH_MAX_OWNERS,
  PROJECT_DATA_ARCHIVE_MAX_SEARCH_CONCURRENCY,
  PROJECT_DATA_ARCHIVE_MAX_SEARCH_OWNERS,
  PROJECT_DATA_ARCHIVE_ROUTING_SCHEMA_VERSION,
  type ProjectDataArchiveLocation,
  type ProjectDataArchiveOwnerRef,
} from '../project-data-archive/contract';
import {
  computeDurableObjectRetryDelayMs,
  getDurableObjectRetryConfig,
  isDurableObjectStorageFullError,
  isTransientDurableObjectError,
} from './durable-object-retry';
import {
  assertExactWriteAllowed,
  isProjectDataArchiveExactRoutingEnabled,
  resolveExactReadOwner,
} from './project-data-archive-routing';
import { ensureOncePerIsolate, forgetEnsuredProjectData } from './project-data-ensure-memo';
import { toProjectDataStorageFullError } from './project-data-storage-errors';
import {
  buildSessionLifecycleEventInput,
  type SessionLifecycleEventInput,
} from './project-lifecycle-event-inputs';
import { recordReservedTaskSessionRevocation } from './reserved-task-session-revocations';
import { hasAuthorizedRestorableSnapshotWakeClaim } from './session-snapshots';
import type { TaskAcpLivenessSignals } from './task-runtime-liveness';

export type { ProjectDataSessionIdentityGuard };

function rootExactReadOwner(projectId: string, sessionId: string): ProjectDataArchiveLocation {
  return {
    kind: 'root',
    projectId,
    sessionId,
    ownerName: projectId,
    generation: 0,
    state: 'root',
    migrationId: null,
    targetAggregateSha256: null,
    routingSchemaVersion: PROJECT_DATA_ARCHIVE_ROUTING_SCHEMA_VERSION,
  };
}

async function resolveExactReadOwnerIfArchiveEnabled(
  env: Env,
  projectId: string,
  sessionId: string
): Promise<ProjectDataArchiveLocation> {
  if (!isProjectDataArchiveExactRoutingEnabled(env))
    return rootExactReadOwner(projectId, sessionId);
  return resolveExactReadOwner(env, projectId, sessionId);
}

async function assertExactWriteAllowedIfArchiveEnabled(
  env: Env,
  projectId: string,
  sessionId: string,
  operation: string
): Promise<void> {
  if (!isProjectDataArchiveExactRoutingEnabled(env)) return;
  await assertExactWriteAllowed(env, projectId, sessionId, operation);
}

/**
 * Get a typed DO stub for the given project and ensure the DO knows its projectId.
 * Uses `idFromName(projectId)` for deterministic mapping.
 *
 * `ensureProjectId` stores the projectId in DO SQLite so that internal methods
 * like `syncSummaryToD1` — and every `alarm()`-driven sweep — can reference the
 * correct D1 row. This is necessary because `DurableObjectId.toString()` returns
 * a hex ID, not the original name, so the DO cannot derive its own projectId.
 *
 * The ensure is issued **once per (isolate, DO)** rather than before every call:
 * `do_meta` is durable and is never deleted, so repeating the RPC only bought a
 * second roundtrip per logical operation. See `project-data-ensure-memo.ts` for
 * the full justification and the list of consumers that depend on the stored id.
 */
async function getStubForOwner(
  env: Env,
  projectId: string,
  ownerName: string
): Promise<DurableObjectStub<ProjectData>> {
  const id = env.PROJECT_DATA.idFromName(ownerName);
  const stub = env.PROJECT_DATA.get(id) as DurableObjectStub<ProjectData>;
  await ensureOncePerIsolate(env, id.toString(), async () => {
    await stub.ensureProjectId(projectId);
  });
  return stub;
}

async function getStub(env: Env, projectId: string): Promise<DurableObjectStub<ProjectData>> {
  return getStubForOwner(env, projectId, projectId);
}

/**
 * Forget the memoized ensure for a project after a failed DO call, so a Durable
 * Object that was reset mid-flight re-persists its projectId on the next attempt.
 */
function forgetEnsuredProject(env: Env, projectId: string): void {
  forgetEnsuredProjectData(env.PROJECT_DATA.idFromName(projectId).toString());
}

function forgetEnsuredOwner(env: Env, ownerName: string): void {
  forgetEnsuredProjectData(env.PROJECT_DATA.idFromName(ownerName).toString());
}

function normalizeProjectDataRpcError(projectId: string, operation: string, err: unknown): unknown {
  if (isDurableObjectStorageFullError(err)) {
    return toProjectDataStorageFullError(projectId, operation, err);
  }
  const commentError = normalizeProjectDataCommentRpcError(err);
  if (commentError) return commentError;
  const eventError = normalizeProjectDataEventRpcError(err);
  if (eventError) return eventError;
  const manualToolPayloadCleanupError = normalizeManualToolPayloadCleanupRpcError(err);
  if (manualToolPayloadCleanupError) return manualToolPayloadCleanupError;
  return err;
}

function normalizeManualToolPayloadCleanupRpcError(err: unknown): Error | null {
  if (err instanceof ProjectDataManualToolPayloadCleanupStateError) return err;
  if (!(err instanceof Error)) return null;
  const prefix = 'ProjectDataManualToolPayloadCleanupStateError: ';
  if (!err.message.startsWith(prefix)) return null;
  const message = err.message.slice(prefix.length);
  return new ProjectDataManualToolPayloadCleanupStateError(
    message.includes('idempotencyKey was already used')
      ? 'idempotency_conflict'
      : 'invalid_request',
    message
  );
}

function normalizeProjectDataCommentRpcError(err: unknown): Error | null {
  if (!(err instanceof Error)) return null;

  // Cloudflare DO RPC serializes custom Error subclasses across isolates as a
  // generic Error whose message includes the original class name. Keep this
  // deliberately exact so non-domain failures continue to surface as 500s.
  const validationPrefix = 'CommentValidationError: ';
  if (err.message.startsWith(validationPrefix)) {
    return new CommentValidationError(err.message.slice(validationPrefix.length));
  }
  switch (err.message) {
    case 'CommentNotFoundError: Chat session not found':
      return new CommentNotFoundError('Chat session');
    case 'CommentNotFoundError: Message not found':
      return new CommentNotFoundError('Message');
    case 'CommentNotFoundError: Comment thread not found':
      return new CommentNotFoundError('Comment thread');
    default:
      return null;
  }
}

function normalizeProjectDataEventRpcError(err: unknown): Error | null {
  if (!(err instanceof Error)) return null;

  const validationPrefix = 'ProjectEventValidationError: ';
  if (err.message.startsWith(validationPrefix)) {
    return new ProjectEventValidationError(err.message.slice(validationPrefix.length));
  }
  const limitPrefix = 'ProjectEventLimitExceededError: ';
  if (err.message.startsWith(limitPrefix)) {
    return new ProjectEventLimitExceededError(err.message.slice(limitPrefix.length));
  }
  const conflictPrefix = 'ProjectEventIdempotencyConflictError: ';
  if (err.message.startsWith(conflictPrefix)) {
    return new ProjectEventIdempotencyConflictError(err.message.slice(conflictPrefix.length));
  }
  const cursorPrefix = 'ProjectEventCursorError: ';
  if (err.message.startsWith(cursorPrefix)) {
    return new ProjectEventCursorError(err.message.slice(cursorPrefix.length));
  }
  const ackPolicyPrefix = 'ProjectEventAckPolicyError: ';
  if (err.message.startsWith(ackPolicyPrefix)) {
    return new ProjectEventAckPolicyError(err.message.slice(ackPolicyPrefix.length));
  }
  const ackStatePrefix = 'ProjectEventAckStateError: ';
  if (err.message.startsWith(ackStatePrefix)) {
    return new ProjectEventAckStateError(err.message.slice(ackStatePrefix.length));
  }

  switch (err.message) {
    case 'ProjectEventNotFoundError: Project event not found':
      return new ProjectEventNotFoundError('Project event');
    case 'ProjectEventNotFoundError: Event subscription not found':
      return new ProjectEventNotFoundError('Event subscription');
    case 'ProjectEventNotFoundError: Event match not found':
      return new ProjectEventNotFoundError('Event match');
    case 'ProjectEventNotFoundError: Delivery batch not found':
      return new ProjectEventNotFoundError('Delivery batch');
    case 'ProjectEventNotFoundError: Delivery attempt not found':
      return new ProjectEventNotFoundError('Delivery attempt');
    default:
      return null;
  }
}

function isFailSessionIdentityGuardDenial(err: unknown, sessionId: string): boolean {
  return (
    err instanceof Error && err.message.startsWith(`Session ${sessionId} cannot failed: expected `)
  );
}

async function callProjectDataNoRetry<T>(
  env: Env,
  projectId: string,
  operation: string,
  call: (stub: DurableObjectStub<ProjectData>) => Promise<T>
): Promise<T> {
  try {
    const stub = await getStub(env, projectId);
    return await call(stub);
  } catch (err) {
    forgetEnsuredProject(env, projectId);
    throw normalizeProjectDataRpcError(projectId, operation, err);
  }
}

async function callProjectDataWithRetry<T>(
  env: Env,
  projectId: string,
  operation: string,
  call: (stub: DurableObjectStub<ProjectData>) => Promise<T>
): Promise<T> {
  const retryConfig = getDurableObjectRetryConfig(env);
  let lastError: unknown;

  for (let attempt = 1; attempt <= retryConfig.maxAttempts; attempt++) {
    try {
      const stub = await getStub(env, projectId);
      return await call(stub);
    } catch (err) {
      lastError = err;
      // Any DO failure means this isolate could not observe the DO's state, so
      // drop its belief that projectId is persisted and let the next attempt
      // re-ensure. Idempotent, and defence in depth only — see the memo module.
      forgetEnsuredProject(env, projectId);

      if (isDurableObjectStorageFullError(err)) {
        throw toProjectDataStorageFullError(projectId, operation, err);
      }

      if (attempt >= retryConfig.maxAttempts || !isTransientDurableObjectError(err)) {
        throw err;
      }

      const delayMs = computeDurableObjectRetryDelayMs(
        attempt,
        retryConfig.baseDelayMs,
        retryConfig.maxDelayMs
      );
      log.warn('project_data.do_rpc_retry', {
        projectId,
        operation,
        attempt,
        maxAttempts: retryConfig.maxAttempts,
        delayMs,
        error: err instanceof Error ? err.message : String(err),
      });
      await sleep(delayMs);
    }
  }

  throw normalizeProjectDataRpcError(
    projectId,
    operation,
    lastError ?? new Error('ProjectData DO retry exhausted without an error')
  );
}

async function callProjectDataOwnerWithRetry<T>(
  env: Env,
  projectId: string,
  ownerName: string,
  operation: string,
  call: (stub: DurableObjectStub<ProjectData>) => Promise<T>
): Promise<T> {
  const retryConfig = getDurableObjectRetryConfig(env);
  let lastError: unknown;

  for (let attempt = 1; attempt <= retryConfig.maxAttempts; attempt++) {
    try {
      const stub = await getStubForOwner(env, projectId, ownerName);
      return await call(stub);
    } catch (err) {
      lastError = err;
      forgetEnsuredOwner(env, ownerName);

      if (isDurableObjectStorageFullError(err)) {
        throw toProjectDataStorageFullError(projectId, operation, err);
      }

      if (attempt >= retryConfig.maxAttempts || !isTransientDurableObjectError(err)) {
        throw err;
      }

      const delayMs = computeDurableObjectRetryDelayMs(
        attempt,
        retryConfig.baseDelayMs,
        retryConfig.maxDelayMs
      );
      log.warn('project_data.do_rpc_retry', {
        projectId,
        operation,
        attempt,
        maxAttempts: retryConfig.maxAttempts,
        delayMs,
        error: err instanceof Error ? err.message : String(err),
      });
      await sleep(delayMs);
    }
  }

  throw normalizeProjectDataRpcError(
    projectId,
    operation,
    lastError ?? new Error('ProjectData DO retry exhausted without an error')
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type ProjectDataEventInput<T extends { projectId: string }> = Omit<T, 'projectId'>;

function withProjectId<T extends { projectId: string }>(
  projectId: string,
  input: ProjectDataEventInput<T>
): T {
  return { ...input, projectId } as T;
}

type ProjectDataEventRpc = {
  publishProjectEventChannel(
    input: PublishProjectEventChannelInput
  ): Promise<PublishProjectEventChannelResult>;
  listProjectEventChannels(input: ListProjectEventChannelsInput): Promise<ProjectEventChannelList>;
  getProjectEventChannelHistory(
    input: ProjectEventChannelHistoryInput
  ): Promise<ProjectEventChannelHistory>;
  followProjectEventChannel(
    input: FollowProjectEventChannelInput
  ): Promise<FollowProjectEventChannelResult>;
  catchUpProjectEventChannel(
    input: CatchUpProjectEventChannelInput
  ): Promise<FollowProjectEventChannelResult>;
  admitProjectEvent(input: AdmitProjectEventInput): Promise<ProjectEventAdmissionResult>;
  createProjectEventSubscription(
    input: CreateProjectEventSubscriptionInput
  ): Promise<ProjectEventSubscriptionMutationResult>;
  listProjectEventSubscriptions(
    input: ListProjectEventSubscriptionsInput
  ): Promise<ProjectEventSubscriptionListResult>;
  getProjectEventSubscription(
    input: GetProjectEventSubscriptionInput
  ): Promise<ProjectEventSubscriptionMutationResult['subscription'] | null>;
  cancelProjectEventSubscription(
    input: CancelProjectEventSubscriptionInput
  ): Promise<ProjectEventSubscriptionMutationResult>;
  expireProjectEventSubscriptions(
    input: ExpireProjectEventSubscriptionsInput
  ): Promise<ProjectEventExpireSubscriptionsResult>;
  createProjectEventDeliveryBatch(
    input: CreateProjectEventDeliveryBatchInput
  ): Promise<ProjectEventDeliveryBatchMutationResult>;
  listProjectEventSubscriptionEvents(
    input: ListProjectEventSubscriptionEventsInput
  ): Promise<ProjectEventSubscriptionEventListResult | null>;
  getProjectEvent(input: GetProjectEventInput): Promise<ProjectEventSubscriptionEvent | null>;
  ackProjectEventDelivery(
    input: AckProjectEventDeliveryInput
  ): Promise<ProjectEventDeliveryAckResult | null>;
  listProjectEventDeliveryBatches(
    input: ListProjectEventDeliveryBatchesInput
  ): Promise<ProjectEventDeliveryBatchListResult>;
  recordProjectEventDeliveryAttempt(
    input: RecordProjectEventDeliveryAttemptInput
  ): Promise<ProjectEventDeliveryAttemptMutationResult>;
  listProjectEventDeliveryAttempts(
    input: ListProjectEventDeliveryAttemptsInput
  ): Promise<ProjectEventDeliveryAttemptListResult>;
  getProjectEventRecentStatus(
    input: GetProjectEventRecentStatusInput
  ): Promise<ProjectEventRecentStatus>;
  validateProjectEventWakeRecoveryAuthority(
    input: ValidateProjectEventWakeRecoveryAuthorityInput
  ): Promise<boolean> | boolean;
  runProjectEventRetention(
    input: RunProjectEventRetentionInput
  ): Promise<ProjectEventRetentionResult>;
};

function projectEventRpc(stub: DurableObjectStub<ProjectData>): ProjectDataEventRpc {
  return stub as unknown as ProjectDataEventRpc;
}

type ProjectDataEventOperation = keyof ProjectDataEventRpc;
type ProjectDataEventOperationInput<T extends ProjectDataEventOperation> = Parameters<
  ProjectDataEventRpc[T]
>[0];
type ProjectDataEventOperationResult<T extends ProjectDataEventOperation> = Awaited<
  ReturnType<ProjectDataEventRpc[T]>
>;

function callProjectDataEvent<T extends ProjectDataEventOperation>(
  env: Env,
  projectId: string,
  operation: T,
  input: ProjectDataEventInput<ProjectDataEventOperationInput<T>>
): Promise<ProjectDataEventOperationResult<T>> {
  return callProjectDataNoRetry(env, projectId, operation, (stub) => {
    const method = projectEventRpc(stub)[operation] as (
      input: ProjectDataEventOperationInput<T>
    ) => Promise<ProjectDataEventOperationResult<T>>;
    return method(withProjectId(projectId, input));
  });
}

// =========================================================================
// Chat Sessions
// =========================================================================

async function recordSessionLifecycleEventBestEffort(
  env: Env,
  input: SessionLifecycleEventInput
): Promise<void> {
  try {
    const event = await buildSessionLifecycleEventInput(input);
    const { projectId, ...withoutProjectId } = event;
    await admitProjectEvent(env, projectId, withoutProjectId);
  } catch (err) {
    log.warn('project_data.session_lifecycle_event_failed', {
      projectId: input.projectId,
      sessionId: input.sessionId,
      lifecycle: input.lifecycle,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function sessionStatus(session: Record<string, unknown> | null): string | null {
  return typeof session?.status === 'string' ? session.status : null;
}

export async function createSession(
  env: Env,
  projectId: string,
  workspaceId: string | null,
  topic: string | null,
  taskId: string | null = null,
  createdByUserId: string | null = null
): Promise<string> {
  const sessionId = await callProjectDataNoRetry(env, projectId, 'createSession', (stub) =>
    stub.createSession(workspaceId, topic, taskId, createdByUserId)
  );
  await recordSessionLifecycleEventBestEffort(env, {
    projectId,
    sessionId,
    lifecycle: 'started',
    status: 'active',
    taskId,
    workspaceId,
    source: 'project_data.create_session',
    occurredAt: Date.now(),
  });
  return sessionId;
}

export async function createReservedTaskSessionWithInitialMessage(
  env: Env,
  projectId: string,
  input: CreateReservedTaskSessionWithInitialMessageInput
): Promise<CreateReservedTaskSessionWithInitialMessageResult> {
  await assertExactWriteAllowedIfArchiveEnabled(
    env,
    projectId,
    input.sessionId,
    'createReservedTaskSessionWithInitialMessage'
  );
  const result = await callProjectDataWithRetry<CreateReservedTaskSessionWithInitialMessageResult>(
    env,
    projectId,
    'createReservedTaskSessionWithInitialMessage',
    async (stub) =>
      (await stub.createReservedTaskSessionWithInitialMessage(
        input
      )) as CreateReservedTaskSessionWithInitialMessageResult
  );
  if (result.outcome === 'created' && result.sessionInserted) {
    await recordSessionLifecycleEventBestEffort(env, {
      projectId,
      sessionId: input.sessionId,
      lifecycle: 'started',
      status: 'active',
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      source: 'project_data.create_reserved_task_session',
      occurredAt: Date.now(),
    });
  }
  return result;
}

export async function linkSessionToWorkspace(
  env: Env,
  projectId: string,
  sessionId: string,
  workspaceId: string,
  guard?: ProjectDataSessionIdentityGuard | null
): Promise<void> {
  await assertExactWriteAllowedIfArchiveEnabled(
    env,
    projectId,
    sessionId,
    'linkSessionToWorkspace'
  );
  return callProjectDataWithRetry(env, projectId, 'linkSessionToWorkspace', (stub) =>
    stub.linkSessionToWorkspace(sessionId, workspaceId, guard ?? null)
  );
}

export async function stopSession(
  env: Env,
  projectId: string,
  sessionId: string
): Promise<boolean> {
  await assertExactWriteAllowedIfArchiveEnabled(env, projectId, sessionId, 'stopSession');
  await recordReservedTaskSessionRevocation(env, {
    projectId,
    chatSessionId: sessionId,
    reason: 'session_stopped',
    source: 'project_data.stop_session',
  });
  const stub = await getStub(env, projectId);
  const stopped = await stub.stopSession(sessionId);
  if (stopped) {
    await recordSessionLifecycleEventBestEffort(env, {
      projectId,
      sessionId,
      lifecycle: 'archived',
      status: 'stopped',
      source: 'project_data.stop_session',
      occurredAt: Date.now(),
    });
  }
  return stopped;
}

export async function sleepSession(
  env: Env,
  projectId: string,
  sessionId: string
): Promise<boolean> {
  await assertExactWriteAllowedIfArchiveEnabled(env, projectId, sessionId, 'sleepSession');
  const stub = await getStub(env, projectId);
  const sleeping = await stub.sleepSession(sessionId);
  if (sleeping) {
    await recordSessionLifecycleEventBestEffort(env, {
      projectId,
      sessionId,
      lifecycle: 'sleeping',
      status: 'sleeping',
      source: 'project_data.sleep_session',
      occurredAt: Date.now(),
    });
  }
  return sleeping;
}

export async function wakeSession(
  env: Env,
  projectId: string,
  sessionId: string,
  workspaceId: string,
  taskId: string
): Promise<boolean> {
  await assertExactWriteAllowedIfArchiveEnabled(env, projectId, sessionId, 'wakeSession');
  const stub = await getStub(env, projectId);
  const previousStatus = sessionStatus(await stub.getSession(sessionId));
  const woke = await stub.wakeSession(sessionId, workspaceId, taskId);
  if (woke && previousStatus !== 'active') {
    await recordSessionLifecycleEventBestEffort(env, {
      projectId,
      sessionId,
      lifecycle: 'woke',
      status: 'active',
      taskId,
      workspaceId,
      source: 'project_data.wake_session',
      occurredAt: Date.now(),
    });
  }
  return woke;
}

export async function wakeSessionForSnapshotRecovery(
  env: Env,
  projectId: string,
  sessionId: string,
  workspaceId: string,
  taskId: string
): Promise<boolean> {
  await assertExactWriteAllowedIfArchiveEnabled(
    env,
    projectId,
    sessionId,
    'wakeSessionForSnapshotRecovery'
  );
  const allowStopped = await hasAuthorizedRestorableSnapshotWakeClaim(env.DATABASE, {
    projectId,
    chatSessionId: sessionId,
    workspaceId,
    taskId,
  });
  if (!allowStopped) return false;
  const stub = await getStub(env, projectId);
  const previousStatus = sessionStatus(await stub.getSession(sessionId));
  const woke = await stub.wakeSession(sessionId, workspaceId, taskId, { allowStopped });
  if (woke && previousStatus !== 'active') {
    await recordSessionLifecycleEventBestEffort(env, {
      projectId,
      sessionId,
      lifecycle: 'woke',
      status: 'active',
      taskId,
      workspaceId,
      source: 'project_data.snapshot_recovery_wake_session',
      occurredAt: Date.now(),
    });
  }
  return woke;
}

export async function failSession(
  env: Env,
  projectId: string,
  sessionId: string,
  errorMessage: string | null = null,
  guard?: ProjectDataSessionIdentityGuard | null
): Promise<boolean> {
  await assertExactWriteAllowedIfArchiveEnabled(env, projectId, sessionId, 'failSession');
  const stub = await getStub(env, projectId);
  let failed: boolean;
  try {
    failed = await stub.failSession(sessionId, errorMessage, guard ?? null);
  } catch (error) {
    if (guard && isFailSessionIdentityGuardDenial(error, sessionId)) {
      log.info('project_data.fail_session_identity_guard_denied', {
        projectId,
        sessionId,
        taskId: guard.taskId ?? null,
      });
      return false;
    }
    throw error;
  }
  if (failed) {
    await recordReservedTaskSessionRevocation(env, {
      projectId,
      chatSessionId: sessionId,
      taskId: guard?.taskId ?? null,
      reason: 'session_failed',
      source: 'project_data.fail_session',
    });
    await recordSessionLifecycleEventBestEffort(env, {
      projectId,
      sessionId,
      lifecycle: 'failed',
      status: 'failed',
      reason: errorMessage,
      source: 'project_data.fail_session',
      occurredAt: Date.now(),
    });
  }
  return failed;
}

export async function reconcileTerminalTaskSessions(
  env: Env,
  projectId: string,
  input: TerminalSessionReconciliationInput = {}
): Promise<TerminalSessionReconciliationStats> {
  return callProjectDataWithRetry(env, projectId, 'reconcileTerminalTaskSessions', (stub) =>
    stub.reconcileTerminalTaskSessions(input)
  );
}

export async function updateSessionTopic(
  env: Env,
  projectId: string,
  sessionId: string,
  topic: string
): Promise<boolean> {
  await assertExactWriteAllowedIfArchiveEnabled(env, projectId, sessionId, 'updateSessionTopic');
  const stub = await getStub(env, projectId);
  return stub.updateSessionTopic(sessionId, topic);
}

export async function persistMessage(
  env: Env,
  projectId: string,
  sessionId: string,
  role: string,
  content: string,
  toolMetadata: Record<string, unknown> | null,
  messageId?: string,
  guard?: ProjectDataSessionIdentityGuard | null
): Promise<string> {
  await assertExactWriteAllowedIfArchiveEnabled(env, projectId, sessionId, 'persistMessage');
  return callProjectDataNoRetry(env, projectId, 'persistMessage', (stub) =>
    stub.persistMessage(
      sessionId,
      role,
      content,
      toolMetadata ? JSON.stringify(toolMetadata) : null,
      messageId,
      guard ?? null
    )
  );
}

export async function persistMessageBatch(
  env: Env,
  projectId: string,
  sessionId: string,
  messages: Array<{
    messageId: string;
    role: string;
    content: string;
    toolMetadata: Record<string, unknown> | null;
    timestamp: string;
    sequence?: number;
    origin?: string | null;
  }>
): Promise<{
  persisted: number;
  duplicates: number;
  limitReached?: boolean;
  maxMessages?: number;
  remainingCapacity?: number;
}> {
  await assertExactWriteAllowedIfArchiveEnabled(env, projectId, sessionId, 'persistMessageBatch');
  return callProjectDataNoRetry(env, projectId, 'persistMessageBatch', (stub) =>
    stub.persistMessageBatch(
      sessionId,
      messages.map((m) => ({
        messageId: m.messageId,
        role: m.role,
        content: m.content,
        toolMetadata: m.toolMetadata ? JSON.stringify(m.toolMetadata) : null,
        timestamp: m.timestamp,
        sequence: m.sequence,
        // origin ("system" for SAM-injected messages) MUST be forwarded to the DO
        // so the persisted message can be collapsed in the UI and excluded from
        // dedup/search/topic/attention. Dropping it here silently loses the tag.
        origin: m.origin ?? null,
      }))
    )
  );
}

export async function listSessions(
  env: Env,
  projectId: string,
  status: string | null = null,
  limit: number = 20,
  offset: number = 0,
  taskId: string | null = null,
  createdByUserId: string | null = null
): Promise<{ sessions: Record<string, unknown>[]; total: number; hasMore: boolean }> {
  return callProjectDataWithRetry(env, projectId, 'listSessions', (stub) =>
    stub.listSessions(status, limit, offset, taskId, createdByUserId)
  );
}

/**
 * Ask the ProjectData DO to refresh the D1 session index (debounced inside the DO).
 *
 * Only for callers that observed the index fail to answer. Do NOT fold this into
 * `listSessions` — most of its callers never touch the index, and syncing from
 * there turns ordinary reads (the account-map fan-out over every project, the
 * admin backfill over every project in the deployment) into re-index storms.
 */
export async function primeSessionIndex(env: Env, projectId: string): Promise<void> {
  const stub = await getStub(env, projectId);
  await stub.primeSessionIndex();
}

export async function getSessionsByTaskIds(
  env: Env,
  projectId: string,
  taskIds: string[]
): Promise<Array<Record<string, unknown>>> {
  const stub = await getStub(env, projectId);
  return stub.getSessionsByTaskIds(taskIds);
}

export async function linkSessionToTask(
  env: Env,
  projectId: string,
  sessionId: string,
  taskId: string
): Promise<boolean> {
  await assertExactWriteAllowedIfArchiveEnabled(env, projectId, sessionId, 'linkSessionToTask');
  return callProjectDataWithRetry(env, projectId, 'linkSessionToTask', (stub) =>
    stub.linkSessionToTask(sessionId, taskId)
  );
}

export async function getSession(
  env: Env,
  projectId: string,
  sessionId: string
): Promise<Record<string, unknown> | null> {
  return callProjectDataWithRetry(env, projectId, 'getSession', (stub) =>
    stub.getSession(sessionId)
  );
}

export async function getMessages(
  env: Env,
  projectId: string,
  sessionId: string,
  limit: number = 100,
  before: number | null = null,
  after: number | null = null,
  roles?: string[],
  compact: boolean = false,
  order: 'asc' | 'desc' = 'desc'
): Promise<{ messages: Record<string, unknown>[]; hasMore: boolean }> {
  const owner = await resolveExactReadOwnerIfArchiveEnabled(env, projectId, sessionId);
  return callProjectDataOwnerWithRetry(env, projectId, owner.ownerName, 'getMessages', (stub) => {
    if (owner.kind === 'root') {
      return stub.archiveSourceGetMessages(owner, limit, before, after, roles, compact, order);
    }
    return stub.archiveTargetGetMessages(owner, limit, before, after, roles, compact, order);
  });
}

export async function getMessageToolContent(
  env: Env,
  projectId: string,
  sessionId: string,
  messageId: string
): Promise<MessageToolContentResult | null> {
  const owner = await resolveExactReadOwnerIfArchiveEnabled(env, projectId, sessionId);
  const stub = await getStubForOwner(env, projectId, owner.ownerName);
  if (owner.kind === 'archive_shard') {
    return stub.archiveTargetGetMessageToolContent({ ...owner, messageId });
  }
  return stub.archiveSourceGetMessageToolContent({ ...owner, messageId });
}

export async function getArchivedToolPayloads(
  env: Env,
  projectId: string,
  input: ArchivedToolPayloadQuery
): Promise<ArchivedToolPayloadListResult> {
  const sessionId = input.sessionId ?? null;
  if (sessionId) {
    const owner = await resolveExactReadOwnerIfArchiveEnabled(env, projectId, sessionId);
    const stub = await getStubForOwner(env, projectId, owner.ownerName);
    if (owner.kind === 'archive_shard') {
      return stub.archiveTargetGetArchivedToolPayloads({ owner, query: input });
    }
    return stub.archiveSourceGetArchivedToolPayloads({ owner, query: input });
  }
  const stub = await getStub(env, projectId);
  return stub.getArchivedToolPayloads(input);
}

/** Get total message count for a session, optionally filtered by roles. */
export async function getMessageCount(
  env: Env,
  projectId: string,
  sessionId: string,
  roles?: string[]
): Promise<number> {
  const owner = await resolveExactReadOwnerIfArchiveEnabled(env, projectId, sessionId);
  const stub = await getStubForOwner(env, projectId, owner.ownerName);
  if (owner.kind === 'root') return stub.archiveSourceGetMessageCount(owner, roles);
  return stub.archiveTargetGetMessageCount(owner, roles);
}

/** Search messages across sessions by keyword. */
export type ProjectDataMessageSearchResult = {
  id: string;
  sessionId: string;
  role: string;
  snippet: string;
  createdAt: number;
  sessionTopic: string | null;
  sessionTaskId: string | null;
};

export type ProjectDataArchiveSearchMetadata = {
  partial: boolean;
  reason:
    | null
    | 'session_scoped_exact_read'
    | 'archive_owner_inventory_unavailable'
    | 'continuation_required'
    | 'archive_search_errors';
  complete: boolean;
  continuation: string | null;
  resultsProvisional: boolean;
  rootQueried: boolean;
  rootError: string | null;
  archiveOwnersAvailable: number;
  archiveOwnersQueried: number;
  archiveOwnersFailed: number;
  archiveOwnersOmitted: number;
  archiveOwnerLimit: number;
  ownerCoverage: {
    attempted: number;
    succeeded: number;
    remaining: number;
    complete: boolean;
  };
  indexCoverage: {
    sessionsAvailable: number;
    sessionsIndexed: number;
    sessionsIncomplete: number;
    complete: boolean;
    errors: Array<{ ownerName: string; sessionId: string; error: string }>;
  };
  executionErrors: Array<{ ownerName: string; error: string }>;
};

export type ProjectDataSearchMessagesWithArchiveMetadataResult = {
  results: ProjectDataMessageSearchResult[];
  archiveSearch: ProjectDataArchiveSearchMetadata;
};

type ProjectDataArchiveSearchOwnerRow = {
  owner_name: string;
  generation: number;
};

function resolveProjectWideArchiveSearchMaxOwners(env: Env): number {
  const parsed = Number.parseInt(env.PROJECT_DATA_ARCHIVE_SEARCH_MAX_OWNERS ?? '', 10);
  if (
    Number.isSafeInteger(parsed) &&
    parsed > 0 &&
    parsed <= PROJECT_DATA_ARCHIVE_MAX_SEARCH_OWNERS
  ) {
    return parsed;
  }
  return PROJECT_DATA_ARCHIVE_DEFAULT_SEARCH_MAX_OWNERS;
}

function resolveProjectWideArchiveSearchConcurrency(env: Env): number {
  const parsed = Number.parseInt(env.PROJECT_DATA_ARCHIVE_SEARCH_CONCURRENCY ?? '', 10);
  if (
    Number.isSafeInteger(parsed) &&
    parsed > 0 &&
    parsed <= PROJECT_DATA_ARCHIVE_MAX_SEARCH_CONCURRENCY
  ) {
    return parsed;
  }
  return PROJECT_DATA_ARCHIVE_DEFAULT_SEARCH_CONCURRENCY;
}

function resolveBoundedArchiveSearchInt(
  value: string | undefined,
  fallback: number,
  maximum: number
): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

function resolveArchiveSearchContinuationTtlMs(env: Env): number {
  return resolveBoundedArchiveSearchInt(
    env.PROJECT_DATA_ARCHIVE_SEARCH_CONTINUATION_TTL_MS,
    15 * 60 * 1000,
    24 * 60 * 60 * 1000
  );
}

function resolveArchiveSearchCursorMaxBytes(env: Env): number {
  return resolveBoundedArchiveSearchInt(
    env.PROJECT_DATA_ARCHIVE_SEARCH_CURSOR_MAX_BYTES,
    1024 * 1024,
    4 * 1024 * 1024
  );
}

function resolveArchiveSearchErrorLimit(env: Env): number {
  return resolveBoundedArchiveSearchInt(env.PROJECT_DATA_ARCHIVE_SEARCH_ERROR_LIMIT, 20, 100);
}

async function readProjectWideArchiveSearchOwners(
  env: Env,
  projectId: string
): Promise<ProjectDataArchiveSearchOwnerRow[]> {
  const rows = await env.DATABASE.prepare(
    `SELECT owner_name, generation FROM (
       SELECT owner_name, generation
       FROM project_data_session_locations
       WHERE project_id = ?
         AND location_state = 'archive_shard'
         AND owner_kind = 'archive_shard'
       UNION
       SELECT target_owner_name AS owner_name, target_generation AS generation
       FROM project_data_archive_migrations
       WHERE project_id = ?
         AND state IN ('target_sealed', 'recovery_manifest_persisted', 'source_deleted')
         AND target_aggregate_sha256 IS NOT NULL
         AND target_aggregate_sha256 != ''
     )
     GROUP BY owner_name, generation
     ORDER BY generation DESC, owner_name ASC`
  )
    .bind(projectId, projectId)
    .all<ProjectDataArchiveSearchOwnerRow>();
  return rows.results ?? [];
}

function sortAndLimitSearchResults(
  results: ProjectDataMessageSearchResult[],
  limit: number
): ProjectDataMessageSearchResult[] {
  const deduped = new Map<string, ProjectDataMessageSearchResult>();
  for (const result of results) deduped.set(`${result.sessionId}\u0000${result.id}`, result);
  return [...deduped.values()]
    .sort(
      (a, b) =>
        b.createdAt - a.createdAt ||
        a.sessionId.localeCompare(b.sessionId) ||
        a.id.localeCompare(b.id)
    )
    .slice(0, limit);
}

type ArchiveSearchCursor = {
  version: 1;
  expiresAt: number;
  projectId: string;
  query: string;
  roles: string[] | null;
  limit: number;
  owners: ProjectDataArchiveSearchOwnerRow[];
  retryOwners: ProjectDataArchiveSearchOwnerRow[];
  ownerCount: number;
  nextOwner: number;
  results: ProjectDataMessageSearchResult[];
  rootQueried: boolean;
  rootError: string | null;
  ownersSucceeded: number;
  ownersFailed: number;
  sessionsAvailable: number;
  sessionsIndexed: number;
  sessionsIncomplete: number;
  indexErrors: Array<{ ownerName: string; sessionId: string; error: string }>;
  executionErrors: Array<{ ownerName: string; error: string }>;
  failedOwnerNames: string[];
  ownerIndexCoverage: Array<{
    ownerName: string;
    sessionsAvailable: number;
    sessionsIndexed: number;
    sessionsIncomplete: number;
  }>;
};

function isArchiveSearchCursor(value: unknown): value is ArchiveSearchCursor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const cursor = value as Record<string, unknown>;
  const integers = [
    'expiresAt',
    'limit',
    'nextOwner',
    'ownersSucceeded',
    'ownersFailed',
    'sessionsAvailable',
    'sessionsIndexed',
    'sessionsIncomplete',
  ];
  if (
    cursor.version !== 1 ||
    typeof cursor.projectId !== 'string' ||
    typeof cursor.query !== 'string' ||
    typeof cursor.rootQueried !== 'boolean' ||
    (cursor.rootError !== null && typeof cursor.rootError !== 'string') ||
    !integers.every((key) => Number.isSafeInteger(cursor[key])) ||
    !(
      cursor.roles === null ||
      (Array.isArray(cursor.roles) && cursor.roles.every((role) => typeof role === 'string'))
    ) ||
    !Array.isArray(cursor.owners) ||
    !Array.isArray(cursor.retryOwners) ||
    !Array.isArray(cursor.results) ||
    !Array.isArray(cursor.indexErrors) ||
    !Array.isArray(cursor.executionErrors) ||
    !Array.isArray(cursor.failedOwnerNames) ||
    !Array.isArray(cursor.ownerIndexCoverage) ||
    !Number.isSafeInteger(cursor.ownerCount)
  ) {
    return false;
  }
  const recordsHave = (items: unknown[], fields: string[]) =>
    items.every(
      (item) =>
        item !== null &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        fields.every((field) => typeof (item as Record<string, unknown>)[field] === 'string')
    );
  return (
    cursor.owners.every(
      (owner) =>
        owner !== null &&
        typeof owner === 'object' &&
        !Array.isArray(owner) &&
        typeof (owner as Record<string, unknown>).owner_name === 'string' &&
        Number.isSafeInteger((owner as Record<string, unknown>).generation)
    ) &&
    cursor.retryOwners.every(
      (owner) =>
        owner !== null &&
        typeof owner === 'object' &&
        !Array.isArray(owner) &&
        typeof (owner as Record<string, unknown>).owner_name === 'string' &&
        Number.isSafeInteger((owner as Record<string, unknown>).generation)
    ) &&
    cursor.results.every(
      (result) =>
        result !== null &&
        typeof result === 'object' &&
        !Array.isArray(result) &&
        ['id', 'sessionId', 'role', 'snippet'].every(
          (field) => typeof (result as Record<string, unknown>)[field] === 'string'
        ) &&
        Number.isSafeInteger((result as Record<string, unknown>).createdAt) &&
        ['sessionTopic', 'sessionTaskId'].every((field) => {
          const fieldValue = (result as Record<string, unknown>)[field];
          return fieldValue === null || typeof fieldValue === 'string';
        })
    ) &&
    recordsHave(cursor.indexErrors, ['ownerName', 'sessionId', 'error']) &&
    recordsHave(cursor.executionErrors, ['ownerName', 'error']) &&
    cursor.failedOwnerNames.every((ownerName) => typeof ownerName === 'string') &&
    cursor.ownerIndexCoverage.every(
      (coverage) =>
        coverage !== null &&
        typeof coverage === 'object' &&
        !Array.isArray(coverage) &&
        typeof (coverage as Record<string, unknown>).ownerName === 'string' &&
        ['sessionsAvailable', 'sessionsIndexed', 'sessionsIncomplete'].every((field) =>
          Number.isSafeInteger((coverage as Record<string, unknown>)[field])
        )
    )
  );
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function archiveSearchCursorKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

async function encodeArchiveSearchCursor(env: Env, cursor: ArchiveSearchCursor): Promise<string> {
  const body = base64UrlEncode(new TextEncoder().encode(JSON.stringify(cursor)));
  const signature = await crypto.subtle.sign(
    'HMAC',
    await archiveSearchCursorKey(env.ENCRYPTION_KEY),
    new TextEncoder().encode(body)
  );
  const token = `${body}.${base64UrlEncode(new Uint8Array(signature))}`;
  if (token.length > resolveArchiveSearchCursorMaxBytes(env)) {
    throw new Error('Archive search continuation exceeds the configured byte limit');
  }
  return token;
}

async function decodeArchiveSearchCursor(
  env: Env,
  value: string,
  binding: Pick<ArchiveSearchCursor, 'projectId' | 'query' | 'roles' | 'limit'>
): Promise<ArchiveSearchCursor> {
  if (value.length > resolveArchiveSearchCursorMaxBytes(env)) {
    throw new Error('Archive search continuation exceeds the configured byte limit');
  }
  const [body, suppliedSignature, extra] = value.split('.');
  if (!body || !suppliedSignature || extra) throw new Error('Invalid archive search continuation');
  const valid = await crypto.subtle.verify(
    'HMAC',
    await archiveSearchCursorKey(env.ENCRYPTION_KEY),
    base64UrlDecode(suppliedSignature),
    new TextEncoder().encode(body)
  );
  if (!valid) throw new Error('Invalid archive search continuation signature');
  const parsed: unknown = JSON.parse(new TextDecoder().decode(base64UrlDecode(body)));
  if (!isArchiveSearchCursor(parsed)) throw new Error('Invalid archive search continuation body');
  const cursor = parsed;
  if (
    cursor.version !== 1 ||
    cursor.expiresAt < Date.now() ||
    cursor.projectId !== binding.projectId ||
    cursor.query !== binding.query ||
    cursor.limit !== binding.limit ||
    JSON.stringify(cursor.roles) !== JSON.stringify(binding.roles) ||
    !Array.isArray(cursor.owners) ||
    !Number.isSafeInteger(cursor.nextOwner) ||
    cursor.nextOwner < 0 ||
    cursor.nextOwner > cursor.owners.length
  ) {
    throw new Error('Archive search continuation does not match this query');
  }
  return cursor;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  fn: (value: T) => Promise<R>
): Promise<Array<PromiseSettledResult<R>>> {
  const results: Array<PromiseSettledResult<R>> = new Array(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      for (;;) {
        const index = next++;
        const value = values[index];
        if (value === undefined) return;
        try {
          results[index] = { status: 'fulfilled', value: await fn(value) };
        } catch (reason) {
          results[index] = { status: 'rejected', reason };
        }
      }
    })
  );
  return results;
}

export async function searchMessagesWithArchiveMetadata(
  env: Env,
  projectId: string,
  query: string,
  sessionId: string | null = null,
  roles: string[] | null = null,
  limit: number = 10,
  continuation: string | null = null
): Promise<ProjectDataSearchMessagesWithArchiveMetadataResult> {
  const searchStartedAt = Date.now();
  if (sessionId) {
    const owner = await resolveExactReadOwnerIfArchiveEnabled(env, projectId, sessionId);
    const ownerStub = await getStubForOwner(env, projectId, owner.ownerName);
    let results: ProjectDataMessageSearchResult[];
    if (owner.kind === 'root') {
      results = await ownerStub.archiveSourceSearchMessages(owner, query, roles, limit);
    } else {
      results = await ownerStub.archiveTargetSearchMessages(owner, query, roles, limit);
    }
    return {
      results,
      archiveSearch: {
        partial: false,
        reason: 'session_scoped_exact_read',
        complete: true,
        continuation: null,
        resultsProvisional: false,
        rootQueried: owner.kind === 'root',
        rootError: null,
        archiveOwnersAvailable: owner.kind === 'archive_shard' ? 1 : 0,
        archiveOwnersQueried: owner.kind === 'archive_shard' ? 1 : 0,
        archiveOwnersFailed: 0,
        archiveOwnersOmitted: 0,
        archiveOwnerLimit: 1,
        ownerCoverage: {
          attempted: owner.kind === 'archive_shard' ? 1 : 0,
          succeeded: owner.kind === 'archive_shard' ? 1 : 0,
          remaining: 0,
          complete: true,
        },
        indexCoverage: {
          sessionsAvailable: owner.kind === 'archive_shard' ? 1 : 0,
          sessionsIndexed: owner.kind === 'archive_shard' ? 1 : 0,
          sessionsIncomplete: 0,
          complete: true,
          errors: [],
        },
        executionErrors: [],
      },
    };
  }
  const archiveOwnerLimit = resolveProjectWideArchiveSearchMaxOwners(env);
  let cursor: ArchiveSearchCursor;
  if (continuation) {
    cursor = await decodeArchiveSearchCursor(env, continuation, { projectId, query, roles, limit });
  } else {
    let rootResults: ProjectDataMessageSearchResult[] = [];
    let rootError: string | null = null;
    try {
      const stub = await getStub(env, projectId);
      rootResults = (await stub.searchMessages(
        query,
        null,
        roles,
        limit
      )) as ProjectDataMessageSearchResult[];
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      rootError = 'root_search_failed';
      log.warn('project_data.root_search_failed', { projectId, error: errorMessage });
    }
    let owners: ProjectDataArchiveSearchOwnerRow[];
    try {
      owners = await readProjectWideArchiveSearchOwners(env, projectId);
    } catch (error) {
      log.warn('project_data.archive_search_inventory_failed', {
        projectId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        results: rootResults,
        archiveSearch: {
          partial: true,
          reason: 'archive_owner_inventory_unavailable',
          complete: false,
          continuation: null,
          resultsProvisional: true,
          rootQueried: true,
          rootError,
          archiveOwnersAvailable: 0,
          archiveOwnersQueried: 0,
          archiveOwnersFailed: 0,
          archiveOwnersOmitted: 0,
          archiveOwnerLimit,
          ownerCoverage: { attempted: 0, succeeded: 0, remaining: 0, complete: false },
          indexCoverage: {
            sessionsAvailable: 0,
            sessionsIndexed: 0,
            sessionsIncomplete: 0,
            complete: false,
            errors: [],
          },
          executionErrors: [],
        },
      };
    }
    cursor = {
      version: 1,
      expiresAt: Date.now() + resolveArchiveSearchContinuationTtlMs(env),
      projectId,
      query,
      roles,
      limit,
      owners,
      retryOwners: [],
      ownerCount: owners.length,
      nextOwner: 0,
      results: rootResults,
      rootQueried: true,
      rootError,
      ownersSucceeded: 0,
      ownersFailed: 0,
      sessionsAvailable: 0,
      sessionsIndexed: 0,
      sessionsIncomplete: 0,
      indexErrors: [],
      executionErrors: [],
      failedOwnerNames: [],
      ownerIndexCoverage: [],
    };
  }

  if (cursor.rootError !== null) {
    try {
      const stub = await getStub(env, projectId);
      cursor.results.push(
        ...((await stub.searchMessages(
          query,
          null,
          roles,
          limit
        )) as ProjectDataMessageSearchResult[])
      );
      cursor.rootError = null;
    } catch (error) {
      log.warn('project_data.root_search_retry_failed', {
        projectId,
        error: error instanceof Error ? error.message : String(error),
      });
      cursor.rootError = 'root_search_failed';
    }
  }
  if (cursor.nextOwner >= cursor.owners.length && cursor.retryOwners.length > 0) {
    cursor.owners = cursor.retryOwners;
    cursor.retryOwners = [];
    cursor.nextOwner = 0;
  }

  const ownerBatch = cursor.owners.slice(cursor.nextOwner, cursor.nextOwner + archiveOwnerLimit);
  const ownerResults = await mapWithConcurrency(
    ownerBatch,
    resolveProjectWideArchiveSearchConcurrency(env),
    async (archiveOwner) => {
      const owner: ProjectDataArchiveOwnerRef = {
        kind: 'archive_shard',
        projectId,
        ownerName: archiveOwner.owner_name,
        generation: archiveOwner.generation,
      };
      const ownerStub = await getStubForOwner(env, projectId, owner.ownerName);
      return {
        owner,
        result: await ownerStub.archiveTargetSearchProjectMessages(owner, query, roles, limit),
      };
    }
  );
  let repairAttempts = 0;
  let sessionsRepaired = 0;
  ownerResults.forEach((settled, index) => {
    const archiveOwner = ownerBatch[index];
    if (!archiveOwner) return;
    cursor.executionErrors = cursor.executionErrors.filter(
      (item) => item.ownerName !== archiveOwner.owner_name
    );
    cursor.failedOwnerNames = cursor.failedOwnerNames.filter(
      (ownerName) => ownerName !== archiveOwner.owner_name
    );
    cursor.indexErrors = cursor.indexErrors.filter(
      (item) => item.ownerName !== archiveOwner.owner_name
    );
    if (settled.status === 'rejected') {
      const error =
        settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
      cursor.executionErrors.push({
        ownerName: archiveOwner.owner_name,
        error: 'archive_owner_search_failed',
      });
      cursor.failedOwnerNames.push(archiveOwner.owner_name);
      cursor.retryOwners.push(archiveOwner);
      log.warn('project_data.archive_search_owner_failed', {
        projectId,
        ownerName: archiveOwner.owner_name,
        generation: archiveOwner.generation,
        error,
      });
      return;
    }
    cursor.results.push(...settled.value.result.results);
    cursor.results = sortAndLimitSearchResults(cursor.results, limit);
    const coverage = settled.value.result.coverage;
    repairAttempts += coverage.repairAttempts ?? 0;
    sessionsRepaired += coverage.sessionsRepaired ?? 0;
    cursor.ownerIndexCoverage = cursor.ownerIndexCoverage.filter(
      (item) => item.ownerName !== archiveOwner.owner_name
    );
    cursor.ownerIndexCoverage.push({
      ownerName: archiveOwner.owner_name,
      sessionsAvailable: coverage.sessionsAvailable,
      sessionsIndexed: coverage.sessionsIndexed,
      sessionsIncomplete: coverage.sessionsIncomplete,
    });
    cursor.indexErrors.push(
      ...coverage.errors.map((error: { sessionId: string; error: string }) => ({
        ownerName: archiveOwner.owner_name,
        ...error,
      }))
    );
    if (coverage.sessionsIncomplete > 0 || coverage.errors.length > 0) {
      cursor.retryOwners.push(archiveOwner);
    } else {
      cursor.ownersSucceeded++;
    }
  });
  cursor.nextOwner += ownerBatch.length;

  const errorLimit = resolveArchiveSearchErrorLimit(env);
  cursor.executionErrors = cursor.executionErrors.slice(-errorLimit);
  cursor.indexErrors = cursor.indexErrors.slice(-errorLimit);
  cursor.ownersFailed = cursor.failedOwnerNames.length;
  cursor.sessionsAvailable = cursor.ownerIndexCoverage.reduce(
    (total, item) => total + item.sessionsAvailable,
    0
  );
  cursor.sessionsIndexed = cursor.ownerIndexCoverage.reduce(
    (total, item) => total + item.sessionsIndexed,
    0
  );
  cursor.sessionsIncomplete = cursor.ownerIndexCoverage.reduce(
    (total, item) => total + item.sessionsIncomplete,
    0
  );
  const remaining = cursor.owners.length - cursor.nextOwner + cursor.retryOwners.length;
  const complete =
    remaining === 0 &&
    cursor.rootError === null &&
    cursor.failedOwnerNames.length === 0 &&
    cursor.sessionsIncomplete === 0;
  const nextContinuation = complete ? null : await encodeArchiveSearchCursor(env, cursor);
  const hasErrors = cursor.rootError !== null || cursor.failedOwnerNames.length > 0;
  const indexComplete = complete && cursor.sessionsIncomplete === 0 && cursor.ownersFailed === 0;
  const partial = !complete || !indexComplete || hasErrors;

  const response: ProjectDataSearchMessagesWithArchiveMetadataResult = {
    results: sortAndLimitSearchResults(cursor.results, limit),
    archiveSearch: {
      partial,
      reason: !complete ? 'continuation_required' : partial ? 'archive_search_errors' : null,
      complete,
      continuation: nextContinuation,
      resultsProvisional: !complete,
      rootQueried: cursor.rootQueried,
      rootError: cursor.rootError,
      archiveOwnersAvailable: cursor.ownerCount,
      archiveOwnersQueried: cursor.ownersSucceeded,
      archiveOwnersFailed: cursor.ownersFailed,
      archiveOwnersOmitted: remaining,
      archiveOwnerLimit,
      ownerCoverage: {
        attempted: new Set([
          ...cursor.ownerIndexCoverage.map((item) => item.ownerName),
          ...cursor.failedOwnerNames,
        ]).size,
        succeeded: cursor.ownersSucceeded,
        remaining,
        complete,
      },
      indexCoverage: {
        sessionsAvailable: cursor.sessionsAvailable,
        sessionsIndexed: cursor.sessionsIndexed,
        sessionsIncomplete: cursor.sessionsIncomplete,
        complete: indexComplete,
        errors: cursor.indexErrors,
      },
      executionErrors: cursor.executionErrors,
    },
  };
  log.info('project_data.archive_search_completed', {
    projectId,
    durationMs: Date.now() - searchStartedAt,
    ownerBatchSize: ownerBatch.length,
    ownersAvailable: cursor.ownerCount,
    ownersSucceeded: cursor.ownersSucceeded,
    ownersFailed: cursor.ownersFailed,
    ownersRemaining: remaining,
    sessionsAvailable: cursor.sessionsAvailable,
    sessionsIndexed: cursor.sessionsIndexed,
    sessionsIncomplete: cursor.sessionsIncomplete,
    repairAttempts,
    sessionsRepaired,
    complete,
  });
  return response;
}

export async function searchMessages(
  env: Env,
  projectId: string,
  query: string,
  sessionId: string | null = null,
  roles: string[] | null = null,
  limit: number = 10
): Promise<ProjectDataMessageSearchResult[]> {
  return (await searchMessagesWithArchiveMetadata(env, projectId, query, sessionId, roles, limit))
    .results;
}

// =========================================================================
// Message-Anchored Comments
// =========================================================================

export type MessageCommentActor = CommentAuthor;

export async function listCommentThreads(
  env: Env,
  projectId: string,
  input: ListCommentThreadsInput
): Promise<MessageCommentListResponse> {
  return callProjectDataWithRetry(env, projectId, 'listCommentThreads', (stub) =>
    stub.listCommentThreads(input)
  );
}

export async function getCommentThread(
  env: Env,
  projectId: string,
  sessionId: string,
  threadId: string
): Promise<MessageCommentThread | null> {
  return callProjectDataWithRetry(env, projectId, 'getCommentThread', (stub) =>
    stub.getCommentThread({ sessionId, threadId })
  );
}

export async function createCommentThread(
  env: Env,
  projectId: string,
  input: CreateCommentThreadInput
): Promise<MessageCommentMutationResponse> {
  await assertExactWriteAllowedIfArchiveEnabled(
    env,
    projectId,
    input.sessionId,
    'createCommentThread'
  );
  return callProjectDataNoRetry(env, projectId, 'createCommentThread', (stub) =>
    stub.createCommentThread(input)
  );
}

export async function createCommentReply(
  env: Env,
  projectId: string,
  input: CreateCommentReplyInput
): Promise<MessageCommentReplyMutationResponse> {
  await assertExactWriteAllowedIfArchiveEnabled(
    env,
    projectId,
    input.sessionId,
    'createCommentReply'
  );
  return callProjectDataNoRetry(env, projectId, 'createCommentReply', (stub) =>
    stub.createCommentReply(input)
  );
}

export async function updateCommentThreadStatus(
  env: Env,
  projectId: string,
  input: UpdateCommentStatusInput & { status: CommentStatus }
): Promise<MessageCommentMutationResponse> {
  return callProjectDataNoRetry(env, projectId, 'updateCommentThreadStatus', (stub) =>
    stub.updateCommentThreadStatus(input)
  );
}

/**
 * Every comment thread in the project, both anchor kinds, in one round trip.
 *
 * Replaces a client-side fan-out that issued one request per recent session plus
 * one per library file — up to 52 requests to render a single page
 * (.claude/rules/60).
 */
export async function listProjectCommentInbox(
  env: Env,
  projectId: string,
  input: ListProjectCommentThreadsInput
): Promise<ProjectCommentInboxResult> {
  return callProjectDataWithRetry(env, projectId, 'listProjectCommentInbox', (stub) =>
    stub.listProjectCommentInbox(input)
  );
}

// =========================================================================
// ProjectData Event Subscription Core
// =========================================================================

export function publishProjectEventChannel(
  env: Env,
  projectId: string,
  input: ProjectDataEventInput<PublishProjectEventChannelInput>
) {
  return callProjectDataEvent(env, projectId, 'publishProjectEventChannel', input);
}

export function listProjectEventChannels(
  env: Env,
  projectId: string,
  input: ProjectDataEventInput<ListProjectEventChannelsInput> = {}
) {
  return callProjectDataEvent(env, projectId, 'listProjectEventChannels', input);
}

export function getProjectEventChannelHistory(
  env: Env,
  projectId: string,
  input: ProjectDataEventInput<ProjectEventChannelHistoryInput>
) {
  return callProjectDataEvent(env, projectId, 'getProjectEventChannelHistory', input);
}

export function followProjectEventChannel(
  env: Env,
  projectId: string,
  input: ProjectDataEventInput<FollowProjectEventChannelInput>
) {
  return callProjectDataEvent(env, projectId, 'followProjectEventChannel', input);
}

export function catchUpProjectEventChannel(
  env: Env,
  projectId: string,
  input: ProjectDataEventInput<CatchUpProjectEventChannelInput>
) {
  return callProjectDataEvent(env, projectId, 'catchUpProjectEventChannel', input);
}

export async function admitProjectEvent(
  env: Env,
  projectId: string,
  input: ProjectDataEventInput<AdmitProjectEventInput>
): Promise<ProjectEventAdmissionResult> {
  return callProjectDataEvent(env, projectId, 'admitProjectEvent', input);
}

export async function createProjectEventSubscription(
  env: Env,
  projectId: string,
  input: ProjectDataEventInput<CreateProjectEventSubscriptionInput>
): Promise<ProjectEventSubscriptionMutationResult> {
  return callProjectDataEvent(env, projectId, 'createProjectEventSubscription', input);
}

export async function listProjectEventSubscriptions(
  env: Env,
  projectId: string,
  input: ProjectDataEventInput<ListProjectEventSubscriptionsInput> = {}
): Promise<ProjectEventSubscriptionListResult> {
  return callProjectDataEvent(env, projectId, 'listProjectEventSubscriptions', input);
}

export async function getProjectEventSubscription(
  env: Env,
  projectId: string,
  input: ProjectDataEventInput<GetProjectEventSubscriptionInput>
): Promise<ProjectEventSubscriptionMutationResult['subscription'] | null> {
  return callProjectDataEvent(env, projectId, 'getProjectEventSubscription', input);
}

export async function cancelProjectEventSubscription(
  env: Env,
  projectId: string,
  input: ProjectDataEventInput<CancelProjectEventSubscriptionInput>
): Promise<ProjectEventSubscriptionMutationResult> {
  return callProjectDataEvent(env, projectId, 'cancelProjectEventSubscription', input);
}

export async function expireProjectEventSubscriptions(
  env: Env,
  projectId: string,
  input: ProjectDataEventInput<ExpireProjectEventSubscriptionsInput> = {}
): Promise<ProjectEventExpireSubscriptionsResult> {
  return callProjectDataEvent(env, projectId, 'expireProjectEventSubscriptions', input);
}

export async function createProjectEventDeliveryBatch(
  env: Env,
  projectId: string,
  input: ProjectDataEventInput<CreateProjectEventDeliveryBatchInput>
): Promise<ProjectEventDeliveryBatchMutationResult> {
  return callProjectDataEvent(env, projectId, 'createProjectEventDeliveryBatch', input);
}

export async function listProjectEventSubscriptionEvents(
  env: Env,
  projectId: string,
  input: ProjectDataEventInput<ListProjectEventSubscriptionEventsInput>
): Promise<ProjectEventSubscriptionEventListResult | null> {
  return callProjectDataEvent(env, projectId, 'listProjectEventSubscriptionEvents', input);
}

export async function getProjectEvent(
  env: Env,
  projectId: string,
  input: ProjectDataEventInput<GetProjectEventInput>
): Promise<ProjectEventSubscriptionEvent | null> {
  return callProjectDataEvent(env, projectId, 'getProjectEvent', input);
}

export async function ackProjectEventDelivery(
  env: Env,
  projectId: string,
  input: ProjectDataEventInput<AckProjectEventDeliveryInput>
): Promise<ProjectEventDeliveryAckResult | null> {
  return callProjectDataEvent(env, projectId, 'ackProjectEventDelivery', input);
}

export async function listProjectEventDeliveryBatches(
  env: Env,
  projectId: string,
  input: ProjectDataEventInput<ListProjectEventDeliveryBatchesInput> = {}
): Promise<ProjectEventDeliveryBatchListResult> {
  return callProjectDataEvent(env, projectId, 'listProjectEventDeliveryBatches', input);
}

export async function recordProjectEventDeliveryAttempt(
  env: Env,
  projectId: string,
  input: ProjectDataEventInput<RecordProjectEventDeliveryAttemptInput>
): Promise<ProjectEventDeliveryAttemptMutationResult> {
  return callProjectDataEvent(env, projectId, 'recordProjectEventDeliveryAttempt', input);
}

export async function listProjectEventDeliveryAttempts(
  env: Env,
  projectId: string,
  input: ProjectDataEventInput<ListProjectEventDeliveryAttemptsInput> = {}
): Promise<ProjectEventDeliveryAttemptListResult> {
  return callProjectDataEvent(env, projectId, 'listProjectEventDeliveryAttempts', input);
}

export async function getProjectEventRecentStatus(
  env: Env,
  projectId: string,
  input: ProjectDataEventInput<GetProjectEventRecentStatusInput> = {}
): Promise<ProjectEventRecentStatus> {
  return callProjectDataEvent(env, projectId, 'getProjectEventRecentStatus', input);
}

export async function validateProjectEventWakeRecoveryAuthority(
  env: Env,
  projectId: string,
  input: ProjectDataEventInput<ValidateProjectEventWakeRecoveryAuthorityInput>
): Promise<boolean> {
  return callProjectDataEvent(env, projectId, 'validateProjectEventWakeRecoveryAuthority', input);
}

export async function runProjectEventRetention(
  env: Env,
  projectId: string,
  input: ProjectDataEventInput<RunProjectEventRetentionInput> = {}
): Promise<ProjectEventRetentionResult> {
  return callProjectDataEvent(env, projectId, 'runProjectEventRetention', input);
}

// --- Library file comments ---------------------------------------------------
// Every entry point is `fileId`-scoped. Callers must have already proven the file
// belongs to `projectId` (see assertLibraryFileInProject) — the DO has no D1.

export async function listFileCommentThreads(
  env: Env,
  projectId: string,
  input: ListFileCommentThreadsInput
): Promise<ListFileCommentThreadsResult> {
  return callProjectDataWithRetry(env, projectId, 'listFileCommentThreads', (stub) =>
    stub.listFileCommentThreads(input)
  );
}

export async function createFileCommentThread(
  env: Env,
  projectId: string,
  input: CreateFileCommentThreadInput
): Promise<LibraryFileCommentMutationResponse> {
  return callProjectDataNoRetry(env, projectId, 'createFileCommentThread', (stub) =>
    stub.createFileCommentThread(input)
  );
}

export async function createFileCommentReply(
  env: Env,
  projectId: string,
  input: CreateFileCommentReplyInput
): Promise<LibraryFileCommentMutationResponse & { reply: CommentReply }> {
  return callProjectDataNoRetry(env, projectId, 'createFileCommentReply', (stub) =>
    stub.createFileCommentReply(input)
  );
}

export async function updateFileCommentThreadStatus(
  env: Env,
  projectId: string,
  input: UpdateFileCommentStatusInput & { status: CommentStatus }
): Promise<LibraryFileCommentMutationResponse> {
  return callProjectDataNoRetry(env, projectId, 'updateFileCommentThreadStatus', (stub) =>
    stub.updateFileCommentThreadStatus(input)
  );
}

/**
 * Materialize sessions whose transcript has outrun their search index.
 *
 * Backfill entry point for sessions that were already sleeping when incremental
 * materialization shipped; ordinary sessions are indexed by their own sleep and
 * stop transitions.
 */
export async function materializePendingSessions(
  env: Env,
  projectId: string,
  limit?: number,
  scanLimit?: number
): Promise<{ materialized: number; errors: number; remaining: number }> {
  const stub = await getStub(env, projectId);
  return stub.materializePendingSessions(limit, scanLimit);
}

export async function getCleanupAt(
  env: Env,
  projectId: string,
  sessionId: string
): Promise<number | null> {
  const stub = await getStub(env, projectId);
  return stub.getCleanupAt(sessionId);
}

export async function markAgentCompleted(
  env: Env,
  projectId: string,
  sessionId: string
): Promise<void> {
  const stub = await getStub(env, projectId);
  return stub.markAgentCompleted(sessionId);
}

// =========================================================================
// Session–Idea Linking (many-to-many)
// =========================================================================

export async function linkSessionIdea(
  env: Env,
  projectId: string,
  sessionId: string,
  taskId: string,
  context: string | null = null
): Promise<void> {
  const stub = await getStub(env, projectId);
  return stub.linkSessionIdea(sessionId, taskId, context);
}

export async function unlinkSessionIdea(
  env: Env,
  projectId: string,
  sessionId: string,
  taskId: string
): Promise<void> {
  const stub = await getStub(env, projectId);
  return stub.unlinkSessionIdea(sessionId, taskId);
}

export async function getIdeasForSession(
  env: Env,
  projectId: string,
  sessionId: string
): Promise<Array<{ taskId: string; context: string | null; createdAt: number }>> {
  const stub = await getStub(env, projectId);
  return stub.getIdeasForSession(sessionId);
}

export async function getSessionsForIdea(
  env: Env,
  projectId: string,
  taskId: string
): Promise<
  Array<{
    sessionId: string;
    topic: string | null;
    status: string;
    context: string | null;
    linkedAt: number;
  }>
> {
  const stub = await getStub(env, projectId);
  return stub.getSessionsForIdea(taskId);
}

// =========================================================================
// Idle Cleanup Schedule
// =========================================================================

export async function scheduleIdleCleanup(
  env: Env,
  projectId: string,
  sessionId: string,
  workspaceId: string,
  taskId: string | null
): Promise<{ cleanupAt: number }> {
  const stub = await getStub(env, projectId);
  return stub.scheduleIdleCleanup(sessionId, workspaceId, taskId);
}

export async function cancelIdleCleanup(
  env: Env,
  projectId: string,
  sessionId: string
): Promise<void> {
  const stub = await getStub(env, projectId);
  return stub.cancelIdleCleanup(sessionId);
}

export async function resetIdleCleanup(
  env: Env,
  projectId: string,
  sessionId: string
): Promise<{ cleanupAt: number }> {
  const stub = await getStub(env, projectId);
  return stub.resetIdleCleanup(sessionId);
}

// =========================================================================
// Activity Events
// =========================================================================

export async function recordActivityEvent(
  env: Env,
  projectId: string,
  eventType: string,
  actorType: string,
  actorId: string | null,
  workspaceId: string | null,
  sessionId: string | null,
  taskId: string | null,
  payload: Record<string, unknown> | null
): Promise<string> {
  return callProjectDataNoRetry(env, projectId, 'recordActivityEvent', (stub) =>
    stub.recordActivityEvent(
      eventType,
      actorType,
      actorId,
      workspaceId,
      sessionId,
      taskId,
      payload ? JSON.stringify(payload) : null
    )
  );
}

export async function listActivityEvents(
  env: Env,
  projectId: string,
  eventType: string | null = null,
  limit: number = 50,
  before: number | null = null,
  sessionId: string | null = null
): Promise<{ events: Record<string, unknown>[]; hasMore: boolean }> {
  return callProjectDataWithRetry(env, projectId, 'listActivityEvents', (stub) =>
    stub.listActivityEvents(eventType, limit, before, sessionId)
  );
}

// =========================================================================
// ACP Sessions (Spec 027 — DO-Owned Lifecycle)
// =========================================================================

import type {
  AcpSession,
  AcpSessionEventActorType,
  AcpSessionStatus,
} from '@simple-agent-manager/shared';

export async function createAcpSession(
  env: Env,
  projectId: string,
  chatSessionId: string,
  initialPrompt: string | null,
  agentType: string | null,
  parentSessionId: string | null = null,
  forkDepth: number = 0,
  id?: string
): Promise<AcpSession> {
  return callProjectDataWithRetry(env, projectId, 'createAcpSession', (stub) =>
    stub.createAcpSession({
      chatSessionId,
      initialPrompt,
      agentType,
      parentSessionId,
      forkDepth,
      id,
    })
  );
}

export async function getAcpSession(
  env: Env,
  projectId: string,
  sessionId: string
): Promise<AcpSession | null> {
  const stub = await getStub(env, projectId);
  return stub.getAcpSession(sessionId);
}

export async function listAcpSessions(
  env: Env,
  projectId: string,
  opts?: {
    chatSessionId?: string;
    status?: AcpSessionStatus;
    nodeId?: string;
    limit?: number;
    offset?: number;
  }
): Promise<{ sessions: AcpSession[]; total: number }> {
  const stub = await getStub(env, projectId);
  return stub.listAcpSessions(opts);
}

export async function getTaskAcpLivenessSignals(
  env: Env,
  projectId: string,
  opts: {
    chatSessionId: string;
    workspaceId: string;
    limit: number;
    nowMs?: number;
  }
): Promise<TaskAcpLivenessSignals> {
  return callProjectDataWithRetry(env, projectId, 'getTaskAcpLivenessSignals', (stub) =>
    stub.getTaskAcpLivenessSignals(opts)
  );
}

export async function transitionAcpSession(
  env: Env,
  projectId: string,
  sessionId: string,
  toStatus: AcpSessionStatus,
  opts: {
    actorType: AcpSessionEventActorType;
    actorId?: string | null;
    reason?: string | null;
    metadata?: Record<string, unknown> | null;
    workspaceId?: string;
    nodeId?: string;
    acpSdkSessionId?: string;
    errorMessage?: string;
  }
): Promise<AcpSession> {
  return callProjectDataWithRetry(env, projectId, 'transitionAcpSession', (stub) =>
    stub.transitionAcpSession(sessionId, toStatus, opts)
  );
}

export async function prepareAcpSessionForFreshStart(
  env: Env,
  projectId: string,
  sessionId: string,
  opts: {
    actorType: AcpSessionEventActorType;
    actorId?: string | null;
    reason?: string | null;
    metadata?: Record<string, unknown> | null;
    workspaceId: string;
    nodeId: string;
  }
): Promise<AcpSession> {
  return callProjectDataWithRetry(env, projectId, 'prepareAcpSessionForFreshStart', (stub) =>
    stub.prepareAcpSessionForFreshStart(sessionId, opts)
  );
}

export async function updateAcpSessionHeartbeat(
  env: Env,
  projectId: string,
  sessionId: string,
  nodeId: string
): Promise<void> {
  const stub = await getStub(env, projectId);
  return stub.updateHeartbeat(sessionId, nodeId);
}

/** Persist activity state in DO, then broadcast. */
export async function reportAcpSessionActivity(
  env: Env,
  projectId: string,
  sessionId: string,
  activity: string,
  extra?: {
    observedAt?: number | null;
    promptStartedAt?: number | null;
    agentType?: string | null;
    restartCount?: number | null;
    statusError?: string | null;
    runtimeWorkState?: 'inactive' | 'active' | 'settling';
    runtimeWorkCount?: number;
    runtimeWorkSource?: string;
    runtimeWorkProgressAt?: number | null;
  }
): Promise<boolean> {
  const stub = await getStub(env, projectId);
  return stub.reportActivity(sessionId, activity, extra);
}

/**
 * Record a control-plane-observed turn ending on the authoritative activity
 * state (cancel / force-stop / dead target). `observedAt` MUST be captured
 * before the long VM-agent call that produced the evidence, so a prompt that
 * started after the observation is never stomped (.claude/rules/49).
 */
export async function recordSessionTurnEnd(
  env: Env,
  projectId: string,
  acpSessionId: string,
  input: { reason: SessionActivityTerminalReason; observedAt: number }
): Promise<boolean> {
  const stub = await getStub(env, projectId);
  return stub.recordSessionTurnEnd(acpSessionId, input);
}

/** Get the persisted session state snapshot (for page load catch-up). */
export async function getSessionState(env: Env, projectId: string, sessionId: string) {
  return callProjectDataWithRetry(env, projectId, 'getSessionState', (stub) =>
    stub.getSessionState(sessionId)
  );
}

export async function registerTaskWait(env: Env, projectId: string, input: RegisterTaskWaitInput) {
  return callProjectDataWithRetry(env, projectId, 'registerTaskWait', (stub) =>
    stub.registerTaskWait(input)
  );
}

export async function getTaskWait(env: Env, projectId: string, subscriptionId: string) {
  const stub = await getStub(env, projectId);
  return stub.getTaskWait(subscriptionId);
}

export async function reconcileTaskWaits(env: Env, projectId: string, childTaskId?: string) {
  return callProjectDataWithRetry(env, projectId, 'reconcileTaskWaits', (stub) =>
    stub.reconcileTaskWaits(childTaskId)
  );
}

/** Get the latest durable plan message snapshot for a chat session. */
export async function getLatestPersistedPlan(env: Env, projectId: string, sessionId: string) {
  const stub = await getStub(env, projectId);
  return stub.getLatestPersistedPlan(sessionId);
}

/**
 * Update heartbeats for all active ACP sessions on a node within a project.
 * Called from the node heartbeat handler to keep ACP sessions alive.
 */
export async function updateNodeHeartbeats(
  env: Env,
  projectId: string,
  nodeId: string
): Promise<number> {
  const stub = await getStub(env, projectId);
  return stub.updateNodeHeartbeats(nodeId);
}

export async function forkAcpSession(
  env: Env,
  projectId: string,
  sessionId: string,
  contextSummary: string
): Promise<AcpSession> {
  const stub = await getStub(env, projectId);
  return stub.forkAcpSession(sessionId, contextSummary);
}

export async function getAcpSessionLineage(
  env: Env,
  projectId: string,
  sessionId: string
): Promise<AcpSession[]> {
  const stub = await getStub(env, projectId);
  return stub.getAcpSessionLineage(sessionId);
}

export async function listAcpSessionsByNode(
  env: Env,
  projectId: string,
  nodeId: string,
  statuses: AcpSessionStatus[]
): Promise<AcpSession[]> {
  const stub = await getStub(env, projectId);
  return stub.listAcpSessionsByNode(nodeId, statuses);
}

// =========================================================================
// Summary
// =========================================================================

export async function getSummary(
  env: Env,
  projectId: string
): Promise<{ lastActivityAt: string; activeSessionCount: number }> {
  const stub = await getStub(env, projectId);
  return stub.getSummary();
}

export async function measureProjectDataStorage(env: Env, projectId: string) {
  return callProjectDataNoRetry(env, projectId, 'measureProjectDataStorage', (stub) =>
    stub.measureStorage()
  );
}

export async function runProjectDataStorageEmergencyPurge(
  env: Env,
  projectId: string,
  input: {
    reason?: string | null;
    targetRatio?: number | null;
    batchRows?: number | null;
    maxBatches?: number | null;
  } = {}
) {
  return callProjectDataNoRetry(env, projectId, 'runProjectDataStorageEmergencyPurge', (stub) =>
    stub.runStorageEmergencyPurge(input)
  );
}

export async function measureProjectDataStorageRelief(
  env: Env,
  projectId: string,
  input: ProjectDataStorageReliefMeasureInput = {}
): Promise<ProjectDataStorageReliefMeasureResult> {
  return callProjectDataNoRetry(env, projectId, 'measureProjectDataStorageRelief', (stub) =>
    stub.measureStorageRelief(input)
  );
}

export async function runProjectDataGroupedFtsCleanup(
  env: Env,
  projectId: string
): Promise<ProjectDataGroupedFtsCleanupResult | null> {
  return callProjectDataNoRetry(env, projectId, 'runProjectDataGroupedFtsCleanup', (stub) =>
    stub.runGroupedFtsCleanup()
  );
}

export async function runProjectDataManualToolPayloadCleanup(
  env: Env,
  projectId: string,
  input: ProjectDataManualToolPayloadCleanupInput
): Promise<ProjectDataManualToolPayloadCleanupResult> {
  return callProjectDataNoRetry(env, projectId, 'runProjectDataManualToolPayloadCleanup', (stub) =>
    stub.runManualToolPayloadCleanup(input)
  );
}

// =========================================================================
// Workspace Activity Tracking
// =========================================================================

/**
 * Record terminal activity for a workspace. Called when a terminal token
 * is requested or the frontend sends a terminal heartbeat.
 */
export async function updateTerminalActivity(
  env: Env,
  projectId: string,
  workspaceId: string,
  sessionId: string | null
): Promise<void> {
  const stub = await getStub(env, projectId);
  await stub.updateTerminalActivity(workspaceId, sessionId);
}

/**
 * Clean up workspace activity tracking for a workspace. Called when a workspace
 * is stopped or deleted to prevent phantom idle checks.
 */
export async function cleanupWorkspaceActivity(
  env: Env,
  projectId: string,
  workspaceId: string
): Promise<void> {
  const stub = await getStub(env, projectId);
  await stub.cleanupWorkspaceActivity(workspaceId);
}

// =========================================================================
// Cached Commands
// =========================================================================

export async function cacheCommands(
  env: Env,
  projectId: string,
  agentType: string,
  cmds: Array<{ name: string; description: string }>
): Promise<void> {
  const stub = await getStub(env, projectId);
  await stub.cacheCommands(agentType, cmds);
}

export async function getCachedCommands(
  env: Env,
  projectId: string,
  agentType?: string
): Promise<Array<{ agentType: string; name: string; description: string; updatedAt: number }>> {
  const stub = await getStub(env, projectId);
  return stub.getCachedCommands(agentType);
}

// =========================================================================
// Knowledge Graph
// =========================================================================

export async function createKnowledgeEntity(
  env: Env,
  projectId: string,
  name: string,
  entityType: string,
  description: string | null
): Promise<{ id: string; createdAt: number }> {
  const stub = await getStub(env, projectId);
  return stub.createKnowledgeEntity(name, entityType, description);
}

export async function getKnowledgeEntity(env: Env, projectId: string, entityId: string) {
  const stub = await getStub(env, projectId);
  return stub.getKnowledgeEntity(entityId);
}

export async function getKnowledgeEntityByName(env: Env, projectId: string, name: string) {
  const stub = await getStub(env, projectId);
  return stub.getKnowledgeEntityByName(name);
}

export async function listKnowledgeEntities(
  env: Env,
  projectId: string,
  entityType: string | null,
  limit: number,
  offset: number
) {
  const stub = await getStub(env, projectId);
  return stub.listKnowledgeEntities(entityType, limit, offset);
}

export async function updateKnowledgeEntity(
  env: Env,
  projectId: string,
  entityId: string,
  updates: { name?: string; entityType?: string; description?: string | null }
) {
  const stub = await getStub(env, projectId);
  return stub.updateKnowledgeEntity(entityId, updates);
}

export async function deleteKnowledgeEntity(env: Env, projectId: string, entityId: string) {
  const stub = await getStub(env, projectId);
  return stub.deleteKnowledgeEntity(entityId);
}

export async function addKnowledgeObservation(
  env: Env,
  projectId: string,
  entityId: string,
  content: string,
  confidence: number,
  sourceType: string,
  sourceSessionId: string | null
): Promise<{ id: string; createdAt: number }> {
  const stub = await getStub(env, projectId);
  return stub.addKnowledgeObservation(entityId, content, confidence, sourceType, sourceSessionId);
}

export async function updateKnowledgeObservation(
  env: Env,
  projectId: string,
  observationId: string,
  newContent: string,
  confidence: number | null
) {
  const stub = await getStub(env, projectId);
  return stub.updateKnowledgeObservation(observationId, newContent, confidence);
}

export async function removeKnowledgeObservation(
  env: Env,
  projectId: string,
  observationId: string
) {
  const stub = await getStub(env, projectId);
  return stub.removeKnowledgeObservation(observationId);
}

export async function confirmKnowledgeObservation(
  env: Env,
  projectId: string,
  observationId: string
) {
  const stub = await getStub(env, projectId);
  return stub.confirmKnowledgeObservation(observationId);
}

export async function getKnowledgeObservationsForEntity(
  env: Env,
  projectId: string,
  entityId: string,
  includeInactive: boolean
) {
  const stub = await getStub(env, projectId);
  return stub.getKnowledgeObservationsForEntity(entityId, includeInactive);
}

export async function searchKnowledgeObservations(
  env: Env,
  projectId: string,
  query: string,
  entityType: string | null,
  minConfidence: number | null,
  limit: number
) {
  const stub = await getStub(env, projectId);
  return stub.searchKnowledgeObservations(query, entityType, minConfidence, limit);
}

export async function getRelevantKnowledge(
  env: Env,
  projectId: string,
  context: string,
  limit: number
) {
  const stub = await getStub(env, projectId);
  return stub.getRelevantKnowledge(context, limit);
}

export async function getAllHighConfidenceKnowledge(
  env: Env,
  projectId: string,
  minConfidence: number,
  limit: number,
  perEntityLimit?: number
) {
  const stub = await getStub(env, projectId);
  return stub.getAllHighConfidenceKnowledge(minConfidence, limit, perEntityLimit);
}

export async function getKnowledgeEntityIndex(env: Env, projectId: string, limit?: number) {
  const stub = await getStub(env, projectId);
  return stub.getKnowledgeEntityIndex(limit);
}

export async function createKnowledgeRelation(
  env: Env,
  projectId: string,
  sourceEntityId: string,
  targetEntityId: string,
  relationType: string,
  description: string | null
) {
  const stub = await getStub(env, projectId);
  return stub.createKnowledgeRelation(sourceEntityId, targetEntityId, relationType, description);
}

export async function getKnowledgeRelated(
  env: Env,
  projectId: string,
  entityId: string,
  relationType: string | null
) {
  const stub = await getStub(env, projectId);
  return stub.getKnowledgeRelated(entityId, relationType);
}

export async function flagKnowledgeContradiction(
  env: Env,
  projectId: string,
  existingObservationId: string,
  newObservation: string,
  sourceSessionId: string | null
) {
  const stub = await getStub(env, projectId);
  return stub.flagKnowledgeContradiction(existingObservationId, newObservation, sourceSessionId);
}

// ── Project Policies (Phase 4: Policy Propagation) ───────────────────────
export {
  createPolicy,
  getActivePolicies,
  getPolicy,
  listPolicies,
  removePolicy,
  updatePolicy,
} from './project-data-policies';

// ── Agent Mailbox (Durable Messaging) ────────────────────────────────────

export async function acceptPromptDelivery(
  env: Env,
  projectId: string,
  input: AcceptPromptDeliveryInput
): Promise<AcceptedPromptDelivery> {
  const stub = await getStub(env, projectId);
  return stub.acceptPromptDelivery(input);
}

export async function enqueueMailboxMessage(
  env: Env,
  projectId: string,
  opts: {
    targetSessionId: string;
    sourceTaskId: string | null;
    senderType: 'agent' | 'orchestrator' | 'system' | 'human';
    senderId: string | null;
    messageClass: MessageClass;
    content: string;
    metadata?: Record<string, unknown> | null;
    ackTimeoutMs?: number | null;
    ttlMs?: number | null;
    maxMessages?: number;
  }
): Promise<AgentMailboxMessage> {
  const stub = await getStub(env, projectId);
  return stub.enqueueMailboxMessage(opts);
}

export async function getPendingMailboxMessages(
  env: Env,
  projectId: string,
  targetSessionId: string,
  limit?: number
): Promise<AgentMailboxMessage[]> {
  const stub = await getStub(env, projectId);
  return stub.getPendingMailboxMessages(targetSessionId, limit);
}

export async function getMailboxMessage(
  env: Env,
  projectId: string,
  messageId: string
): Promise<AgentMailboxMessage | null> {
  const stub = await getStub(env, projectId);
  return stub.getMailboxMessage(messageId);
}

export async function markMailboxMessageDelivered(
  env: Env,
  projectId: string,
  messageId: string
): Promise<boolean> {
  const stub = await getStub(env, projectId);
  return stub.markMailboxMessageDelivered(messageId);
}

export async function acknowledgeMailboxMessage(
  env: Env,
  projectId: string,
  messageId: string
): Promise<boolean> {
  const stub = await getStub(env, projectId);
  return stub.acknowledgeMailboxMessage(messageId);
}

export async function listMailboxMessages(
  env: Env,
  projectId: string,
  opts?: {
    targetSessionId?: string;
    deliveryState?: DeliveryState;
    messageClass?: MessageClass;
    limit?: number;
    offset?: number;
  }
): Promise<{ messages: AgentMailboxMessage[]; total: number }> {
  const stub = await getStub(env, projectId);
  return stub.listMailboxMessages(opts);
}

export async function cancelMailboxMessage(
  env: Env,
  projectId: string,
  messageId: string
): Promise<boolean> {
  const stub = await getStub(env, projectId);
  return stub.cancelMailboxMessage(messageId);
}

export async function getMailboxStats(
  env: Env,
  projectId: string
): Promise<Record<string, number>> {
  const stub = await getStub(env, projectId);
  return stub.getMailboxStats();
}

export async function createCheckpointEpisode(
  env: Env,
  projectId: string,
  input: CreateCheckpointEpisodeInput
): Promise<{ episode: CheckpointEpisode; created: boolean }> {
  const stub = await getStub(env, projectId);
  return stub.createCheckpointEpisode(input);
}

export async function getCheckpointEpisode(
  env: Env,
  projectId: string,
  episodeId: string
): Promise<CheckpointEpisode | null> {
  const stub = await getStub(env, projectId);
  return stub.getCheckpointEpisode(episodeId);
}

export async function transitionCheckpointEpisode(
  env: Env,
  projectId: string,
  episodeId: string,
  input: CheckpointEpisodeTransitionInput
): Promise<CheckpointEpisode | null> {
  const stub = await getStub(env, projectId);
  return stub.transitionCheckpointEpisode(episodeId, input);
}

export async function getDurableExecutionSnapshot(env: Env, projectId: string, sessionId: string) {
  const stub = await getStub(env, projectId);
  return stub.getDurableExecutionSnapshot(sessionId);
}

// ── Mission State & Handoffs ──────────────────────────────────────────────

export async function createMissionStateEntry(
  env: Env,
  projectId: string,
  missionId: string,
  entryType: string,
  title: string,
  content: string | null,
  sourceTaskId: string | null
) {
  const stub = await getStub(env, projectId);
  const limits = resolveMissionStateLimits(env);
  return stub.createMissionStateEntry(missionId, entryType, title, content, sourceTaskId, limits);
}

export async function getMissionStateEntries(
  env: Env,
  projectId: string,
  missionId: string,
  entryType: string | null
) {
  const stub = await getStub(env, projectId);
  return stub.getMissionStateEntries(missionId, entryType);
}

export async function getMissionStateEntry(env: Env, projectId: string, entryId: string) {
  const stub = await getStub(env, projectId);
  return stub.getMissionStateEntry(entryId);
}

export async function updateMissionStateEntry(
  env: Env,
  projectId: string,
  entryId: string,
  updates: { title?: string; content?: string | null }
) {
  const stub = await getStub(env, projectId);
  const limits = resolveMissionStateLimits(env);
  return stub.updateMissionStateEntry(entryId, updates, limits);
}

export async function deleteMissionStateEntry(env: Env, projectId: string, entryId: string) {
  const stub = await getStub(env, projectId);
  return stub.deleteMissionStateEntry(entryId);
}

export async function createHandoffPacket(
  env: Env,
  projectId: string,
  missionId: string,
  fromTaskId: string,
  toTaskId: string | null,
  summary: string,
  facts: unknown[],
  openQuestions: string[],
  artifactRefs: unknown[],
  suggestedActions: string[]
) {
  const stub = await getStub(env, projectId);
  const limits = resolveHandoffLimits(env);
  return stub.createHandoffPacket(
    missionId,
    fromTaskId,
    toTaskId,
    summary,
    facts,
    openQuestions,
    artifactRefs,
    suggestedActions,
    limits
  );
}

export async function getHandoffPackets(env: Env, projectId: string, missionId: string) {
  const stub = await getStub(env, projectId);
  return stub.getHandoffPackets(missionId);
}

export async function getHandoffPacket(env: Env, projectId: string, handoffId: string) {
  const stub = await getStub(env, projectId);
  return stub.getHandoffPacket(handoffId);
}

export async function getHandoffPacketsForTask(env: Env, projectId: string, taskId: string) {
  const stub = await getStub(env, projectId);
  return stub.getHandoffPacketsForTask(taskId);
}

// =========================================================================

/**
 * Forward a WebSocket upgrade request to the project's DO.
 * Returns the Response from the DO (101 Switching Protocols).
 */
export async function forwardWebSocket(
  env: Env,
  projectId: string,
  request: Request
): Promise<Response> {
  return callProjectDataWithRetry(env, projectId, 'forwardWebSocket', (stub) => {
    const url = new URL(request.url);
    url.pathname = '/ws';
    return stub.fetch(new Request(url.toString(), request));
  });
}

// =========================================================================
// Attention Markers
// =========================================================================

export async function createAttentionMarker(
  env: Env,
  projectId: string,
  opts: {
    sessionId: string;
    taskId: string | null;
    workspaceId: string | null;
    kind: string;
    source: string;
    sourceNotificationId?: string | null;
    notificationUserId?: string | null;
    reason?: string | null;
    metadata?: string | null;
    expiresAt?: number | null;
    nextEscalationAt?: number | null;
    maxExpiresAt?: number | null;
  }
): Promise<{ id: string; createdAt: number; expiresAt: number | null }> {
  const stub = await getStub(env, projectId);
  return stub.createAttentionMarker(opts);
}

export async function linkAttentionNotification(
  env: Env,
  projectId: string,
  markerId: string,
  notificationUserId: string,
  notificationId: string
): Promise<boolean> {
  const stub = await getStub(env, projectId);
  return stub.linkAttentionNotification(markerId, notificationUserId, notificationId);
}

export async function prepareAttentionAnswer(
  env: Env,
  projectId: string,
  sessionId: string,
  markerId: string,
  answer: string
) {
  const stub = await getStub(env, projectId);
  return stub.prepareAttentionAnswer(sessionId, markerId, answer);
}

export async function completeAttentionAnswer(
  env: Env,
  projectId: string,
  sessionId: string,
  markerId: string,
  answer: string
): Promise<number> {
  const stub = await getStub(env, projectId);
  return stub.completeAttentionAnswer(sessionId, markerId, answer);
}

export async function releaseAttentionAnswer(
  env: Env,
  projectId: string,
  sessionId: string,
  markerId: string,
  answer: string
): Promise<number> {
  const stub = await getStub(env, projectId);
  return stub.releaseAttentionAnswer(sessionId, markerId, answer);
}

export async function resolveSessionAttentionMarkers(
  env: Env,
  projectId: string,
  sessionId: string,
  resolvedByMessageId: string | null,
  actorType: string = 'human',
  reason: string = 'human_message'
): Promise<number> {
  const stub = await getStub(env, projectId);
  return stub.resolveSessionAttentionMarkers(sessionId, resolvedByMessageId, actorType, reason);
}

export function createProjectSchedule(
  env: Env,
  projectId: string,
  input: Omit<Parameters<ProjectData['createProjectSchedule']>[0], 'projectId'>
) {
  return callProjectDataNoRetry(env, projectId, 'createProjectSchedule', (stub) =>
    stub.createProjectSchedule({ ...input, projectId })
  );
}
export function getProjectSchedule(
  env: Env,
  projectId: string,
  input: Omit<Parameters<ProjectData['getProjectSchedule']>[0], 'projectId'>
) {
  return callProjectDataNoRetry(env, projectId, 'getProjectSchedule', (stub) =>
    stub.getProjectSchedule({ ...input, projectId })
  );
}
export function listProjectSchedules(
  env: Env,
  projectId: string,
  input: Omit<Parameters<ProjectData['listProjectSchedules']>[0], 'projectId'>
) {
  return callProjectDataNoRetry(env, projectId, 'listProjectSchedules', (stub) =>
    stub.listProjectSchedules({ ...input, projectId })
  );
}
export function mutateProjectSchedule(
  env: Env,
  projectId: string,
  input: Omit<Parameters<ProjectData['mutateProjectSchedule']>[0], 'projectId'>
) {
  return callProjectDataNoRetry(env, projectId, 'mutateProjectSchedule', (stub) =>
    stub.mutateProjectSchedule({ ...input, projectId })
  );
}

export function reconcileProjectSchedule(
  env: Env,
  projectId: string,
  input: Omit<Parameters<ProjectData['reconcileProjectSchedule']>[0], 'projectId'>
) {
  return callProjectDataNoRetry(env, projectId, 'reconcileProjectSchedule', (stub) =>
    stub.reconcileProjectSchedule({ ...input, projectId })
  );
}

export function createProjectStandingWatch(
  env: Env,
  projectId: string,
  input: Omit<Parameters<ProjectData['createProjectStandingWatch']>[0], 'projectId'>
) {
  return callProjectDataNoRetry(env, projectId, 'createProjectStandingWatch', (stub) =>
    stub.createProjectStandingWatch({ ...input, projectId })
  );
}

export function getProjectStandingWatch(
  env: Env,
  projectId: string,
  input: Omit<Parameters<ProjectData['getProjectStandingWatch']>[0], 'projectId'>
) {
  return callProjectDataNoRetry(env, projectId, 'getProjectStandingWatch', (stub) =>
    stub.getProjectStandingWatch({ ...input, projectId })
  );
}

export function listProjectStandingWatches(
  env: Env,
  projectId: string,
  input: Omit<Parameters<ProjectData['listProjectStandingWatches']>[0], 'projectId'>
) {
  return callProjectDataNoRetry(env, projectId, 'listProjectStandingWatches', (stub) =>
    stub.listProjectStandingWatches({ ...input, projectId })
  );
}

export function mutateProjectStandingWatch(
  env: Env,
  projectId: string,
  input: Omit<Parameters<ProjectData['mutateProjectStandingWatch']>[0], 'projectId'>
) {
  return callProjectDataNoRetry(env, projectId, 'mutateProjectStandingWatch', (stub) =>
    stub.mutateProjectStandingWatch({ ...input, projectId })
  );
}
