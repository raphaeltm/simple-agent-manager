import type { Env } from '../env';
import { log } from '../lib/logger';
import { getNodeAgentBackgroundRequestTimeoutMs } from '../services/node-agent';
import { persistError } from '../services/observability';
import {
  attemptWorkspaceDeletion,
  loadWorkspaceDeletionSnapshot,
  WORKSPACE_DELETION_DIAGNOSTIC_PREFIX,
  type WorkspaceDeletionIdentity,
  workspaceDeletionIdentityLogContext,
  type WorkspaceDeletionMode,
} from '../services/workspace-deletion';
import {
  claimedDeletionEntry,
  deletionEntryClaimedWithoutNodeIncarnation,
  deletionEntryMatchesClaimIdentity,
  deletionEntryMatchesScheduledIdentity,
  deletionIdentityForAttempt,
  deletionIdentityFromEntry,
  scheduledDeletionEntry,
  scheduledDeletionIdentity,
} from './node-lifecycle-workspace-deletion-entry';
import {
  backfillWorkspaceDeletionDueIndexBatch,
  isPendingWorkspaceDeletion,
  recalculateWorkspaceDeletionAlarm,
  repairWorkspaceDeletionDueIndex,
  WORKSPACE_DELETION_DUE_INDEX_PREFIX,
  WORKSPACE_DELETION_ENTRY_PREFIX,
  workspaceDeletionDueIndexKey,
  workspaceDeletionDueIndexTimestamp,
} from './node-lifecycle-workspace-deletion-index';
import {
  claimWorkspaceDeletionInD1,
  type NodeLifecycleDeletionEnv,
  type PendingWorkspaceDeletion,
  workspaceDeletionAlarmBatchSize,
  type WorkspaceDeletionAttemptDispatcher,
  type WorkspaceDeletionClaimResult,
  workspaceDeletionMaxResidenceMs,
  workspaceDeletionRetryDelayMs,
  workspaceStoppedTtlMs,
} from './node-lifecycle-workspace-deletion-support';

export type { WorkspaceDeletionMode } from '../services/workspace-deletion';
export type {
  NodeLifecycleDeletionEnv,
  WorkspaceDeletionClaimResult,
} from './node-lifecycle-workspace-deletion-support';

const WORKSPACE_DELETION_ELIGIBLE_STATUSES = new Set([
  'stopped',
  'sleeping',
  'stopping',
  'deleted',
]);
export { workspaceDeletionDueIndexKey } from './node-lifecycle-workspace-deletion-index';

function isWorkspaceDeletionEligibleStatus(status: string): boolean {
  return WORKSPACE_DELETION_ELIGIBLE_STATUSES.has(status);
}

function sameDeletionIdentity(
  left: WorkspaceDeletionIdentity,
  right: WorkspaceDeletionIdentity
): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.nodeId === right.nodeId &&
    left.nodeUserId === right.nodeUserId &&
    left.nodeRuntime === right.nodeRuntime &&
    left.nodeProviderInstanceId === right.nodeProviderInstanceId &&
    left.nodeRuntimeIncarnationId === right.nodeRuntimeIncarnationId &&
    left.userId === right.userId &&
    left.projectId === right.projectId &&
    left.chatSessionId === right.chatSessionId
  );
}

/** Durable queue for proof-bearing VM workspace deletion attempts. */
export class NodeLifecycleWorkspaceDeletionQueue {
  constructor(
    private readonly env: NodeLifecycleDeletionEnv,
    private readonly storage: DurableObjectStorage,
    private readonly getWarmAlarmTime: () => Promise<number | null>,
    private readonly getStoredNodeId: () => Promise<string | undefined>
  ) {}

