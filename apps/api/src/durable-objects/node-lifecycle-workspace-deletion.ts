import {
  DEFAULT_WORKSPACE_DELETION_ALARM_BATCH_SIZE,
  DEFAULT_WORKSPACE_DELETION_RETRY_BASE_MS,
  DEFAULT_WORKSPACE_DELETION_RETRY_MAX_MS,
  DEFAULT_WORKSPACE_STOPPED_TTL_MS,
} from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { getNodeAgentBackgroundRequestTimeoutMs } from '../services/node-agent';
import {
  attemptWorkspaceDeletion,
  loadWorkspaceDeletionIdentity,
  WORKSPACE_DELETION_DIAGNOSTIC_PREFIX,
  type WorkspaceDeletionIdentity,
} from '../services/workspace-deletion';

export type NodeLifecycleDeletionEnv = {
  DATABASE: D1Database;
  WORKSPACE_STOPPED_TTL_MS?: string;
  WORKSPACE_DELETION_RETRY_BASE_MS?: string;
  WORKSPACE_DELETION_RETRY_MAX_MS?: string;
  WORKSPACE_DELETION_ALARM_BATCH_SIZE?: string;
  WORKSPACE_DELETION_DIAGNOSTIC_MAX_LENGTH?: string;
  NODE_AGENT_BACKGROUND_REQUEST_TIMEOUT_MS?: string;
};

