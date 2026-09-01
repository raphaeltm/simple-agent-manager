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
  GetProjectEventInput,
  GetProjectEventRecentStatusInput,
  GetProjectEventSubscriptionInput,
  LibraryFileCommentMutationResponse,
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
  RecordProjectEventDeliveryAttemptInput,
  RunProjectEventRetentionInput,
  SessionActivityTerminalReason,
} from '@simple-agent-manager/shared';
import { resolveHandoffLimits, resolveMissionStateLimits } from '@simple-agent-manager/shared';

import type { ProjectData } from '../durable-objects/project-data';
import type {
  ArchiveChunk,
  ArchiveRehomeSourceFence,
  ArchiveRpcFence,
  SourceArchiveEligibility,
  SourceDeletedProof,
} from '../durable-objects/project-data/archive-sharding';
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
import { CommentNotFoundError } from '../durable-objects/project-data/comment-contracts';
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
import type {
  AcceptedPromptDelivery,
  AcceptPromptDeliveryInput,
} from '../durable-objects/project-data/prompt-delivery';
import type { RegisterTaskWaitInput } from '../durable-objects/project-data/task-waits';
import type { Env } from '../env';
import { log } from '../lib/logger';
import {
  computeDurableObjectRetryDelayMs,
  getDurableObjectRetryConfig,
  isDurableObjectStorageFullError,
  isTransientDurableObjectError,
} from './durable-object-retry';
import {
  assertProjectDataSessionWriteAllowed,
  resolveProjectDataOwnerLocation,
} from './project-data-archive-routing';
import type { ProjectDataOwnerLocation } from './project-data-archive-types';
import {
  PROJECT_DATA_ARCHIVE_ROUTING_VERSION,
  ProjectDataArchiveRoutingError,
  resolveArchiveShardingConfig,
} from './project-data-archive-types';
import { ensureOncePerIsolate, forgetEnsuredProjectData } from './project-data-ensure-memo';
import { toProjectDataStorageFullError } from './project-data-storage-errors';
import {
  buildSessionLifecycleEventInput,
  type SessionLifecycleEventInput,
} from './project-lifecycle-event-inputs';
import { hasAuthorizedRestorableSnapshotWakeClaim } from './session-snapshots';
import type { TaskAcpLivenessSignals } from './task-runtime-liveness';

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
async function getStub(env: Env, projectId: string): Promise<DurableObjectStub<ProjectData>> {
  const id = env.PROJECT_DATA.idFromName(projectId);
  const stub = env.PROJECT_DATA.get(id) as DurableObjectStub<ProjectData>;
  await ensureOncePerIsolate(env, id.toString(), async () => {
    await stub.ensureProjectId(projectId);
  });
  return stub;
}