  async schedule(
    nodeId: string,
    workspaceId: string,
    userId: string,
    options?: {
      retryAfterMs?: number;
      lastError?: string | null;
      expected?: WorkspaceDeletionIdentity;
    }
  ): Promise<boolean> {
    const now = Date.now();
    const delayMs = options?.retryAfterMs ?? workspaceStoppedTtlMs(this.env);
    const key = `ws-delete:${workspaceId}`;
    const identity = await loadWorkspaceDeletionSnapshot(this.env.DATABASE, workspaceId);
    if (
      (identity && !isWorkspaceDeletionEligibleStatus(identity.status)) ||
      (options?.expected && (!identity || !sameDeletionIdentity(identity, options.expected)))
    ) {
      log.info('node_lifecycle.workspace_deletion_schedule_stale', {
        workspaceId,
        nodeId,
        status: identity?.status ?? 'missing',
        action: 'not_scheduled',
      });
      await this.recalculateAlarm(await this.getWarmAlarmTime());
      return false;
    }
    const existing = await this.storage.get<PendingWorkspaceDeletion>(key);
    const scheduledIdentity = scheduledDeletionIdentity({
      supplied: options?.expected,
      current: identity,
      workspaceId,
      nodeId,
      userId,
    });
    const existingMatches = deletionEntryMatchesScheduledIdentity(existing, scheduledIdentity);
    if (existing && !existingMatches) {
      log.warn('node_lifecycle.workspace_deletion_schedule_fenced', {
        workspaceId,
        nodeId: existing.nodeId,
        currentNodeId: scheduledIdentity.nodeId,
        userId: existing.userId,
        action: 'existing_incarnation_preserved',
      });
      await this.recalculateAlarm(await this.getWarmAlarmTime());
      return false;
    }
    if (existingMatches && existing?.deadLetteredAt) {
      await this.recalculateAlarm(await this.getWarmAlarmTime());
      return false;
    }

    const entry = scheduledDeletionEntry({
      existing,
      existingMatches,
      identity: scheduledIdentity,
      fallbackNodeId: nodeId,
      workspaceId,
      now,
      delayMs,
      lastError: options?.lastError,
    });
    await this.putEntryWithAlarm(key, entry);

    log.info('node_lifecycle.workspace_deletion_scheduled', {
      workspaceId,
      nodeId: entry.nodeId,
      userId: entry.userId,
      deleteAt: new Date(entry.deleteAt).toISOString(),
      delayMs,
      attemptCount: entry.attemptCount,
    });
    return true;
  }

  async claimAttempt(
    nodeId: string,
    workspaceId: string,
    userId: string,
    expected: WorkspaceDeletionIdentity,
    mode: WorkspaceDeletionMode
  ): Promise<WorkspaceDeletionClaimResult> {
    const current = await loadWorkspaceDeletionSnapshot(this.env.DATABASE, workspaceId);
    if (!current || !sameDeletionIdentity(current, expected)) {
      log.warn('node_lifecycle.workspace_deletion_claim_identity_fenced', {
        ...workspaceDeletionIdentityLogContext(expected, current),
        currentStatus: current?.status ?? 'missing',
        action: 'rejected',
      });
      return 'fenced';
    }

    const key = `ws-delete:${workspaceId}`;
    const now = Date.now();
    const claimId = crypto.randomUUID();
    const claimDiagnostic = `${WORKSPACE_DELETION_DIAGNOSTIC_PREFIX}: durable attempt 1 claimed`;
    const warmAlarmTime = await this.getWarmAlarmTime();
    const claim = await this.storage.transaction(async (transaction) => {
      const existing = await transaction.get<PendingWorkspaceDeletion>(key);
      const existingMatches = deletionEntryMatchesClaimIdentity({
        entry: existing,
        nodeId,
        userId,
        expected,
      });
      if (!existingMatches || existing?.deadLetteredAt) {
        return { result: 'fenced' as const, entry: existing ?? null };
      }
      if ((existing?.attemptCount ?? 0) > 0 || existing?.lastAttemptAt != null) {
        return { result: 'already_claimed_same_identity' as const, entry: existing };
      }
      const claimed = {
        nodeId: expected.nodeId ?? nodeId,
        nodeUserId: expected.nodeUserId,
        nodeRuntime: expected.nodeRuntime,
        nodeProviderInstanceId: expected.nodeProviderInstanceId,
        nodeRuntimeIncarnationId: expected.nodeRuntimeIncarnationId,
        workspaceId,
        userId,
        projectId: expected.projectId,
        chatSessionId: expected.chatSessionId,
        deleteAt: now + workspaceDeletionRetryDelayMs(this.env, 1),
        firstScheduledAt: existing?.firstScheduledAt ?? now,
        attemptCount: 1,
        lastAttemptAt: now,
        lastError: existing?.lastError ?? null,
        claimId,
        deadLetteredAt: null,
        deadLetterReason: null,
      } satisfies PendingWorkspaceDeletion;
      await this.putEntryAndAlarm(transaction, key, claimed, warmAlarmTime, now);
      return { result: 'claimed' as const, entry: claimed };
    });
    if (claim.result !== 'claimed') {
      const currentEntry = claim.entry;
      const currentEntryIdentity = deletionIdentityFromEntry(currentEntry);
      log.warn('node_lifecycle.workspace_deletion_claim_fenced', {
        ...workspaceDeletionIdentityLogContext(expected, currentEntryIdentity),
        attemptCount: currentEntry?.attemptCount ?? 0,
        action:
          claim.result === 'already_claimed_same_identity'
            ? 'existing_attempt_retained'
            : 'rejected',
      });
      return claim.result;
    }

    try {
      const claimed = await claimWorkspaceDeletionInD1(
        this.env,
        expected,
        1,
        claimDiagnostic,
        mode
      );
      if (!claimed) {
        await this.compensateExactClaim(key, claimId);
        const currentAfterClaim = await loadWorkspaceDeletionSnapshot(
          this.env.DATABASE,
          workspaceId
        );
        log.warn('node_lifecycle.workspace_deletion_d1_claim_fenced', {
          ...workspaceDeletionIdentityLogContext(expected, currentAfterClaim),
          currentStatus: currentAfterClaim?.status ?? 'missing',
          action: 'rejected',
        });
        return 'fenced';
      }
    } catch (error) {
      log.error('node_lifecycle.workspace_deletion_d1_claim_failed', {
        workspaceId,
        nodeId: expected.nodeId,
        claimId,
        error: error instanceof Error ? error.message : String(error),
        action: 'durable_claim_retained',
      });
      throw error;
    }

    const latest = await this.storage.get<PendingWorkspaceDeletion>(key);
    return latest?.claimId === claimId && !latest.deadLetteredAt ? 'claimed' : 'fenced';
  }

