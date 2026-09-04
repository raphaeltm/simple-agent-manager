import type { Env } from '../env';
import { log } from '../lib/logger';
import { getNodeAgentBackgroundRequestTimeoutMs } from '../services/node-agent';
import { persistError } from '../services/observability';
import {
  attemptWorkspaceDeletion,
  loadWorkspaceDeletionSnapshot,
  WORKSPACE_DELETION_DIAGNOSTIC_PREFIX,
  type WorkspaceDeletionIdentity,
} from '../services/workspace-deletion';
import {
  claimWorkspaceDeletionInD1,
  type NodeLifecycleDeletionEnv,
  type PendingWorkspaceDeletion,
  workspaceDeletionAlarmBatchSize,
  type WorkspaceDeletionAttemptDispatcher,
  workspaceDeletionMaxResidenceMs,
  workspaceDeletionRetryDelayMs,
  workspaceStoppedTtlMs,
} from './node-lifecycle-workspace-deletion-support';

export type { NodeLifecycleDeletionEnv } from './node-lifecycle-workspace-deletion-support';

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
  ): Promise<void> {
    const now = Date.now();
    const delayMs = options?.retryAfterMs ?? workspaceStoppedTtlMs(this.env);
    const key = `ws-delete:${workspaceId}`;
    const identity = await loadWorkspaceDeletionSnapshot(this.env.DATABASE, workspaceId);
    const existing = await this.storage.get<PendingWorkspaceDeletion>(key);
    const scheduledIdentity: WorkspaceDeletionIdentity = options?.expected ??
      identity ?? {
        workspaceId,
        nodeId,
        nodeUserId: null,
        nodeRuntime: null,
        nodeProviderInstanceId: null,
        nodeRuntimeIncarnationId: null,
        userId,
        projectId: null,
        chatSessionId: null,
      };
    const existingClaimedWithoutNodeIncarnation =
      existing !== undefined &&
      (existing.attemptCount ?? 0) > 0 &&
      (existing.nodeUserId === undefined ||
        existing.nodeRuntime === undefined ||
        existing.nodeProviderInstanceId === undefined ||
        existing.nodeRuntimeIncarnationId === undefined);
    const existingMatches =
      existing !== undefined &&
      !existingClaimedWithoutNodeIncarnation &&
      existing.nodeId === scheduledIdentity.nodeId &&
      (existing.nodeUserId === undefined || existing.nodeUserId === scheduledIdentity.nodeUserId) &&
      (existing.nodeRuntime === undefined ||
        existing.nodeRuntime === scheduledIdentity.nodeRuntime) &&
      (existing.nodeProviderInstanceId === undefined ||
        existing.nodeProviderInstanceId === scheduledIdentity.nodeProviderInstanceId) &&
      (existing.nodeRuntimeIncarnationId === undefined ||
        existing.nodeRuntimeIncarnationId === scheduledIdentity.nodeRuntimeIncarnationId) &&
      existing.userId === scheduledIdentity.userId &&
      existing.projectId === scheduledIdentity.projectId &&
      existing.chatSessionId === scheduledIdentity.chatSessionId;
    if (existing && !existingMatches) {
      log.warn('node_lifecycle.workspace_deletion_schedule_fenced', {
        workspaceId,
        nodeId: existing.nodeId,
        currentNodeId: scheduledIdentity.nodeId,
        userId: existing.userId,
        action: 'existing_incarnation_preserved',
      });
      await this.recalculateAlarm(await this.getWarmAlarmTime());
      return;
    }
    if (existingMatches && existing.deadLetteredAt) {
      await this.recalculateAlarm(await this.getWarmAlarmTime());
      return;
    }

    const entry: PendingWorkspaceDeletion = {
      nodeId: scheduledIdentity.nodeId ?? nodeId,
      nodeUserId: scheduledIdentity.nodeUserId,
      nodeRuntime: scheduledIdentity.nodeRuntime,
      nodeProviderInstanceId: scheduledIdentity.nodeProviderInstanceId,
      nodeRuntimeIncarnationId: scheduledIdentity.nodeRuntimeIncarnationId,
      workspaceId,
      userId: scheduledIdentity.userId,
      projectId: scheduledIdentity.projectId,
      chatSessionId: scheduledIdentity.chatSessionId,
      deleteAt: existingMatches ? Math.min(existing.deleteAt, now + delayMs) : now + delayMs,
      firstScheduledAt: existingMatches ? (existing.firstScheduledAt ?? now) : now,
      attemptCount: existingMatches ? (existing.attemptCount ?? 0) : 0,
      lastAttemptAt: existingMatches ? (existing.lastAttemptAt ?? null) : null,
      lastError: options?.lastError ?? (existingMatches ? (existing.lastError ?? null) : null),
      claimId: existingMatches ? (existing.claimId ?? null) : null,
      deadLetteredAt: existingMatches ? (existing.deadLetteredAt ?? null) : null,
      deadLetterReason: existingMatches ? (existing.deadLetterReason ?? null) : null,
    };
    await this.putEntryWithAlarm(key, entry);

    log.info('node_lifecycle.workspace_deletion_scheduled', {
      workspaceId,
      nodeId: entry.nodeId,
      userId: entry.userId,
      deleteAt: new Date(entry.deleteAt).toISOString(),
      delayMs,
      attemptCount: entry.attemptCount,
    });
  }

  async claimAttempt(
    nodeId: string,
    workspaceId: string,
    userId: string,
    expected: WorkspaceDeletionIdentity
  ): Promise<boolean> {
    const current = await loadWorkspaceDeletionSnapshot(this.env.DATABASE, workspaceId);
    if (
      !current ||
      current.workspaceId !== expected.workspaceId ||
      current.nodeId !== expected.nodeId ||
      current.nodeUserId !== expected.nodeUserId ||
      current.nodeRuntime !== expected.nodeRuntime ||
      current.nodeProviderInstanceId !== expected.nodeProviderInstanceId ||
      current.nodeRuntimeIncarnationId !== expected.nodeRuntimeIncarnationId ||
      current.userId !== expected.userId ||
      current.projectId !== expected.projectId ||
      current.chatSessionId !== expected.chatSessionId
    ) {
      return false;
    }

    const key = `ws-delete:${workspaceId}`;
    const existing = await this.storage.get<PendingWorkspaceDeletion>(key);
    const existingMatches =
      !existing ||
      ((existing.nodeId ?? nodeId) === (expected.nodeId ?? nodeId) &&
        (existing.nodeUserId === undefined ? expected.nodeUserId : existing.nodeUserId) ===
          expected.nodeUserId &&
        (existing.nodeRuntime === undefined ? expected.nodeRuntime : existing.nodeRuntime) ===
          expected.nodeRuntime &&
        (existing.nodeProviderInstanceId === undefined
          ? expected.nodeProviderInstanceId
          : existing.nodeProviderInstanceId) === expected.nodeProviderInstanceId &&
        (existing.nodeRuntimeIncarnationId === undefined
          ? expected.nodeRuntimeIncarnationId
          : existing.nodeRuntimeIncarnationId) === expected.nodeRuntimeIncarnationId &&
        existing.userId === userId &&
        (existing.projectId ?? expected.projectId) === expected.projectId &&
        (existing.chatSessionId ?? expected.chatSessionId) === expected.chatSessionId);
    if (!existingMatches || (existing?.attemptCount ?? 0) > 0 || existing?.lastAttemptAt != null) {
      return false;
    }

    const now = Date.now();
    const claimId = crypto.randomUUID();
    const claimDiagnostic = `${WORKSPACE_DELETION_DIAGNOSTIC_PREFIX}: durable attempt 1 claimed`;
    const entry = {
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

    // Persist the attempt and its wake-up atomically before the cross-store CAS. If D1 is
    // unavailable, the alarm owns recovery and no caller is permitted to begin network I/O.
    await this.putEntryWithAlarm(key, entry);

    try {
      const claimed = await claimWorkspaceDeletionInD1(this.env, expected, 1, claimDiagnostic);
      if (!claimed) {
        await this.compensateExactClaim(key, claimId);
        return false;
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
    return latest?.claimId === claimId && !latest.deadLetteredAt;
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
    await this.storage.delete(`ws-delete:${workspaceId}`);
    await this.recalculateAlarm(await this.getWarmAlarmTime());
  }

  async cancel(workspaceId: string): Promise<boolean> {
    const key = `ws-delete:${workspaceId}`;
    const entry = await this.storage.get<PendingWorkspaceDeletion>(key);
    if (!entry) return true;
    if ((entry.attemptCount ?? 0) > 0 || entry.lastAttemptAt != null) {
      log.warn('node_lifecycle.workspace_deletion_cancel_fenced', {
        workspaceId,
        attemptCount: entry.attemptCount ?? 0,
        action: 'restart_refused',
      });
      return false;
    }
    await this.storage.delete(key);
    log.info('node_lifecycle.workspace_deletion_cancelled', { workspaceId });
    await this.recalculateAlarm(await this.getWarmAlarmTime());
    return true;
  }

  async processExpired(dispatch: WorkspaceDeletionAttemptDispatcher): Promise<void> {
    const pending = await this.getPending();
    const now = Date.now();
    const storedNodeId = await this.getStoredNodeId();
    const due = [...pending.entries()]
      .filter(([, entry]) => !entry.deadLetteredAt && entry.deleteAt <= now)
      .sort((left, right) => left[1].deleteAt - right[1].deleteAt)
      .slice(0, workspaceDeletionAlarmBatchSize(this.env));

    for (const [key, entry] of due) {
      entry.firstScheduledAt ??= now;
      const currentIdentity = await loadWorkspaceDeletionSnapshot(
        this.env.DATABASE,
        entry.workspaceId
      );
      const legacyStartedWithoutNodeIncarnation =
        (entry.attemptCount ?? 0) > 0 &&
        (entry.nodeUserId === undefined ||
          entry.nodeRuntime === undefined ||
          entry.nodeProviderInstanceId === undefined ||
          entry.nodeRuntimeIncarnationId === undefined);
      if (legacyStartedWithoutNodeIncarnation) {
        dispatch(
          this.deadLetterExact(
            key,
            entry.claimId ?? null,
            entry,
            'claimed attempt lacks an immutable node-incarnation snapshot'
          )
        );
        continue;
      }
      if (currentIdentity?.runtimeDeletionConfirmedAt && currentIdentity.runtimeDeletionProof) {
        dispatch(this.deleteExact(key, entry.claimId ?? null));
        continue;
      }
      if (now - entry.firstScheduledAt >= workspaceDeletionMaxResidenceMs(this.env)) {
        dispatch(
          this.deadLetterExact(
            key,
            entry.claimId ?? null,
            entry,
            'maximum retry residence exceeded'
          )
        );
        continue;
      }
      const nodeId = entry.nodeId ?? storedNodeId;
      if (!nodeId && !currentIdentity) {
        dispatch(
          this.deadLetterExact(
            key,
            entry.claimId ?? null,
            entry,
            'workspace and node identity unavailable'
          )
        );
        continue;
      }

      const expected: WorkspaceDeletionIdentity = {
        workspaceId: entry.workspaceId,
        nodeId: nodeId ?? currentIdentity?.nodeId ?? null,
        nodeUserId:
          entry.nodeUserId === undefined ? (currentIdentity?.nodeUserId ?? null) : entry.nodeUserId,
        nodeRuntime:
          entry.nodeRuntime === undefined
            ? (currentIdentity?.nodeRuntime ?? null)
            : entry.nodeRuntime,
        nodeProviderInstanceId:
          entry.nodeProviderInstanceId === undefined
            ? (currentIdentity?.nodeProviderInstanceId ?? null)
            : entry.nodeProviderInstanceId,
        nodeRuntimeIncarnationId:
          entry.nodeRuntimeIncarnationId === undefined
            ? (currentIdentity?.nodeRuntimeIncarnationId ?? null)
            : entry.nodeRuntimeIncarnationId,
        userId: entry.userId,
        projectId:
          entry.projectId === undefined ? (currentIdentity?.projectId ?? null) : entry.projectId,
        chatSessionId:
          entry.chatSessionId === undefined
            ? (currentIdentity?.chatSessionId ?? null)
            : entry.chatSessionId,
      };
      const attempt = (entry.attemptCount ?? 0) + 1;
      const latest = await this.storage.get<PendingWorkspaceDeletion>(key);
      if (
        !latest ||
        latest.deadLetteredAt ||
        (latest.attemptCount ?? 0) !== (entry.attemptCount ?? 0) ||
        (latest.claimId ?? null) !== (entry.claimId ?? null)
      ) {
        continue;
      }

      const claimId = crypto.randomUUID();
      const claimedEntry: PendingWorkspaceDeletion = {
        ...entry,
        nodeId: expected.nodeId ?? undefined,
        nodeUserId: expected.nodeUserId,
        nodeRuntime: expected.nodeRuntime,
        nodeProviderInstanceId: expected.nodeProviderInstanceId,
        nodeRuntimeIncarnationId: expected.nodeRuntimeIncarnationId,
        projectId: expected.projectId,
        chatSessionId: expected.chatSessionId,
        deleteAt: now + workspaceDeletionRetryDelayMs(this.env, attempt),
        firstScheduledAt: entry.firstScheduledAt,
        attemptCount: attempt,
        lastAttemptAt: now,
        claimId,
        deadLetteredAt: null,
        deadLetterReason: null,
      };
      await this.putEntryWithAlarm(key, claimedEntry);

      if (!currentIdentity) {
        // A missing workspace can converge only through strict node-runtime proof.
        // attemptWorkspaceDeletion checks that proof before making any VM request.
        dispatch(this.runClaimedAttempt(key, claimId, claimedEntry, expected, attempt));
        continue;
      }

      try {
        const d1Claimed = await claimWorkspaceDeletionInD1(
          this.env,
          expected,
          attempt,
          `${WORKSPACE_DELETION_DIAGNOSTIC_PREFIX}: durable attempt ${attempt} claimed`
        );
        if (!d1Claimed) {
          dispatch(
            this.deadLetterExact(
              key,
              claimId,
              claimedEntry,
              'workspace identity or status changed before VM deletion'
            )
          );
          continue;
        }
      } catch (error) {
        await this.updateExactClaim(key, claimId, {
          lastError: 'D1 deletion claim failed before VM request',
        });
        log.error('node_lifecycle.workspace_deletion_d1_claim_failed', {
          workspaceId: claimedEntry.workspaceId,
          userId: claimedEntry.userId,
          attempt,
          error: error instanceof Error ? error.message : String(error),
          action: 'durable_claim_retained',
        });
        continue;
      }

      // The network path begins only after both durable claim and exact D1 claim exist. It is
      // deliberately detached from the alarm critical section under Rule 47.
      dispatch(this.runClaimedAttempt(key, claimId, claimedEntry, expected, attempt));
    }
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
    let earliest = warmAlarmTime;
    const pending = await this.getPending();
    for (const [, entry] of pending) {
      if (entry.deadLetteredAt) continue;
      if (earliest === null || entry.deleteAt < earliest) earliest = entry.deleteAt;
    }
    if (earliest !== null) await this.storage.setAlarm(earliest);
    else await this.storage.deleteAlarm();
  }

  private async getPending(): Promise<Map<string, PendingWorkspaceDeletion>> {
    return await this.storage.list<PendingWorkspaceDeletion>({ prefix: 'ws-delete:' });
  }

  private async putEntryWithAlarm(key: string, entry: PendingWorkspaceDeletion): Promise<void> {
    const warmAlarmTime = await this.getWarmAlarmTime();
    const now = Date.now();
    await this.storage.transaction(async (transaction) => {
      const currentAlarm = await transaction.getAlarm();
      const futureAlarm = currentAlarm !== null && currentAlarm > now ? currentAlarm : null;
      const nextAlarm = [futureAlarm, warmAlarmTime, entry.deleteAt]
        .filter((value): value is number => value !== null)
        .reduce((earliest, value) => Math.min(earliest, value));
      await transaction.put(key, entry);
      await transaction.setAlarm(nextAlarm);
    });
  }

  private async compensateExactClaim(key: string, claimId: string): Promise<void> {
    await this.storage.transaction(async (transaction) => {
      const current = await transaction.get<PendingWorkspaceDeletion>(key);
      if (current?.claimId === claimId) await transaction.delete(key);
    });
    await this.recalculateAlarm(await this.getWarmAlarmTime());
  }

  private async deleteExact(key: string, claimId: string | null): Promise<void> {
    await this.storage.transaction(async (transaction) => {
      const current = await transaction.get<PendingWorkspaceDeletion>(key);
      if (current && (current.claimId ?? null) === claimId) await transaction.delete(key);
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
      await transaction.put(key, { ...current, ...update });
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