interface PendingWorkspaceDeletion {
  nodeId?: string;
  workspaceId: string;
  userId: string;
  projectId?: string | null;
  chatSessionId?: string | null;
  deleteAt: number;
  firstScheduledAt?: number;
  attemptCount?: number;
  lastAttemptAt?: number | null;
  lastError?: string | null;
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
  ): Promise<void> {
    const now = Date.now();
    const delayMs = options?.retryAfterMs ?? this.getWorkspaceStoppedTtlMs();
    const key = `ws-delete:${workspaceId}`;
    const identity = await loadWorkspaceDeletionIdentity(this.env.DATABASE, workspaceId);
    const existing = await this.storage.get<PendingWorkspaceDeletion>(key);
    const scheduledIdentity: WorkspaceDeletionIdentity = options?.expected ??
      identity ?? {
        workspaceId,
        nodeId,
        userId,
        projectId: null,
        chatSessionId: null,
      };
    const existingMatches =
      existing?.nodeId === scheduledIdentity.nodeId &&
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

    const entry: PendingWorkspaceDeletion = {
      nodeId: scheduledIdentity.nodeId ?? nodeId,
      workspaceId,
      userId: scheduledIdentity.userId,
      projectId: scheduledIdentity.projectId,
      chatSessionId: scheduledIdentity.chatSessionId,
      deleteAt: existingMatches ? Math.min(existing.deleteAt, now + delayMs) : now + delayMs,
      firstScheduledAt: existingMatches ? (existing.firstScheduledAt ?? now) : now,
      attemptCount: existingMatches ? (existing.attemptCount ?? 0) : 0,
      lastAttemptAt: existingMatches ? (existing.lastAttemptAt ?? null) : null,
      lastError: options?.lastError ?? (existingMatches ? (existing.lastError ?? null) : null),
    };
    await this.storage.put(key, entry);

    log.info('node_lifecycle.workspace_deletion_scheduled', {
      workspaceId,
      nodeId: entry.nodeId,
      userId: entry.userId,
      deleteAt: new Date(entry.deleteAt).toISOString(),
      delayMs,
      attemptCount: entry.attemptCount,
    });
    await this.recalculateAlarm(await this.getWarmAlarmTime());
  }

  async claimAttempt(
    nodeId: string,
    workspaceId: string,
    userId: string,
    expected: WorkspaceDeletionIdentity
  ): Promise<boolean> {
    const current = await loadWorkspaceDeletionIdentity(this.env.DATABASE, workspaceId);
    if (
      !current ||
      current.workspaceId !== expected.workspaceId ||
      current.nodeId !== expected.nodeId ||
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
        existing.userId === userId &&
        (existing.projectId ?? expected.projectId) === expected.projectId &&
        (existing.chatSessionId ?? expected.chatSessionId) === expected.chatSessionId);
    if (!existingMatches || (existing?.attemptCount ?? 0) > 0 || existing?.lastAttemptAt != null) {
      return false;
    }

    const now = Date.now();
    const claimed = await this.env.DATABASE.prepare(
      `UPDATE workspaces
          SET status = 'stopping', error_message = ?, updated_at = ?
        WHERE id = ?
          AND node_id IS ?
          AND user_id = ?
          AND project_id IS ?
          AND chat_session_id IS ?
          AND status IN ('stopped', 'sleeping', 'stopping', 'deleted')`
    )
      .bind(
        `${WORKSPACE_DELETION_DIAGNOSTIC_PREFIX}: durable attempt 1 claimed`,
        new Date().toISOString(),
        expected.workspaceId,
        expected.nodeId,
        expected.userId,
        expected.projectId,
        expected.chatSessionId
      )
      .run();
    if ((claimed.meta.changes ?? 0) === 0) {
      return false;
    }

    // The status CAS happens before the durable claim so a restart that won
    // after a scheduled scan cannot be overwritten by a stale cleanup
    // candidate. Callers do not begin network I/O until this durable write is
    // complete, so a successful return still means the attempt was claimed
    // before any external side effect.
    await this.storage.put(key, {
      nodeId: expected.nodeId ?? nodeId,
      workspaceId,
      userId,
      projectId: expected.projectId,
      chatSessionId: expected.chatSessionId,
      deleteAt: now + this.getRetryDelayMs(1),
      firstScheduledAt: existing?.firstScheduledAt ?? now,
      attemptCount: 1,
      lastAttemptAt: now,
      lastError: existing?.lastError ?? null,
    } satisfies PendingWorkspaceDeletion);
    await this.recalculateAlarm(await this.getWarmAlarmTime());
    return true;
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

  async processExpired(): Promise<void> {
    const pending = await this.getPending();
    const now = Date.now();
    const storedNodeId = await this.getStoredNodeId();
    const due = [...pending.entries()]
      .filter(([, entry]) => entry.deleteAt <= now)
      .sort((left, right) => left[1].deleteAt - right[1].deleteAt)
      .slice(0, this.getAlarmBatchSize());

    for (const [key, entry] of due) {
      const currentIdentity = await loadWorkspaceDeletionIdentity(
        this.env.DATABASE,
        entry.workspaceId
      );
      const nodeId = entry.nodeId ?? storedNodeId;
      if (!nodeId && !currentIdentity) {
        log.error('node_lifecycle.workspace_deletion_missing_node_id', {
          workspaceId: entry.workspaceId,
          userId: entry.userId,
        });
        entry.deleteAt = now + this.getRetryDelayMs(entry.attemptCount ?? 0);
        await this.storage.put(key, entry);
        continue;
      }

      const expected: WorkspaceDeletionIdentity = {
        workspaceId: entry.workspaceId,
        nodeId: nodeId ?? currentIdentity?.nodeId ?? null,
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
      if (!latest || (latest.attemptCount ?? 0) !== (entry.attemptCount ?? 0)) continue;
      entry.nodeId = expected.nodeId ?? undefined;
      entry.projectId = expected.projectId;
      entry.chatSessionId = expected.chatSessionId;
      entry.firstScheduledAt ??= now;
      entry.attemptCount = attempt;
      entry.lastAttemptAt = now;
      await this.storage.put(key, entry);

      const d1Claim = await this.env.DATABASE.prepare(
        `UPDATE workspaces
            SET status = 'stopping', error_message = ?, updated_at = ?
          WHERE id = ?
            AND node_id IS ?
            AND user_id = ?
            AND project_id IS ?
            AND chat_session_id IS ?
            AND status IN ('stopped', 'sleeping', 'stopping', 'deleted')`
      )
        .bind(
          `${WORKSPACE_DELETION_DIAGNOSTIC_PREFIX}: durable attempt ${attempt} claimed`,
          new Date().toISOString(),
          expected.workspaceId,
          expected.nodeId,
          expected.userId,
          expected.projectId,
          expected.chatSessionId
        )
        .run();
      if ((d1Claim.meta.changes ?? 0) === 0) {
        entry.lastError = 'workspace identity or status changed before VM deletion';
        entry.deleteAt = now + this.getRetryDelayMs(attempt);
        await this.storage.put(key, entry);
        continue;
      }

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
          await this.storage.delete(key);
          log.info('node_lifecycle.workspace_auto_deleted', {
            workspaceId: entry.workspaceId,
            userId: entry.userId,
            attempt,
            proof: outcome.proof,
          });
          continue;
        }

        entry.nodeId = expected.nodeId ?? undefined;
        entry.projectId = expected.projectId;
        entry.chatSessionId = expected.chatSessionId;
        entry.firstScheduledAt ??= now;
        entry.lastError = outcome.status === 'retry' ? outcome.diagnostic : outcome.reason;
        entry.deleteAt = now + this.getRetryDelayMs(attempt);
        await this.storage.put(key, entry);
        log.warn('node_lifecycle.workspace_deletion_quarantined', {
          workspaceId: entry.workspaceId,
          nodeId: expected.nodeId,
          userId: entry.userId,
          attempt,
          outcome: outcome.status,
          reason: outcome.reason,
          retryAt: new Date(entry.deleteAt).toISOString(),
        });
      } catch (error) {
        log.error('node_lifecycle.workspace_deletion_failed', {
          workspaceId: entry.workspaceId,
          userId: entry.userId,
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
        entry.lastError = 'workspace deletion attempt failed before classification';
        entry.deleteAt = now + this.getRetryDelayMs(attempt);
        await this.storage.put(key, entry);
      }
    }
  }

  async recalculateAlarm(warmAlarmTime: number | null): Promise<void> {
    let earliest = warmAlarmTime;
    const pending = await this.getPending();
    for (const [, entry] of pending) {
      if (earliest === null || entry.deleteAt < earliest) earliest = entry.deleteAt;
    }
    if (earliest !== null) await this.storage.setAlarm(earliest);
    else await this.storage.deleteAlarm();
  }

  private async getPending(): Promise<Map<string, PendingWorkspaceDeletion>> {
    return await this.storage.list<PendingWorkspaceDeletion>({ prefix: 'ws-delete:' });
  }

  private getWorkspaceStoppedTtlMs(): number {
    const parsed = Number.parseInt(this.env.WORKSPACE_STOPPED_TTL_MS ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WORKSPACE_STOPPED_TTL_MS;
  }

  private getRetryDelayMs(attemptCount: number): number {
    const parsedBase = Number.parseInt(this.env.WORKSPACE_DELETION_RETRY_BASE_MS ?? '', 10);
    const baseMs =
      Number.isFinite(parsedBase) && parsedBase > 0
        ? parsedBase
        : DEFAULT_WORKSPACE_DELETION_RETRY_BASE_MS;
    const parsedMax = Number.parseInt(this.env.WORKSPACE_DELETION_RETRY_MAX_MS ?? '', 10);
    const maxMs =
      Number.isFinite(parsedMax) && parsedMax >= baseMs
        ? parsedMax
        : Math.max(baseMs, DEFAULT_WORKSPACE_DELETION_RETRY_MAX_MS);
    const exponent = Math.min(Math.max(attemptCount - 1, 0), 30);
    return Math.min(baseMs * 2 ** exponent, maxMs);
  }

  private getAlarmBatchSize(): number {
    const parsed = Number.parseInt(this.env.WORKSPACE_DELETION_ALARM_BATCH_SIZE ?? '', 10);
    return Number.isInteger(parsed) && parsed > 0
      ? parsed
      : DEFAULT_WORKSPACE_DELETION_ALARM_BATCH_SIZE;
  }
}