  async getAttemptState(
    workspaceId: string
  ): Promise<{ pending: boolean; attemptStarted: boolean }> {
    const entry = await this.storage.get<PendingWorkspaceDeletion>(`ws-delete:${workspaceId}`);
    return {
      pending: Boolean(entry),
      attemptStarted: Boolean((entry?.attemptCount ?? 0) > 0 || entry?.lastAttemptAt != null),
    };
  }

  async confirm(workspaceId: string): Promise<void> {
    const key = `${WORKSPACE_DELETION_ENTRY_PREFIX}${workspaceId}`;
    await this.storage.transaction(async (transaction) => {
      const current = await transaction.get<PendingWorkspaceDeletion>(key);
      if (current) await transaction.delete(workspaceDeletionDueIndexKey(current));
      await transaction.delete(key);
    });
    await this.recalculateAlarm(await this.getWarmAlarmTime());
  }

  async cancel(workspaceId: string): Promise<boolean> {
    const key = `ws-delete:${workspaceId}`;
    const outcome = await this.storage.transaction(async (transaction) => {
      const entry = await transaction.get<PendingWorkspaceDeletion>(key);
      if (!entry) return { cancelled: true, attemptCount: 0 };
      if ((entry.attemptCount ?? 0) > 0 || entry.lastAttemptAt != null) {
        return { cancelled: false, attemptCount: entry.attemptCount ?? 0 };
      }
      await transaction.delete(workspaceDeletionDueIndexKey(entry));
      await transaction.delete(key);
      return { cancelled: true, attemptCount: 0 };
    });
    if (!outcome.cancelled) {
      log.warn('node_lifecycle.workspace_deletion_cancel_fenced', {
        workspaceId,
        attemptCount: outcome.attemptCount,
        action: 'restart_refused',
      });
      return false;
    }
    log.info('node_lifecycle.workspace_deletion_cancelled', { workspaceId });
    await this.recalculateAlarm(await this.getWarmAlarmTime());
    return true;
  }

  async processExpired(dispatch: WorkspaceDeletionAttemptDispatcher): Promise<void> {
    const now = Date.now();
    const storedNodeId = await this.getStoredNodeId();
    const batchSize = workspaceDeletionAlarmBatchSize(this.env);
    await backfillWorkspaceDeletionDueIndexBatch(this.storage, batchSize);
    const due = await this.collectDueEntries(now, batchSize);
    for (const [key, entry] of due) {
      await this.processDueEntry(key, entry, now, storedNodeId, dispatch);
    }
  }

