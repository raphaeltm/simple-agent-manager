/**
 * Agent-requested project runtime secrets: the one implementation every surface calls
 * (MCP `request_secret`, the REST routes behind the in-chat card, the maintenance sweep).
 *
 * Flow: an agent creates a request (metadata only) → a project member with `secret:write` types
 * the value into the card → `fulfillRuntimeSecretRequest` claims the request with a
 * compare-and-set and stores the value encrypted through `upsertProjectRuntimeEnvVar` → the
 * requesting agent gets a metadata-only durable prompt and uses the name with
 * `exec_with_secrets`. The value is a parameter of exactly one function here and is never
 * logged, returned or persisted anywhere but the encrypted column.
 */
import {
  RUNTIME_SECRET_REQUEST_REASON_MAX_LENGTH,
  type RuntimeSecretRequest,
  type RuntimeSecretRequestExistingValue,
} from '@simple-agent-manager/shared';
import { and, count, eq, gt } from 'drizzle-orm';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log, serializeError } from '../lib/logger';
import { sanitizeUserInput } from '../lib/sanitize-user-input';
import { ulid } from '../lib/ulid';
import { errors } from '../middleware/error';
import {
  assertProjectRuntimeEnvKey,
  findProjectRuntimeEnvVar,
  prepareProjectRuntimeEnvWrite,
} from './project-runtime-env';
import {
  deliverRuntimeSecretRequestOutcome,
  notifyRuntimeSecretRequested,
} from './runtime-secret-request-delivery';
import {
  type Db,
  effectiveRequestStatus,
  isoOrNull,
  loadRuntimeSecretRequest,
  toRuntimeSecretRequest,
} from './runtime-secret-request-records';
import { claimAndStoreValueStatements } from './runtime-secret-request-claim';
import { getRuntimeSecretRequestLimits } from './runtime-secret-request-settings';
import { UNSUPPORTED_SECRET_EXEC_ENV_NAMES } from './secret-exec-env-names';
import { resolveWorkspaceRuntimeAssetContext } from './workspace-runtime-assets';

/** The requesting agent's verified identity, taken from its MCP token. */
export interface SecretRequesterIdentity {
  projectId: string;
  userId: string;
  taskId: string;
  chatSessionId: string | null;
  agentSessionId: string | null;
  workspaceId: string | null;
}

export interface CreateRuntimeSecretRequestInput {
  name: unknown;
  reason: unknown;
  ttlSeconds?: unknown;
}

export interface CreatedRuntimeSecretRequest {
  request: RuntimeSecretRequest;
  /** True when an open request for the same name in this chat was returned instead. */
  deduplicated: boolean;
  /** True when a project variable with this name already exists (the human must confirm). */
  replacesExisting: boolean;
  notificationSent: boolean;
}

function parseTtl(value: unknown, configuredMin: number, max: number): number | null {
  if (value === undefined || value === null) return null;
  // An admin can set the minimum above the maximum; the maximum wins rather than refusing all.
  const min = Math.min(configuredMin, max);
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw errors.badRequest(`ttlSeconds must be an integer from ${min} to ${max}`);
  }
  return value;
}

function parseReason(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw errors.badRequest('reason is required and must be a non-empty string');
  }
  const reason = sanitizeUserInput(value.trim());
  if (reason.length > RUNTIME_SECRET_REQUEST_REASON_MAX_LENGTH) {
    throw errors.badRequest(
      `reason exceeds maximum length of ${RUNTIME_SECRET_REQUEST_REASON_MAX_LENGTH} characters`
    );
  }
  return reason;
}

/**
 * A project value would be hidden from this agent if its profile or skill defines the same name
 * (`getSecretExecutionEnv` merges project → profile → skill). Collecting it would look like it
 * worked while exec kept using the other value, so refuse up front.
 */