async function getNamedProjectDataStub(
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

function archiveExpectedLocation(location: ProjectDataOwnerLocation) {
  if (location.state !== 'archive_shard' || !location.migrationId) {
    throw new Error('ProjectData archive exact location is not authoritative');
  }
  return {
    projectId: location.projectId,
    sessionId: location.sessionId,
    migrationId: location.migrationId,
    ownerName: location.owner.name,
    generation: location.owner.generation,
  };
}

/**
 * Forget the memoized ensure for a project after a failed DO call, so a Durable
 * Object that was reset mid-flight re-persists its projectId on the next attempt.
 */
function forgetEnsuredProject(env: Env, projectId: string): void {
  forgetEnsuredProjectData(env.PROJECT_DATA.idFromName(projectId).toString());
}

function normalizeProjectDataRpcError(projectId: string, operation: string, err: unknown): unknown {
  if (isDurableObjectStorageFullError(err)) {
    return toProjectDataStorageFullError(projectId, operation, err);
  }
  const commentError = normalizeProjectDataCommentRpcError(err);
  if (commentError) return commentError;
  const eventError = normalizeProjectDataEventRpcError(err);
  if (eventError) return eventError;
  return err;
}

function normalizeProjectDataCommentRpcError(err: unknown): Error | null {
  if (!(err instanceof Error)) return null;

  // Cloudflare DO RPC serializes custom Error subclasses across isolates as a
  // generic Error whose message includes the original class name. Keep this
  // deliberately exact so non-domain failures continue to surface as 500s.
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

export async function linkSessionToWorkspace(
  env: Env,
  projectId: string,
  sessionId: string,
  workspaceId: string
): Promise<void> {
  await assertProjectDataSessionWriteAllowed(env.DATABASE, projectId, sessionId);
  return callProjectDataWithRetry(env, projectId, 'linkSessionToWorkspace', (stub) =>
    stub.linkSessionToWorkspace(sessionId, workspaceId)
  );
}

export async function stopSession(
  env: Env,
  projectId: string,
  sessionId: string
): Promise<boolean> {
  await assertProjectDataSessionWriteAllowed(env.DATABASE, projectId, sessionId);
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
  await assertProjectDataSessionWriteAllowed(env.DATABASE, projectId, sessionId);
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
  await assertProjectDataSessionWriteAllowed(env.DATABASE, projectId, sessionId);
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
  const allowStopped = await hasAuthorizedRestorableSnapshotWakeClaim(env.DATABASE, {
    projectId,
    chatSessionId: sessionId,
    workspaceId,
    taskId,
  });
  if (!allowStopped) return false;
  await assertProjectDataSessionWriteAllowed(env.DATABASE, projectId, sessionId);
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
  errorMessage: string | null = null
): Promise<boolean> {
  await assertProjectDataSessionWriteAllowed(env.DATABASE, projectId, sessionId);
  const stub = await getStub(env, projectId);
  const failed = await stub.failSession(sessionId, errorMessage);
  if (failed) {
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
  await assertProjectDataSessionWriteAllowed(env.DATABASE, projectId, sessionId);
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
  messageId?: string
): Promise<string> {
  await assertProjectDataSessionWriteAllowed(env.DATABASE, projectId, sessionId);
  return callProjectDataNoRetry(env, projectId, 'persistMessage', (stub) =>
    stub.persistMessage(
      sessionId,
      role,
      content,
      toolMetadata ? JSON.stringify(toolMetadata) : null,
      messageId
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
  await assertProjectDataSessionWriteAllowed(env.DATABASE, projectId, sessionId);
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
  await assertProjectDataSessionWriteAllowed(env.DATABASE, projectId, sessionId);
  return callProjectDataWithRetry(env, projectId, 'linkSessionToTask', (stub) =>
    stub.linkSessionToTask(sessionId, taskId)
  );
}

export async function getSession(
  env: Env,
  projectId: string,
  sessionId: string
): Promise<Record<string, unknown> | null> {
  // Root owns the lifecycle anchor even after transcript placement. Resolve D1
  // first so a transitional or malformed location can never be ignored.
  await resolveProjectDataOwnerLocation(env.DATABASE, projectId, sessionId);
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
  const location = await resolveProjectDataOwnerLocation(env.DATABASE, projectId, sessionId);
  if (location.state === 'root') {
    return callProjectDataWithRetry(env, projectId, 'getMessages', (stub) =>
      stub.getMessages(sessionId, limit, before, after, roles, compact, order)
    );
  }
  const stub = await getNamedProjectDataStub(env, projectId, location.owner.name);
  return stub.archiveGetMessages(
    archiveExpectedLocation(location),
    limit,
    before,
    after,
    roles,
    compact,
    order
  );
}

export async function getMessageToolContent(
  env: Env,
  projectId: string,
  sessionId: string,
  messageId: string
): Promise<MessageToolContentResult | null> {
  const location = await resolveProjectDataOwnerLocation(env.DATABASE, projectId, sessionId);
  const stub = await getNamedProjectDataStub(env, projectId, location.owner.name);
  return location.state === 'root'
    ? stub.getMessageToolContent(sessionId, messageId)
    : stub.archiveGetMessageToolContent(archiveExpectedLocation(location), messageId);
}

type ArchiveOwnerPlane = { projectId: string; ownerName: string; routingVersion: number };

async function resolveArchiveOwnerPlanes(
  env: Env,
  projectId: string,
  maxOwners: number,
  routingVersion: number
): Promise<{ owners: ArchiveOwnerPlane[]; partial: boolean }> {
  const invalid = await env.DATABASE.prepare(
    `SELECT 1 AS invalid
       FROM project_data_session_locations location
      WHERE location.project_id = ? AND (
        location.routing_version != ? OR
        location.state = 'direct_session' OR
        location.state = 'migrating' OR
        (location.state = 'root' AND (
          location.owner_kind != 'root' OR location.owner_name != location.project_id OR
          location.generation != 0 OR location.migration_id IS NOT NULL OR EXISTS (
            SELECT 1 FROM project_data_archive_migrations migration
             WHERE migration.project_id = location.project_id
               AND migration.session_id = location.session_id
               AND migration.state = 'archived'
               AND migration.target_generation = 0
               AND (migration.target_authoritative_at IS NULL OR migration.target_cleanup_at IS NULL)
          )
        )) OR
        (location.state = 'archive_shard' AND (
          location.owner_kind != 'archive_shard' OR location.generation <= 0 OR
          substr(location.owner_name, 1,
            length('project-data-archive:' || location.project_id || ':'))
            != 'project-data-archive:' || location.project_id || ':' OR
          CAST(CAST(substr(location.owner_name,
            length('project-data-archive:' || location.project_id || ':') + 1) AS INTEGER) AS TEXT)
            != substr(location.owner_name,
              length('project-data-archive:' || location.project_id || ':') + 1) OR
          location.migration_id IS NULL OR NOT EXISTS (
            SELECT 1 FROM project_data_archive_migrations migration
             WHERE migration.migration_id = location.migration_id
               AND migration.project_id = location.project_id
               AND migration.session_id = location.session_id
               AND migration.state = 'archived'
               AND migration.target_owner_name = location.owner_name
               AND migration.target_generation = location.generation
               AND migration.target_authoritative_at IS NOT NULL
          )
        )) OR
        (location.state = 'migrating' AND (
          location.migration_id IS NULL OR
          (location.generation = 0 AND (
            location.owner_kind != 'root' OR location.owner_name != location.project_id
          )) OR
          (location.generation > 0 AND (
            location.owner_kind != 'archive_shard' OR
            substr(location.owner_name, 1,
              length('project-data-archive:' || location.project_id || ':'))
              != 'project-data-archive:' || location.project_id || ':' OR
            CAST(CAST(substr(location.owner_name,
              length('project-data-archive:' || location.project_id || ':') + 1) AS INTEGER) AS TEXT)
              != substr(location.owner_name,
                length('project-data-archive:' || location.project_id || ':') + 1)
          )) OR NOT EXISTS (
            SELECT 1 FROM project_data_archive_migrations migration
             WHERE migration.migration_id = location.migration_id
               AND migration.project_id = location.project_id
               AND migration.session_id = location.session_id
               AND migration.source_owner_name = location.owner_name
               AND migration.source_generation = location.generation
               AND migration.state IN ('planned', 'copying', 'sealed', 'source_deleted', 'failed', 'frozen')
          )
        ))
      ) LIMIT 1`
  )
    .bind(projectId, routingVersion)
    .first();
  if (invalid) {
    throw new ProjectDataArchiveRoutingError(
      'ProjectData project-wide read rejected ambiguous routing state'
    );
  }
  const ownerRows = await env.DATABASE.prepare(
    `SELECT DISTINCT location.owner_name
       FROM project_data_session_locations location
       JOIN project_data_archive_migrations migration
         ON migration.migration_id = location.migration_id
        AND migration.project_id = location.project_id
        AND migration.session_id = location.session_id
        AND migration.state = 'archived'
        AND migration.target_owner_name = location.owner_name
        AND migration.target_generation = location.generation
        AND migration.target_authoritative_at IS NOT NULL
      WHERE location.project_id = ? AND location.state = 'archive_shard'
        AND location.owner_kind = 'archive_shard' AND location.routing_version = ?
      ORDER BY location.owner_name LIMIT ?`
  )
    .bind(projectId, routingVersion, maxOwners + 1)
    .all<{ owner_name: string }>();
  const prefix = `project-data-archive:${projectId}:`;
  const names = ownerRows.results.map((row) => row.owner_name);
  for (const ownerName of names) {
    const shardText = ownerName.startsWith(prefix) ? ownerName.slice(prefix.length) : '';
    if (!/^(0|[1-9]\d*)$/.test(shardText) || !Number.isSafeInteger(Number(shardText))) {
      throw new ProjectDataArchiveRoutingError(
        'ProjectData project-wide read rejected an invalid archive owner identity'
      );
    }
  }
  return {
    owners: names.slice(0, maxOwners).map((ownerName) => ({
      projectId,
      ownerName,
      routingVersion,
    })),
    partial: names.length > maxOwners,
  };
}

async function assertProjectWidePlaneAuthority(
  env: Env,
  projectId: string,
  expectations: Iterable<{ ownerName: string; sessionId: string }>
): Promise<void> {
  const unique = new Map<string, { ownerName: string; sessionId: string }>();
  for (const expectation of expectations) {
    unique.set(`${expectation.ownerName}\u0000${expectation.sessionId}`, expectation);
  }
  if (unique.size === 0) return;
  const rows = await env.DATABASE.prepare(
    `WITH expected AS (
       SELECT json_extract(value, '$.ownerName') AS expected_owner_name,
              json_extract(value, '$.sessionId') AS session_id
         FROM json_each(?)
     )
     SELECT expected.expected_owner_name, expected.session_id,
            location.state, location.owner_kind, location.owner_name,
            location.generation, location.migration_id, location.routing_version,
            migration.state AS migration_state,
            migration.target_owner_name, migration.target_generation,
            migration.target_authoritative_at
       FROM expected
       LEFT JOIN project_data_session_locations location
         ON location.project_id = ? AND location.session_id = expected.session_id
       LEFT JOIN project_data_archive_migrations migration
         ON migration.migration_id = location.migration_id
        AND migration.project_id = location.project_id
        AND migration.session_id = location.session_id`
  )
    .bind(JSON.stringify([...unique.values()]), projectId)
    .all<Record<string, unknown>>();
  if (rows.results.length !== unique.size) {
    throw new ProjectDataArchiveRoutingError(
      'ProjectData project-wide read authority batch was incomplete'
    );
  }
  for (const row of rows.results) {
    const expectedOwner = row.expected_owner_name;
    const legacyRoot = expectedOwner === projectId && row.state === null && row.owner_name === null;
    const exactRoot =
      expectedOwner === projectId &&
      row.state === 'root' &&
      row.owner_kind === 'root' &&
      row.owner_name === projectId &&
      row.generation === 0 &&
      row.migration_id === null &&
      row.routing_version === PROJECT_DATA_ARCHIVE_ROUTING_VERSION;
    const exactArchive =
      expectedOwner !== projectId &&
      row.state === 'archive_shard' &&
      row.owner_kind === 'archive_shard' &&
      row.owner_name === expectedOwner &&
      typeof row.generation === 'number' &&
      row.generation > 0 &&
      typeof row.migration_id === 'string' &&
      row.routing_version === PROJECT_DATA_ARCHIVE_ROUTING_VERSION &&
      row.migration_state === 'archived' &&
      row.target_owner_name === expectedOwner &&
      row.target_generation === row.generation &&
      typeof row.target_authoritative_at === 'number';
    if (!legacyRoot && !exactRoot && !exactArchive) {
      throw new ProjectDataArchiveRoutingError(
        'ProjectData project-wide read result lost exact location authority'
      );
    }
  }
}

export async function getArchivedToolPayloads(
  env: Env,
  projectId: string,
  input: ArchivedToolPayloadQuery
): Promise<ArchivedToolPayloadListResult> {
  if (!input.sessionId) {
    const config = resolveArchiveShardingConfig(env);
    const { owners, partial } = await resolveArchiveOwnerPlanes(
      env,
      projectId,
      config.searchMaxOwners,
      config.routingVersion
    );
    const root = await getStub(env, projectId);
    const planes = await Promise.all([
      (async () => {
        const result = (await root.rootListAuthoritativeToolPayloads(
          projectId,
          input
        )) as unknown as ArchivedToolPayloadListResult;
        return { ownerName: projectId, result };
      })(),
      ...owners.map(async (owner) => {
        const stub = await getNamedProjectDataStub(env, projectId, owner.ownerName);
        const result = (await stub.archiveListOwnerToolPayloads(
          owner,
          input
        )) as unknown as ArchivedToolPayloadListResult;
        return { ownerName: owner.ownerName, result };
      }),
    ]);
    await assertProjectWidePlaneAuthority(
      env,
      projectId,
      planes.flatMap((plane) =>
        plane.result.payloads.map((payload) => ({
          ownerName: plane.ownerName,
          sessionId: payload.sessionId,
        }))
      )
    );
    const payloads = planes
      .flatMap((plane) => plane.result.payloads)
      .sort(
        (a, b) =>
          a.messageCreatedAt - b.messageCreatedAt ||
          a.messageSequence - b.messageSequence ||
          a.messageId.localeCompare(b.messageId)
      )
      .slice(0, input.limit);
    return {
      projectId,
      payloads,
      count: payloads.length,
      hasMore: partial || planes.some((plane) => plane.result.hasMore),
      partial,
      ownersQueried: owners.length + 1,
      partialReason: partial ? 'archive_owner_limit_reached' : null,
    };
  }
  const location = await resolveProjectDataOwnerLocation(env.DATABASE, projectId, input.sessionId);
  const stub = await getNamedProjectDataStub(env, projectId, location.owner.name);
  return location.state === 'root'
    ? stub.getArchivedToolPayloads(input)
    : stub.archiveGetArchivedToolPayloads(archiveExpectedLocation(location), input);
}

/** Get total message count for a session, optionally filtered by roles. */
export async function getMessageCount(
  env: Env,
  projectId: string,
  sessionId: string,
  roles?: string[]
): Promise<number> {
  const location = await resolveProjectDataOwnerLocation(env.DATABASE, projectId, sessionId);
  const stub = await getNamedProjectDataStub(env, projectId, location.owner.name);
  return location.state === 'root'
    ? stub.getMessageCount(sessionId, roles)
    : stub.archiveGetMessageCount(archiveExpectedLocation(location), roles);
}

/** Search messages across sessions by keyword. */
export async function searchMessages(
  env: Env,
  projectId: string,
  query: string,
  sessionId: string | null = null,
  roles: string[] | null = null,
  limit: number = 10
): Promise<{
  results: Array<{
    id: string;
    sessionId: string;
    role: string;
    snippet: string;
    createdAt: number;
    sessionTopic: string | null;
    sessionTaskId: string | null;
  }>;
  partial: boolean;
  ownersQueried: number;
  reason: string | null;
}> {
  if (sessionId) {
    const location = await resolveProjectDataOwnerLocation(env.DATABASE, projectId, sessionId);
    const stub = await getNamedProjectDataStub(env, projectId, location.owner.name);
    const results =
      location.state === 'root'
        ? await stub.searchMessages(query, sessionId, roles, limit)
        : await stub.archiveSearchSessionMessages(
            archiveExpectedLocation(location),
            query,
            roles,
            limit
          );
    return { results, partial: false, ownersQueried: 1, reason: null };
  }
  const config = resolveArchiveShardingConfig(env);
  const { owners, partial } = await resolveArchiveOwnerPlanes(
    env,
    projectId,
    config.searchMaxOwners,
    config.routingVersion
  );
  const root = await getStub(env, projectId);
  const planes = await Promise.all([
    root.rootSearchAuthoritativeMessages(projectId, query, roles, limit).then((results) => ({
      ownerName: projectId,
      results,
    })),
    ...owners.map(async (owner) => {
      const stub = await getNamedProjectDataStub(env, projectId, owner.ownerName);
      return {
        ownerName: owner.ownerName,
        results: await stub.archiveSearchMessages(owner, query, roles, limit),
      };
    }),
  ]);
  await assertProjectWidePlaneAuthority(
    env,
    projectId,
    planes.flatMap((plane) =>
      plane.results.map((result) => ({
        ownerName: plane.ownerName,
        sessionId: result.sessionId,
      }))
    )
  );
  const results = planes
    .flatMap((plane) => plane.results)
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    .slice(0, limit);
  return {
    results,
    partial,
    ownersQueried: owners.length + 1,
    reason: partial ? 'archive_owner_limit_reached' : null,
  };
}

// =========================================================================
// Terminal archive coordinator RPC bridge (external Worker sweep only)
// =========================================================================

export async function inspectArchiveSourceEligibility(
  env: Env,
  projectId: string,
  sessionId: string,
  now: number,
  terminalGraceMs: number
): Promise<SourceArchiveEligibility> {
  const stub = await getStub(env, projectId);
  return stub.archiveInspectSourceEligibility(projectId, sessionId, now, terminalGraceMs);
}

export async function getArchiveSourceSessionAnchor(
  env: Env,
  projectId: string,
  sessionId: string
): Promise<Record<string, unknown>> {
  const stub = await getStub(env, projectId);
  return stub.archiveGetSourceSessionAnchor(projectId, sessionId);
}

export async function establishArchiveSourceIntent(
  env: Env,
  fence: ArchiveRpcFence
): Promise<void> {
  const stub = await getStub(env, fence.projectId);
  await stub.archiveEstablishSourceIntent(fence);
}

export async function readArchiveSourceChunk(
  env: Env,
  fence: ArchiveRpcFence,
  table: ArchiveChunk['table'],
  chunkIndex: number,
  afterKey: string | null,
  maxRows: number,
  maxBytes: number
): Promise<ArchiveChunk> {
  const stub = await getStub(env, fence.projectId);
  return stub.archiveReadSourceChunk(fence, table, chunkIndex, afterKey, maxRows, maxBytes);
}

export async function getArchiveRehomeSourceSessionAnchor(
  env: Env,
  fence: ArchiveRehomeSourceFence
): Promise<Record<string, unknown>> {
  const stub = await getNamedProjectDataStub(env, fence.projectId, fence.sourceOwnerName);
  return stub.archiveGetRehomeSourceSessionAnchor(fence);
}

export async function establishArchiveRehomeSourceIntent(
  env: Env,
  fence: ArchiveRehomeSourceFence
): Promise<void> {
  const stub = await getNamedProjectDataStub(env, fence.projectId, fence.sourceOwnerName);
  await stub.archiveEstablishRehomeSourceIntent(fence);
}

export async function readArchiveRehomeSourceChunk(
  env: Env,
  fence: ArchiveRehomeSourceFence,
  table: ArchiveChunk['table'],
  chunkIndex: number,
  afterKey: string | null,
  maxRows: number,
  maxBytes: number
): Promise<ArchiveChunk> {
  const stub = await getNamedProjectDataStub(env, fence.projectId, fence.sourceOwnerName);
  return stub.archiveReadRehomeSourceChunk(fence, table, chunkIndex, afterKey, maxRows, maxBytes);
}

export async function prepareArchiveTarget(
  env: Env,
  fence: ArchiveRpcFence,
  sessionAnchor: Record<string, unknown>
): Promise<void> {
  const stub = await getNamedProjectDataStub(env, fence.projectId, fence.ownerName);
  await stub.archivePrepareTarget(fence, sessionAnchor);
}

export async function commitArchiveTargetChunk(
  env: Env,
  fence: ArchiveRpcFence,
  chunk: ArchiveChunk,
  r2Key: string
): Promise<void> {
  const stub = await getNamedProjectDataStub(env, fence.projectId, fence.ownerName);
  await stub.archiveCommitTargetChunk(fence, chunk, r2Key);
}

export async function resetArchiveTargetFromRecovery(
  env: Env,
  fence: ArchiveRpcFence
): Promise<void> {
  const stub = await getNamedProjectDataStub(env, fence.projectId, fence.ownerName);
  await stub.archiveResetTargetFromRecovery(fence);
}

export async function beginArchiveTargetSealing(env: Env, fence: ArchiveRpcFence): Promise<void> {
  const stub = await getNamedProjectDataStub(env, fence.projectId, fence.ownerName);
  await stub.archiveBeginTargetSealing(fence);
}

export async function verifyNextArchiveTargetChunk(
  env: Env,
  fence: ArchiveRpcFence
): Promise<{ done: boolean; verified: boolean }> {
  const stub = await getNamedProjectDataStub(env, fence.projectId, fence.ownerName);
  return stub.archiveVerifyNextTargetChunk(fence);
}

export async function sealArchiveTarget(
  env: Env,
  fence: ArchiveRpcFence,
  aggregateHash: string,
  manifestR2Key: string
): Promise<void> {
  const stub = await getNamedProjectDataStub(env, fence.projectId, fence.ownerName);
  await stub.archiveSealTarget(fence, aggregateHash, manifestR2Key);
}

export async function inspectArchiveTarget(env: Env, fence: ArchiveRpcFence) {
  const stub = await getNamedProjectDataStub(env, fence.projectId, fence.ownerName);
  return stub.archiveInspectTarget(fence);
}

export async function inspectArchiveTargetForReconciliation(env: Env, fence: ArchiveRpcFence) {
  const stub = await getNamedProjectDataStub(env, fence.projectId, fence.ownerName);
  return stub.archiveInspectTargetForReconciliation(fence);
}

export async function getNextArchiveTargetManifestPage(
  env: Env,
  fence: ArchiveRpcFence,
  maxEntries: number
) {
  const stub = await getNamedProjectDataStub(env, fence.projectId, fence.ownerName);
  return stub.archiveGetNextTargetManifestPage(fence, maxEntries);
}

export async function commitArchiveTargetManifestPage(
  env: Env,
  fence: ArchiveRpcFence,
  page: Omit<
    import('../durable-objects/project-data/archive-sharding').ArchiveManifestPage,
    'done'
  >,
  pageR2Key: string,
  aggregateHash: string
): Promise<void> {
  const stub = await getNamedProjectDataStub(env, fence.projectId, fence.ownerName);
  await stub.archiveCommitTargetManifestPage(fence, page, pageR2Key, aggregateHash);
}

export async function finalizeArchiveSource(
  env: Env,
  fence: ArchiveRpcFence,
  aggregateHash: string,
  manifestR2Key: string
): Promise<SourceDeletedProof> {
  const stub = await getStub(env, fence.projectId);
  return stub.archiveFinalizeSource(fence, aggregateHash, manifestR2Key);
}

export async function inspectArchiveSourceProof(
  env: Env,
  projectId: string,
  sessionId: string
): Promise<SourceDeletedProof> {
  const stub = await getStub(env, projectId);
  return stub.archiveInspectSourceProof(projectId, sessionId);
}

export async function finalizeArchiveRehomeSource(
  env: Env,
  fence: ArchiveRehomeSourceFence,
  aggregateHash: string,
  manifestR2Key: string
): Promise<SourceDeletedProof> {
  const stub = await getNamedProjectDataStub(env, fence.projectId, fence.sourceOwnerName);
  return stub.archiveFinalizeRehomeSource(fence, aggregateHash, manifestR2Key);
}

export async function inspectArchiveRehomeSourceProof(
  env: Env,
  fence: ArchiveRehomeSourceFence
): Promise<SourceDeletedProof> {
  const stub = await getNamedProjectDataStub(env, fence.projectId, fence.sourceOwnerName);
  return stub.archiveInspectRehomeSourceProof(
    fence.projectId,
    fence.sessionId,
    fence.sourceGeneration,
    fence.sourceOwnerName
  );
}

export async function markArchiveTargetAuthoritative(
  env: Env,
  fence: ArchiveRpcFence,
  aggregateHash: string
): Promise<void> {
  const stub = await getNamedProjectDataStub(env, fence.projectId, fence.ownerName);
  await stub.archiveMarkTargetAuthoritative(fence, aggregateHash);
}

export async function completeArchiveRootCopyback(
  env: Env,
  fence: ArchiveRpcFence,
  aggregateHash: string,
  routingVersion: number
): Promise<void> {
  const stub = await getNamedProjectDataStub(env, fence.projectId, fence.ownerName);
  await stub.archiveCompleteRootCopyback(fence, aggregateHash, routingVersion);
}

export async function getArchiveOwnerDatabaseSize(
  env: Env,
  projectId: string,
  ownerName: string
): Promise<number> {
  const stub = await getNamedProjectDataStub(env, projectId, ownerName);
  return stub.archiveGetDatabaseSize(ownerName);
}

export async function getArchiveTargetCanonicalBytes(
  env: Env,
  expected: {
    projectId: string;
    sessionId: string;
    migrationId: string;
    ownerName: string;
    generation: number;
  }
): Promise<number> {
  const stub = await getNamedProjectDataStub(env, expected.projectId, expected.ownerName);
  return stub.archiveGetTargetCanonicalBytes(expected);
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
  await resolveProjectDataOwnerLocation(env.DATABASE, projectId, input.sessionId);
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
  await resolveProjectDataOwnerLocation(env.DATABASE, projectId, sessionId);
  return callProjectDataWithRetry(env, projectId, 'getCommentThread', (stub) =>
    stub.getCommentThread({ sessionId, threadId })
  );
}

export async function createCommentThread(
  env: Env,
  projectId: string,
  input: CreateCommentThreadInput
): Promise<MessageCommentMutationResponse> {
  await assertProjectDataSessionWriteAllowed(env.DATABASE, projectId, input.sessionId);
  return callProjectDataNoRetry(env, projectId, 'createCommentThread', (stub) =>
    stub.createCommentThread(input)
  );
}

export async function createCommentReply(
  env: Env,
  projectId: string,
  input: CreateCommentReplyInput
): Promise<MessageCommentReplyMutationResponse> {
  await assertProjectDataSessionWriteAllowed(env.DATABASE, projectId, input.sessionId);
  return callProjectDataNoRetry(env, projectId, 'createCommentReply', (stub) =>
    stub.createCommentReply(input)
  );
}

export async function updateCommentThreadStatus(
  env: Env,
  projectId: string,
  input: UpdateCommentStatusInput & { status: CommentStatus }
): Promise<MessageCommentMutationResponse> {
  await assertProjectDataSessionWriteAllowed(env.DATABASE, projectId, input.sessionId);
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

/** Materialize all stopped sessions that haven't been indexed yet. */
export async function materializeAllStopped(
  env: Env,
  projectId: string,
  limit: number = 50
): Promise<{ materialized: number; errors: number; remaining: number }> {
  const stub = await getStub(env, projectId);
  return stub.materializeAllStopped(limit);
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
  await assertProjectDataSessionWriteAllowed(env.DATABASE, projectId, sessionId);
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
  await assertProjectDataSessionWriteAllowed(env.DATABASE, projectId, sessionId);
  const stub = await getStub(env, projectId);
  return stub.scheduleIdleCleanup(sessionId, workspaceId, taskId);
}

export async function cancelIdleCleanup(
  env: Env,
  projectId: string,
  sessionId: string
): Promise<void> {
  await assertProjectDataSessionWriteAllowed(env.DATABASE, projectId, sessionId);
  const stub = await getStub(env, projectId);
  return stub.cancelIdleCleanup(sessionId);
}

export async function resetIdleCleanup(
  env: Env,
  projectId: string,
  sessionId: string
): Promise<{ cleanupAt: number }> {
  await assertProjectDataSessionWriteAllowed(env.DATABASE, projectId, sessionId);
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
    promptStartedAt?: number | null;
    agentType?: string | null;
    restartCount?: number | null;
    statusError?: string | null;
    runtimeWorkState?: 'inactive' | 'active' | 'settling';
    runtimeWorkCount?: number;
    runtimeWorkSource?: string;
    runtimeWorkProgressAt?: number | null;
  }
): Promise<void> {
  const stub = await getStub(env, projectId);
  await stub.reportActivity(sessionId, activity, extra);
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
  const location = await resolveProjectDataOwnerLocation(env.DATABASE, projectId, sessionId);
  const stub = await getNamedProjectDataStub(env, projectId, location.owner.name);
  return location.state === 'root'
    ? stub.getLatestPersistedPlan(sessionId)
    : stub.archiveGetLatestPersistedPlan(archiveExpectedLocation(location));
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
  await assertProjectDataSessionWriteAllowed(env.DATABASE, projectId, input.targetSessionId);
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