  private async collectDueEntries(
    now: number,
    batchSize: number
  ): Promise<Array<[string, PendingWorkspaceDeletion]>> {
    const indexed = await this.storage.list<string>({
      prefix: WORKSPACE_DELETION_DUE_INDEX_PREFIX,
      limit: batchSize,
    });
    const due: Array<[string, PendingWorkspaceDeletion]> = [];
    for (const [indexKey, entryKey] of indexed) {
      const indexedDeleteAt = workspaceDeletionDueIndexTimestamp(indexKey);
      const storedEntry = await this.storage.get<unknown>(entryKey);
      let entry: PendingWorkspaceDeletion | null = isPendingWorkspaceDeletion(entryKey, storedEntry)
        ? storedEntry
        : null;
      if (
        !entry ||
        entry.deadLetteredAt ||
        indexedDeleteAt === null ||
        workspaceDeletionDueIndexKey(entry) !== indexKey
      ) {
        entry = await repairWorkspaceDeletionDueIndex(this.storage, indexKey, entryKey);
        if (!entry || entry.deleteAt > now) continue;
      }
      if (entry.deleteAt > now) break;
      due.push([entryKey, entry]);
    }
    return due;
  }

  private async processDueEntry(
    key: string,
    entry: PendingWorkspaceDeletion,
    now: number,
    storedNodeId: string | undefined,
    dispatch: WorkspaceDeletionAttemptDispatcher
  ): Promise<void> {
    entry.firstScheduledAt ??= now;
    const currentIdentity = await loadWorkspaceDeletionSnapshot(
      this.env.DATABASE,
      entry.workspaceId
    );
    if (deletionEntryClaimedWithoutNodeIncarnation(entry)) {
      dispatch(
        this.deadLetterExact(
          key,
          entry.claimId ?? null,
          entry,
          'claimed attempt lacks an immutable node-incarnation snapshot'
        )
      );
      return;
    }
    if (now - entry.firstScheduledAt >= workspaceDeletionMaxResidenceMs(this.env)) {
      dispatch(
        this.deadLetterExact(key, entry.claimId ?? null, entry, 'maximum retry residence exceeded')
      );
      return;
    }
    if (!entry.nodeId && !storedNodeId && !currentIdentity) {
      dispatch(
        this.deadLetterExact(
          key,
          entry.claimId ?? null,
          entry,
          'workspace and node identity unavailable'
        )
      );
      return;
    }

    const expected = deletionIdentityForAttempt({ entry, current: currentIdentity, storedNodeId });
    const attempt = (entry.attemptCount ?? 0) + 1;
    const claimId = crypto.randomUUID();
    const claimedEntry = claimedDeletionEntry({
      entry,
      expected,
      attempt,
      claimId,
      now,
      retryDelayMs: workspaceDeletionRetryDelayMs(this.env, attempt),
    });
    if (!(await this.claimExactEntryWithAlarm(key, entry, claimedEntry))) return;

    const proofAlreadyPersisted = Boolean(
      currentIdentity?.runtimeDeletionConfirmedAt && currentIdentity.runtimeDeletionProof
    );
    if (!currentIdentity || proofAlreadyPersisted) {
      // Missing workspaces can converge only through strict node proof. Persisted
      // workspace proof re-enters the classifier to finish lifecycle closure.
      dispatch(this.runClaimedAttempt(key, claimId, claimedEntry, expected, attempt));
      return;
    }

    await this.claimInD1AndDispatch(key, claimId, claimedEntry, expected, attempt, dispatch);
  }

  private async claimInD1AndDispatch(
    key: string,
    claimId: string,
    entry: PendingWorkspaceDeletion,
    expected: WorkspaceDeletionIdentity,
    attempt: number,
    dispatch: WorkspaceDeletionAttemptDispatcher
  ): Promise<void> {
    try {
      const d1Claimed = await claimWorkspaceDeletionInD1(
        this.env,
        expected,
        attempt,
        `${WORKSPACE_DELETION_DIAGNOSTIC_PREFIX}: durable attempt ${attempt} claimed`,
        'automatic'
      );
      if (!d1Claimed) {
        await this.handleRejectedD1Claim(key, claimId, entry, expected, dispatch);
        return;
      }
    } catch (error) {
      await this.updateExactClaim(key, claimId, {
        lastError: 'D1 deletion claim failed before VM request',
      });
      log.error('node_lifecycle.workspace_deletion_d1_claim_failed', {
        workspaceId: entry.workspaceId,
        userId: entry.userId,
        attempt,
        error: error instanceof Error ? error.message : String(error),
        action: 'durable_claim_retained',
      });
      return;
    }

    // The network path begins only after both durable claim and exact D1 claim exist.
    // It is deliberately detached from the alarm critical section under Rule 47.
    dispatch(this.runClaimedAttempt(key, claimId, entry, expected, attempt));
  }