async function assertNotOverriddenForAgent(
  db: Db,
  identity: SecretRequesterIdentity,
  envKey: string
): Promise<void> {
  if (!identity.workspaceId) return;
  const context = await resolveWorkspaceRuntimeAssetContext(db, {
    workspaceId: identity.workspaceId,
    agentSessionId: identity.agentSessionId,
  });
  if (context.projectId !== identity.projectId) {
    throw errors.forbidden('Request scope does not match the session');
  }
  const [profileRows, skillRows] = await Promise.all([
    context.agentProfileId
      ? db
          .select({ id: schema.profileRuntimeEnvVars.id })
          .from(schema.profileRuntimeEnvVars)
          .where(
            and(
              eq(schema.profileRuntimeEnvVars.profileId, context.agentProfileId),
              eq(schema.profileRuntimeEnvVars.envKey, envKey)
            )
          )
          .limit(1)
      : Promise.resolve([]),
    context.skillId
      ? db
          .select({ id: schema.skillRuntimeEnvVars.id })
          .from(schema.skillRuntimeEnvVars)
          .where(
            and(
              eq(schema.skillRuntimeEnvVars.skillId, context.skillId),
              eq(schema.skillRuntimeEnvVars.envKey, envKey)
            )
          )
          .limit(1)
      : Promise.resolve([]),
  ]);
  const scope = skillRows[0] ? 'skill' : profileRows[0] ? 'agent profile' : null;
  if (scope) {
    throw errors.conflict(
      `${envKey} is already defined by this session's ${scope}, which overrides project values. Use that value, or ask for a different name.`
    );
  }
}

/** The task's chat and stable source-task authority (`recovery_source_task_id ?? id`). */
async function loadRequestingTask(env: Env, identity: SecretRequesterIdentity) {
  const row = await env.DATABASE.prepare(
    `SELECT id, user_id, chat_session_id, recovery_source_task_id FROM tasks WHERE id = ? AND project_id = ?`
  )
    .bind(identity.taskId, identity.projectId)
    .first<{
      id: string;
      user_id: string;
      chat_session_id: string | null;
      recovery_source_task_id: string | null;
    }>();
  if (!row || row.user_id !== identity.userId) {
    log.error('runtime_secret_request.task_mismatch', {
      taskId: identity.taskId,
      projectId: identity.projectId,
      tokenUserId: identity.userId,
      taskUserId: row?.user_id ?? null,
      action: 'rejected',
    });
    throw errors.forbidden('Requesting task does not belong to this session');
  }
  const chatSessionId = identity.chatSessionId ?? row.chat_session_id;
  if (!chatSessionId) throw errors.badRequest('A chat session is required to request a secret');
  return { authorityTaskId: row.recovery_source_task_id ?? row.id, chatSessionId };
}