  private async handleRejectedD1Claim(
    key: string,
    claimId: string,
    entry: PendingWorkspaceDeletion,
    expected: WorkspaceDeletionIdentity,
    dispatch: WorkspaceDeletionAttemptDispatcher
  ): Promise<void> {
    const latestIdentity = await loadWorkspaceDeletionSnapshot(
      this.env.DATABASE,
      entry.workspaceId
    );
    if (
      latestIdentity &&
      sameDeletionIdentity(latestIdentity, expected) &&
      !isWorkspaceDeletionEligibleStatus(latestIdentity.status)
    ) {
      dispatch(this.deleteExact(key, claimId));
      log.info('node_lifecycle.workspace_deletion_stale_schedule_removed', {
        workspaceId: entry.workspaceId,
        nodeId: entry.nodeId,
        status: latestIdentity.status,
        action: 'claim_removed_without_vm_request',
      });
      return;
    }
    dispatch(
      this.deadLetterExact(
        key,
        claimId,
        entry,
        'workspace identity or status changed before VM deletion'
      )
    );
  }

  private async runClaimedAttempt(
    key: string,
    claimId: string,
    entry: PendingWorkspaceDeletion,
    expected: WorkspaceDeletionIdentity,
    attempt: number
  ): Promise<void> {
    try {
      const outcome = await attemptWorkspaceDeletion({
        env: this.env as unknown as Env,
        expected,
        attempt,
        source: 'node_lifecycle',
        mode: 'automatic',
        requestTimeoutMs: getNodeAgentBackgroundRequestTimeoutMs(this.env),
      });
      if (outcome.status === 'confirmed') {
        await this.deleteExact(key, claimId);
        log.info('node_lifecycle.workspace_auto_deleted', {
          workspaceId: entry.workspaceId,
          userId: entry.userId,
          attempt,
          proof: outcome.proof,
        });
        return;
      }

      if (outcome.status === 'superseded') {
        await this.deleteExact(key, claimId);
        log.info('node_lifecycle.workspace_deletion_superseded', {
          workspaceId: entry.workspaceId,
          nodeId: expected.nodeId,
          userId: entry.userId,
          attempt,
          reason: outcome.reason,
          action: 'old_incarnation_attempt_removed',
        });
        return;
      }

      if (outcome.status === 'fenced') {
        await this.deadLetterExact(key, claimId, entry, outcome.reason);
        return;
      }

      const retryAt = Date.now() + workspaceDeletionRetryDelayMs(this.env, attempt);
      await this.updateExactClaim(key, claimId, {
        lastError: outcome.diagnostic,
        deleteAt: retryAt,
      });
      log.warn('node_lifecycle.workspace_deletion_quarantined', {
        workspaceId: entry.workspaceId,
        nodeId: expected.nodeId,
        userId: entry.userId,
        attempt,
        outcome: outcome.status,
        reason: outcome.reason,
        retryAt: new Date(retryAt).toISOString(),
      });
    } catch (error) {
      await this.updateExactClaim(key, claimId, {
        lastError: 'workspace deletion attempt failed before classification',
        deleteAt: Date.now() + workspaceDeletionRetryDelayMs(this.env, attempt),
      });
      log.error('node_lifecycle.workspace_deletion_failed', {
        workspaceId: entry.workspaceId,
        userId: entry.userId,
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await this.recalculateAlarm(await this.getWarmAlarmTime());
    }
  }

  async recalculateAlarm(warmAlarmTime: number | null): Promise<void> {
    const inspectionLimit = workspaceDeletionAlarmBatchSize(this.env);
    await recalculateWorkspaceDeletionAlarm({
      storage: this.storage,
      warmAlarmTime,
      inspectionLimit,
      boundedRescanDelayMs: workspaceDeletionRetryDelayMs(this.env, 1),
    });
  }

  private async putEntryWithAlarm(key: string, entry: PendingWorkspaceDeletion): Promise<void> {
    const warmAlarmTime = await this.getWarmAlarmTime();
    const now = Date.now();
    await this.storage.transaction(async (transaction) => {
      await this.putEntryAndAlarm(transaction, key, entry, warmAlarmTime, now);
    });
  }

  private async claimExactEntryWithAlarm(
    key: string,
    expected: PendingWorkspaceDeletion,
    claimed: PendingWorkspaceDeletion
  ): Promise<boolean> {
    const warmAlarmTime = await this.getWarmAlarmTime();
    const now = Date.now();
    return await this.storage.transaction(async (transaction) => {
      const current = await transaction.get<PendingWorkspaceDeletion>(key);
      if (
        !current ||
        current.deadLetteredAt ||
        (current.attemptCount ?? 0) !== (expected.attemptCount ?? 0) ||
        (current.claimId ?? null) !== (expected.claimId ?? null)
      ) {
        return false;
      }
      await this.putEntryAndAlarm(transaction, key, claimed, warmAlarmTime, now);
      return true;
    });
  }

  private async putEntryAndAlarm(
    transaction: DurableObjectTransaction,
    key: string,
    entry: PendingWorkspaceDeletion,
    warmAlarmTime: number | null,
    now: number
  ): Promise<void> {
    const current = await transaction.get<PendingWorkspaceDeletion>(key);
    const currentAlarm = await transaction.getAlarm();
    const futureAlarm = currentAlarm !== null && currentAlarm > now ? currentAlarm : null;
    const nextAlarm = [futureAlarm, warmAlarmTime, entry.deleteAt]
      .filter((value): value is number => value !== null)
      .reduce((earliest, value) => Math.min(earliest, value), Number.POSITIVE_INFINITY);
    if (current) await transaction.delete(workspaceDeletionDueIndexKey(current));
    await transaction.put(key, entry);
    if (!entry.deadLetteredAt) {
      await transaction.put(workspaceDeletionDueIndexKey(entry), key);
    }
    await transaction.setAlarm(nextAlarm);
  }

  private async compensateExactClaim(key: string, claimId: string): Promise<void> {
    await this.storage.transaction(async (transaction) => {
      const current = await transaction.get<PendingWorkspaceDeletion>(key);
      if (current?.claimId === claimId) {
        await transaction.delete(workspaceDeletionDueIndexKey(current));
        await transaction.delete(key);
      }
    });
    await this.recalculateAlarm(await this.getWarmAlarmTime());
  }

  private async deleteExact(key: string, claimId: string | null): Promise<void> {
    await this.storage.transaction(async (transaction) => {
      const current = await transaction.get<PendingWorkspaceDeletion>(key);
      const currentClaimId = current?.claimId ?? null;
      if (current && currentClaimId === claimId) {
        await transaction.delete(workspaceDeletionDueIndexKey(current));
        await transaction.delete(key);
      }
    });
    await this.recalculateAlarm(await this.getWarmAlarmTime());
  }

  private async updateExactClaim(
    key: string,
    claimId: string,
    update: Partial<PendingWorkspaceDeletion>
  ): Promise<boolean> {
    return await this.storage.transaction(async (transaction) => {
      const current = await transaction.get<PendingWorkspaceDeletion>(key);
      if (!current || current.claimId !== claimId || current.deadLetteredAt) return false;
      const next = { ...current, ...update };
      await transaction.delete(workspaceDeletionDueIndexKey(current));
      await transaction.put(key, next);
      if (!next.deadLetteredAt) {
        await transaction.put(workspaceDeletionDueIndexKey(next), key);
      }
      return true;
    });
  }

  private async deadLetterExact(
    key: string,
    claimId: string | null,
    entry: PendingWorkspaceDeletion,
    reason: string
  ): Promise<void> {
    const deadLetteredAt = Date.now();
    const retained = await this.storage.transaction(async (transaction) => {
      const current = await transaction.get<PendingWorkspaceDeletion>(key);
      if (!current || (current.claimId ?? null) !== claimId || current.deadLetteredAt) return false;
      await transaction.delete(workspaceDeletionDueIndexKey(current));
      await transaction.put(key, {
        ...current,
        deadLetteredAt,
        deadLetterReason: reason,
      });
      return true;
    });
    if (!retained) return;

    log.error('node_lifecycle.workspace_deletion_dead_lettered', {
      workspaceId: entry.workspaceId,
      nodeId: entry.nodeId,
      userId: entry.userId,
      attempt: entry.attemptCount ?? 0,
      reason,
      action: 'workspace_retained_stopping_and_replacement_fenced',
    });
    await persistError(
      this.env.OBSERVABILITY_DATABASE,
      {
        source: 'api',
        level: 'error',
        message: 'Workspace deletion entered durable operator quarantine',
        workspaceId: entry.workspaceId,
        nodeId: entry.nodeId ?? null,
        userId: entry.userId,
      },
      this.env as unknown as Env
    );
    await this.recalculateAlarm(await this.getWarmAlarmTime());
  }
}