export async function createRuntimeSecretRequest(
  env: Env,
  db: Db,
  identity: SecretRequesterIdentity,
  input: CreateRuntimeSecretRequestInput
): Promise<CreatedRuntimeSecretRequest> {
  if (!identity.taskId) throw errors.badRequest('Only task-backed sessions can request secrets');
  const envKey = assertProjectRuntimeEnvKey(typeof input.name === 'string' ? input.name : '');
  if (UNSUPPORTED_SECRET_EXEC_ENV_NAMES.has(envKey)) {
    throw errors.badRequest(`${envKey} is reserved and cannot be used with exec_with_secrets`);
  }
  const reason = parseReason(input.reason);
  const limits = await getRuntimeSecretRequestLimits(env);
  const ttlSeconds = parseTtl(input.ttlSeconds, limits.minTtlSeconds, limits.maxTtlSeconds);
  const { authorityTaskId, chatSessionId } = await loadRequestingTask(env, identity);
  await assertNotOverriddenForAgent(db, identity, envKey);

  const now = Date.now();
  const openForSession = and(
    eq(schema.runtimeSecretRequests.requestingChatSessionId, chatSessionId),
    eq(schema.runtimeSecretRequests.status, 'pending'),
    gt(schema.runtimeSecretRequests.expiresAt, now)
  );
  const [duplicate, openCount, existing] = await Promise.all([
    db
      .select()
      .from(schema.runtimeSecretRequests)
      .where(
        and(
          openForSession,
          eq(schema.runtimeSecretRequests.projectId, identity.projectId),
          eq(schema.runtimeSecretRequests.envKey, envKey)
        )
      )
      .limit(1),
    db.select({ count: count() }).from(schema.runtimeSecretRequests).where(openForSession),
    findProjectRuntimeEnvVar(db, identity.projectId, envKey),
  ]);
  if (duplicate[0]) {
    // Asking twice for the same name in one chat returns the open request: one card, one value.
    return {
      request: toRuntimeSecretRequest(duplicate[0], null, now),
      deduplicated: true,
      replacesExisting: Boolean(existing),
      notificationSent: false,
    };
  }
  if ((openCount[0]?.count ?? 0) >= limits.maxPendingPerSession) {
    throw errors.tooManyRequests(
      `This chat already has ${limits.maxPendingPerSession} open secret requests; wait for them to be answered or expire`
    );
  }

  const row: schema.RuntimeSecretRequestRow = {
    id: ulid(),
    projectId: identity.projectId,
    envKey,
    reason,
    ttlSeconds,
    status: 'pending',
    requesterUserId: identity.userId,
    requestingTaskId: identity.taskId,
    requestingAuthorityTaskId: authorityTaskId,
    requestingChatSessionId: chatSessionId,
    requestingAgentSessionId: identity.agentSessionId,
    requestingWorkspaceId: identity.workspaceId,
    expiresAt: now + limits.requestLifetimeMinutes * 60_000,
    resolvedBy: null,
    resolvedAt: null,
    secretExpiresAt: null,
    replacedExisting: false,
    notifiedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(schema.runtimeSecretRequests).values(row);
  const notificationSent = await notifyRuntimeSecretRequested(env, row);
  log.info('runtime_secret_request.created', {
    requestId: row.id,
    projectId: row.projectId,
    taskId: row.requestingTaskId,
    envKey,
    ttlSeconds,
    replacesExisting: Boolean(existing),
  });
  return {
    request: toRuntimeSecretRequest(row, null, now),
    deduplicated: false,
    replacesExisting: Boolean(existing),
    notificationSent,
  };
}

export async function describeExistingValue(
  db: Db,
  projectId: string,
  envKey: string,
  now = Date.now()
): Promise<RuntimeSecretRequestExistingValue | null> {
  const existing = await findProjectRuntimeEnvVar(db, projectId, envKey);
  if (!existing) return null;
  return {
    isSecret: existing.isSecret,
    collected: Boolean(existing.secretRequestId),
    expiresAt: isoOrNull(existing.expiresAt),
    expired: existing.expiresAt !== null && existing.expiresAt <= now,
    updatedAt: existing.updatedAt,
  };
}

export async function getRuntimeSecretRequest(db: Db, projectId: string, requestId: string) {
  const loaded = await loadRuntimeSecretRequest(db, projectId, requestId);
  if (!loaded) throw errors.notFound('Secret request');
  return loaded;
}

/** Claim a pending, unexpired request for one outcome. Returns false when someone else won. */
async function claimPendingRequest(
  db: Db,
  row: schema.RuntimeSecretRequestRow,
  set: Partial<schema.RuntimeSecretRequestRow>,
  now: number
): Promise<boolean> {
  const claimed = await db
    .update(schema.runtimeSecretRequests)
    .set({ ...set, updatedAt: now })
    .where(
      and(
        eq(schema.runtimeSecretRequests.id, row.id),
        eq(schema.runtimeSecretRequests.projectId, row.projectId),
        eq(schema.runtimeSecretRequests.status, 'pending'),
        gt(schema.runtimeSecretRequests.expiresAt, now)
      )
    )
    .returning({ id: schema.runtimeSecretRequests.id });
  return claimed.length === 1;
}

/**
 * Queue the agent's outcome notice and record that it was queued. A notice that could not be
 * queued keeps `notified_at` NULL, and the five-minute sweep retries it for a bounded window
 * (`retryRuntimeSecretRequestNotices`), so a transient failure does not leave the agent waiting.
 */
export async function notifyAgent(
  env: Env,
  db: Db,
  row: schema.RuntimeSecretRequestRow,
  outcome: 'fulfilled' | 'declined' | 'expired',
  resolvedByName: string | null
): Promise<boolean> {
  const queued = await deliverRuntimeSecretRequestOutcome(env, row, outcome, resolvedByName);
  if (queued) {
    try {
      await db
        .update(schema.runtimeSecretRequests)
        .set({ notifiedAt: Date.now() })
        .where(eq(schema.runtimeSecretRequests.id, row.id));
    } catch (error) {
      // The notice is queued; a missed marker only means one idempotent retry (same delivery id).
      log.warn('runtime_secret_request.notified_mark_failed', {
        requestId: row.id,
        ...serializeError(error),
      });
    }
  }
  return queued;
}

function assertStillPending(row: schema.RuntimeSecretRequestRow, now: number): void {
  const status = effectiveRequestStatus(row, now);
  if (status === 'expired') throw errors.gone('This secret request has expired');
  if (status !== 'pending') throw errors.conflict(`This secret request was already ${status}`);
}

export interface FulfillRuntimeSecretRequestInput {
  projectId: string;
  requestId: string;
  actorUserId: string;
  actorName: string | null;
  value: string;
  replaceExisting: boolean;
}

async function claimAndStoreValue(
  env: Env,
  row: schema.RuntimeSecretRequestRow,
  input: FulfillRuntimeSecretRequestInput,
  stored: { ciphertext: string; iv: string | null },
  resolution: { resolvedAt: number; secretExpiresAt: number | null; replacedExisting: boolean }
): Promise<boolean> {
  const [, claim] = await env.DATABASE.batch(
    claimAndStoreValueStatements(env.DATABASE, row, input, stored, resolution)
  );
  return (claim?.meta?.changes ?? 0) === 1;
}

/** Caller has verified `secret:write` on the project. */
export async function fulfillRuntimeSecretRequest(
  env: Env,
  db: Db,
  input: FulfillRuntimeSecretRequestInput
): Promise<{ request: RuntimeSecretRequest; agentNotified: boolean }> {
  if (!input.value) throw errors.badRequest('A value is required');
  const { row } = await getRuntimeSecretRequest(db, input.projectId, input.requestId);
  const now = Date.now();
  assertStillPending(row, now);
  // Same validation, limits and encryption as a manual write, before anything is claimed.
  const prepared = await prepareProjectRuntimeEnvWrite(db, env, {
    projectId: row.projectId,
    envKey: row.envKey,
    value: input.value,
    isSecret: true,
  });
  if (prepared.existing && !input.replaceExisting) {
    throw errors.conflict(
      `${row.envKey} already exists in this project. Confirm that the new value should replace it.`
    );
  }
  const resolution = {
    resolvedAt: now,
    secretExpiresAt: row.ttlSeconds ? now + row.ttlSeconds * 1_000 : null,
    replacedExisting: Boolean(prepared.existing),
  };
  if (!(await claimAndStoreValue(env, row, input, prepared.stored, resolution))) {
    const current = await loadRuntimeSecretRequest(db, row.projectId, row.id);
    if (current && effectiveRequestStatus(current.row) === 'pending' && !input.replaceExisting) {
      throw errors.conflict(
        `${row.envKey} was created in this project in the meantime. Confirm that the new value should replace it.`
      );
    }
    throw errors.conflict('This secret request was already answered or has expired');
  }
  const resolved: schema.RuntimeSecretRequestRow = {
    ...row,
    status: 'fulfilled',
    resolvedBy: input.actorUserId,
    resolvedAt: now,
    secretExpiresAt: resolution.secretExpiresAt,
    replacedExisting: resolution.replacedExisting,
    updatedAt: now,
  };
  const agentNotified = await notifyAgent(env, db, resolved, 'fulfilled', input.actorName);
  log.info('runtime_secret_request.fulfilled', {
    requestId: row.id,
    projectId: row.projectId,
    envKey: row.envKey,
    actorUserId: input.actorUserId,
    replacedExisting: resolution.replacedExisting,
    secretExpiresAt: resolution.secretExpiresAt,
    agentNotified,
  });
  return { request: toRuntimeSecretRequest(resolved, input.actorName, now), agentNotified };
}

/** Caller has verified `secret:write` on the project. */
export async function declineRuntimeSecretRequest(
  env: Env,
  db: Db,
  input: { projectId: string; requestId: string; actorUserId: string; actorName: string | null }
): Promise<{ request: RuntimeSecretRequest; agentNotified: boolean }> {
  const { row } = await getRuntimeSecretRequest(db, input.projectId, input.requestId);
  const now = Date.now();
  assertStillPending(row, now);
  const resolution = {
    status: 'declined',
    resolvedBy: input.actorUserId,
    resolvedAt: now,
  } as const;
  if (!(await claimPendingRequest(db, row, resolution, now))) {
    throw errors.conflict('This secret request was already answered or has expired');
  }
  const resolved = { ...row, ...resolution, updatedAt: now };
  const agentNotified = await notifyAgent(env, db, resolved, 'declined', input.actorName);
  log.info('runtime_secret_request.declined', {
    requestId: row.id,
    projectId: row.projectId,
    actorUserId: input.actorUserId,
    agentNotified,
  });
  return { request: toRuntimeSecretRequest(resolved, input.actorName, now), agentNotified };
}
