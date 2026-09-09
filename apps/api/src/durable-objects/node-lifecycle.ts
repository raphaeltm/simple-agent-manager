/**
 * NodeLifecycle Durable Object — per-node warm pool state machine.
 *
 * Manages the lifecycle of auto-provisioned nodes after their active workspaces leave:
 * - `active`: Node has running workspaces. No alarm.
 * - `warm`: Node is idle (no workspaces). Alarm set at warm_timeout.
 * - `destroying`: Alarm fired. D1 marked for cron sweep to destroy.
 *
 * State transitions:
 *   markIdle()    → sets `warm`, schedules alarm, updates D1 warm_since
 *   markActive()  → sets `active`, cancels alarm, clears D1 warm_since
 *   tryClaim()    → on `warm`: sets `active` + claimedByTask, cancels alarm
 *                 → on `active`/`destroying`: returns false
 *   alarm()       → on `warm`: sets `destroying`, updates D1, cron handles teardown
 *                 → on `active`: no-op (was claimed between schedule and fire)
 *
 * Workspace auto-deletion:
 *   scheduleWorkspaceDeletion(nodeId, workspaceId, userId) → stores pending deletion, recalculates alarm
 *   cancelWorkspaceDeletion(workspaceId) → removes pending deletion, recalculates alarm
 *   alarm() → also processes expired workspace deletions (calls VM agent, updates D1)
 *
 * Bare node-ID instances hand infrastructure destruction to the cron sweep.
 * Prefixed allocation/workspace-create instances additionally own durable direct
 * provisioning intents, isolated from this warm/deletion state machine. Their
 * bounded background calls use the same full Worker bindings and credential
 * resolution as TaskRunner provisioning.
 *
 * See: specs/021-task-chat-architecture/tasks.md (Phase 5)
 */
import type { NodeLifecycleState, NodeLifecycleStatus } from '@simple-agent-manager/shared';
import {
  DEFAULT_NODE_LIFECYCLE_ALARM_RETRY_MS,
  DEFAULT_NODE_LIFECYCLE_MAX_DESTROYING_AGE_MS,
  DEFAULT_NODE_WARM_TIMEOUT_MS,
  DEFAULT_NODE_WORKSPACE_IDLE_TIMEOUT_MS,
  isUserOwnedNodeClass,
} from '@simple-agent-manager/shared';
import { DurableObject } from 'cloudflare:workers';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';
import type { DirectProvisioningInput } from '../services/direct-provisioning';
import { deferAlarmWhenDisabled } from '../services/operational-kill-switch';
import {
  isSessionRecoveryTaskAuthorized,
  type SessionRecoverySourceTaskGuard,
} from '../services/session-recovery-authority';
import { boundedWarmPlacementClaimGuardSql } from '../services/warm-placement-claims';
import type { WorkspaceDeletionIdentity } from '../services/workspace-deletion';
import { ACTIVE_WORKSPACE_RESERVATION_STATUS_SQL } from '../services/workspace-resource-capacity';
import { NodeLifecycleProvisioning } from './node-lifecycle-provisioning';
import {
  type NodeLifecycleDeletionEnv,
  NodeLifecycleWorkspaceDeletionQueue,
  type WorkspaceDeletionClaimResult,
  type WorkspaceDeletionMode,
} from './node-lifecycle-workspace-deletion';

type NodeLifecycleEnv = NodeLifecycleDeletionEnv & {
  KV: KVNamespace;
  NODE_WARM_TIMEOUT_MS?: string;
  NODE_WORKSPACE_IDLE_TIMEOUT_MS?: string;
  NODE_ORPHAN_IDLE_TIMEOUT_MS?: string;
  NODE_LIFECYCLE_MAX_DESTROYING_AGE_MS?: string;
  DO_ALARMS_ENABLED_KV_KEY?: string;
  CONTROL_LOOP_KILL_SWITCH_CACHE_MS?: string;
  CONTROL_LOOP_DISABLED_ALARM_RETRY_MS?: string;
};

interface StoredState {
  nodeId: string;
  userId: string;
  status: NodeLifecycleStatus;
  warmSince: number | null;
  claimedByTask: string | null;
  /** Per-project warm timeout override (ms). Null = use platform default. */
  warmTimeoutOverrideMs?: number | null;
  /** First transition into destroying, used to bound this nudge-only alarm chain. */
  destroyingSince?: number;
}

export class NodeLifecycle extends DurableObject<NodeLifecycleEnv> {
  private provisioningController?: NodeLifecycleProvisioning;
  private provisioning(): NodeLifecycleProvisioning {
    return (this.provisioningController ??= new NodeLifecycleProvisioning(
      this.ctx,
      this.env as Env
    ));
  }
  async startProvisioning(input: DirectProvisioningInput): Promise<void> {
    await this.provisioning().start(input);
  }

  private async persistWarmClaim(
    nodeId: string,
    taskId: string,
    sourceTaskGuard?: SessionRecoverySourceTaskGuard
  ): Promise<'claimed' | 'unavailable' | 'source_task_revoked'> {
    const now = new Date().toISOString();
    const guarded = sourceTaskGuard ? 1 : 0;
    const result = await this.env.DATABASE.prepare(
      `UPDATE tasks AS recovery
          SET claimed_warm_node_at = CASE
                WHEN recovery.claimed_warm_node_id = ?
                 AND recovery.claimed_warm_node_at IS NOT NULL
                  THEN recovery.claimed_warm_node_at
                ELSE ?
              END,
              claimed_warm_node_id = ?, updated_at = ?
        WHERE recovery.id = ?
          AND recovery.status NOT IN ('completed', 'failed', 'cancelled')
          AND EXISTS (SELECT 1 FROM nodes WHERE id = ? AND status = 'running')
          AND NOT EXISTS (
            SELECT 1 FROM tasks incumbent
             WHERE incumbent.claimed_warm_node_id = ?
               AND incumbent.id != recovery.id
               AND incumbent.status NOT IN ('completed', 'failed', 'cancelled')
          )
          AND (
            ? = 0
            OR (
              recovery.recovery_source_task_id = ?
              AND recovery.project_id = ?
              AND recovery.chat_session_id = ?
              AND recovery.triggered_by = 'session-recovery'
              AND EXISTS (
                SELECT 1 FROM tasks source
                 WHERE source.id = ?
                   AND source.project_id = recovery.project_id
                   AND source.status NOT IN ('completed', 'failed', 'cancelled')
              )
              AND EXISTS (
                SELECT 1 FROM session_snapshots snapshot
                 WHERE snapshot.chat_session_id = recovery.chat_session_id
                   AND snapshot.project_id = recovery.project_id
                   AND snapshot.recovery_task_id = recovery.id
                   AND snapshot.recovery_status IN ('waking', 'restored')
              )
            )
          )`
    )
      .bind(
        nodeId,
        now,
        nodeId,
        now,
        taskId,
        nodeId,
        nodeId,
        guarded,
        sourceTaskGuard?.taskId ?? '',
        sourceTaskGuard?.projectId ?? '',
        sourceTaskGuard?.chatSessionId ?? '',
        sourceTaskGuard?.taskId ?? ''
      )
      .run();
    if ((result.meta.changes ?? 0) > 0) return 'claimed';
    if (!sourceTaskGuard) return 'unavailable';
    const authorized = await isSessionRecoveryTaskAuthorized(this.env.DATABASE, {
      recoveryTaskId: taskId,
      sourceTaskId: sourceTaskGuard.taskId,
      projectId: sourceTaskGuard.projectId,
      chatSessionId: sourceTaskGuard.chatSessionId,
    });
    return authorized ? 'unavailable' : 'source_task_revoked';
  }

  private async clearWarmClaim(taskId: string, nodeId: string): Promise<void> {
    await this.env.DATABASE.prepare(
      `UPDATE tasks
          SET claimed_warm_node_id = NULL, claimed_warm_node_at = NULL, updated_at = ?
        WHERE id = ? AND claimed_warm_node_id = ?`
    )
      .bind(new Date().toISOString(), taskId, nodeId)
      .run();
  }

  /**
   * Mark a node as idle (warm). Called after the last workspace on the node
   * is destroyed. Schedules an alarm at now + warm_timeout.
   *
   * If already warm, resets the alarm to a new timeout.
   * Throws if the node is currently being destroyed.
   */
  async markIdle(
    nodeId: string,
    userId: string,
    warmTimeoutOverrideMs?: number | null
  ): Promise<NodeLifecycleState> {
    // Resolve node class FIRST, before reading DO state. isUserOwnedNode does a D1 fetch (external
    // I/O), which opens the DO input gate. If it ran BETWEEN the state read and the storage.put
    // below, a concurrent tryClaim (fired by the TaskRunner's warm-node claim on every new task)
    // could interleave during that fetch and then be silently stomped by our blind overwrite —
    // leaving the node stuck 'stopped' while serving a live workspace. Fetching it before the read
    // keeps the read→put critical section free of external I/O so the input gate serializes it,
    // matching the original pre-guard behavior. See rule 45 + architecture-critique #2.
    const userOwned = await this.isUserOwnedNode(nodeId);
    const occupied = await this.hasActiveWorkspace(nodeId);

    const state = await this.getStoredState();
    const previousClaim = state?.claimedByTask ?? null;
    const now = Date.now();

    // User-owned (BYO) machines must NEVER enter the warm → destroying teardown pipeline: SAM does
    // not own the hardware and must not schedule its destruction. Keep the node active (no warm
    // alarm) instead. BYO nodes are never auto-provisioned so markIdle should not reach them, but
    // this is the DO chokepoint guard. See architecture-critique #2.
    if (userOwned || occupied) {
      log.info('node_lifecycle.mark_idle_preserved', { nodeId, userOwned, occupied });
      const activeState: StoredState = {
        nodeId,
        userId,
        status: 'active',
        warmSince: null,
        claimedByTask: previousClaim,
        warmTimeoutOverrideMs: null,
      };
      await this.ctx.storage.put('state', activeState);
      // No warm alarm; preserve any pending workspace-deletion alarms.
      await this.recalculateAlarm(null);
      await this.updateD1WarmSince(nodeId, null);
      return this.toPublicState(activeState);
    }

    if (state && state.status === 'destroying') {
      throw new Error('node_lifecycle_conflict: node is being destroyed');
    }

    const warmTimeout = warmTimeoutOverrideMs ?? this.getWarmTimeoutMs();

    const newState: StoredState = {
      nodeId,
      userId,
      status: 'warm',
      warmSince: now,
      claimedByTask: null,
      warmTimeoutOverrideMs: warmTimeoutOverrideMs ?? null,
    };
    await this.ctx.storage.put('state', newState);

    // Recalculate alarm considering both warm timeout and pending workspace deletions
    await this.recalculateAlarm(now + warmTimeout);

    // Update D1 warm_since column
    await this.updateD1WarmSince(nodeId, new Date(now).toISOString());
    if (previousClaim) await this.clearWarmClaim(previousClaim, nodeId);

    return this.toPublicState(newState);
  }

  /**
   * Mark a node as active. Called when a workspace starts on the node.
   * Cancels any pending warm timeout alarm but preserves workspace deletion alarms.
   */
  async markActive(): Promise<NodeLifecycleState> {
    const state = await this.getStoredState();
    if (!state) {
      throw new Error('node_lifecycle_not_found: no state stored');
    }

    const previousClaim = state.claimedByTask;
    state.status = 'active';
    state.claimedByTask = null;
    state.warmSince = null;
    await this.ctx.storage.put('state', state);

    // Recalculate alarm — pending workspace deletions still need to fire
    await this.recalculateAlarm(null);

    // Clear D1 warm_since
    await this.updateD1WarmSince(state.nodeId, null);
    if (previousClaim) await this.clearWarmClaim(previousClaim, state.nodeId);

    return this.toPublicState(state);
  }

  /**
   * Try to claim a warm node for a new task. Only succeeds on `warm` nodes.
   *
   * Returns `{ claimed: true, state }` if the node was warm and is now active,
   * or `{ claimed: false, state }` if the node was already active or destroying.
   */
  async tryClaim(
    taskId: string,
    sourceTaskGuard?: SessionRecoverySourceTaskGuard
  ): Promise<{
    claimed: boolean;
    state: NodeLifecycleState;
    reason?: 'source_task_revoked';
  }> {
    const state = await this.getStoredState();
    if (!state) {
      return {
        claimed: false,
        state: { nodeId: '', status: 'active', warmSince: null, claimedByTask: null },
      };
    }

    if (state.status === 'active' && state.claimedByTask === taskId) {
      const claimResult = await this.persistWarmClaim(state.nodeId, taskId, sourceTaskGuard);
      return claimResult === 'claimed'
        ? { claimed: true, state: this.toPublicState(state) }
        : {
            claimed: false,
            state: this.toPublicState(state),
            ...(claimResult === 'source_task_revoked'
              ? { reason: 'source_task_revoked' as const }
              : {}),
          };
    }

    if (state.status !== 'warm') {
      return { claimed: false, state: this.toPublicState(state) };
    }

    // This single conditional D1 write both proves live recovery authority and
    // records the exact node claim before the DO cancels its teardown alarm.
    const claimResult = await this.persistWarmClaim(state.nodeId, taskId, sourceTaskGuard);
    if (claimResult !== 'claimed') {
      return {
        claimed: false,
        state: this.toPublicState(state),
        ...(claimResult === 'source_task_revoked'
          ? { reason: 'source_task_revoked' as const }
          : {}),
      };
    }

    // Claim it
    state.status = 'active';
    state.claimedByTask = taskId;
    state.warmSince = null;
    await this.ctx.storage.put('state', state);

    // Recalculate alarm — pending workspace deletions still need to fire
    await this.recalculateAlarm(null);

    // Clear D1 warm_since
    await this.updateD1WarmSince(state.nodeId, null);

    return { claimed: true, state: this.toPublicState(state) };
  }

  /** Release only the exact task's still-unconsumed warm-node claim. */
  async releaseClaim(taskId: string): Promise<{ released: boolean; state: NodeLifecycleState }> {
    const state = await this.getStoredState();
    if (!state) {
      return {
        released: false,
        state: { nodeId: '', status: 'active', warmSince: null, claimedByTask: null },
      };
    }
    if (state.status !== 'active' || state.claimedByTask !== taskId) {
      return { released: false, state: this.toPublicState(state) };
    }

    const now = Date.now();
    state.status = 'warm';
    state.claimedByTask = null;
    state.warmSince = now;
    await this.ctx.storage.put('state', state);
    await this.recalculateAlarm(now + (state.warmTimeoutOverrideMs ?? this.getWarmTimeoutMs()));
    await this.updateD1WarmSince(state.nodeId, new Date(now).toISOString());
    await this.clearWarmClaim(taskId, state.nodeId);
    return { released: true, state: this.toPublicState(state) };
  }

  /**
   * Get current lifecycle state.
   */
  async getStatus(): Promise<NodeLifecycleState> {
    const state = await this.getStoredState();
    if (!state) {
      return { nodeId: '', status: 'active', warmSince: null, claimedByTask: null };
    }
    return this.toPublicState(state);
  }

  /**
   * Reconcile an explicit API deletion with this node's lifecycle state.
   *
   * The API removes provider resources and D1 rows synchronously. Routing that
   * terminal action through the same destroying handler clears any warm or
   * workspace-deletion alarm and emits the canonical terminal event instead of
   * leaving an orphaned Durable Object alarm behind.
   */
  async finalizeDeletion(nodeId: string, userId: string): Promise<void> {
    const previous = await this.getStoredState();
    const state: StoredState = {
      nodeId,
      userId,
      status: 'destroying',
      warmSince: previous?.warmSince ?? null,
      claimedByTask: null,
      warmTimeoutOverrideMs: previous?.warmTimeoutOverrideMs ?? null,
      destroyingSince: previous?.destroyingSince ?? Date.now(),
    };

    await this.ctx.storage.put('state', state);
    await this.cleanupDestroyingState(nodeId, 'explicit_terminal_proof', true);
  }

  // =========================================================================
  // Workspace auto-deletion scheduling
  // =========================================================================

  /**
   * Schedule a stopped workspace for automatic deletion after the configured TTL.
   * Called when a workspace transitions to 'stopped' status.
   */
  async scheduleWorkspaceDeletion(
    nodeId: string,
    workspaceId: string,
    userId: string,
    options?: {
      retryAfterMs?: number;
      lastError?: string | null;
      expected?: WorkspaceDeletionIdentity;
    }
  ): Promise<boolean> {
    return await this.workspaceDeletionQueue().schedule(nodeId, workspaceId, userId, options);
  }

  /**
   * Claim an immediate external delete in durable storage before its network
   * request begins. A pre-existing claimed attempt wins and prevents parallel
   * explicit/cron deletion calls.
   */
  async claimWorkspaceDeletionAttempt(
    nodeId: string,
    workspaceId: string,
    userId: string,
    expected: WorkspaceDeletionIdentity,
    mode: WorkspaceDeletionMode
  ): Promise<WorkspaceDeletionClaimResult> {
    return await this.workspaceDeletionQueue().claimAttempt(
      nodeId,
      workspaceId,
      userId,
      expected,
      mode
    );
  }

  async getWorkspaceDeletionAttemptState(
    workspaceId: string
  ): Promise<{ pending: boolean; attemptStarted: boolean }> {
    return await this.workspaceDeletionQueue().getAttemptState(workspaceId);
  }

  /** Clear durable evidence only after a caller has proof-bearing confirmation. */
  async confirmWorkspaceDeletion(workspaceId: string): Promise<void> {
    await this.workspaceDeletionQueue().confirm(workspaceId);
  }

  /**
   * Cancel a pending workspace deletion. Called when a workspace is restarted
   * before the TTL expires.
   */
  async cancelWorkspaceDeletion(workspaceId: string): Promise<boolean> {
    return await this.workspaceDeletionQueue().cancel(workspaceId);
  }

  // =========================================================================
  // Alarm handler
  // =========================================================================

  /**
   * Alarm handler. Fires when either:
   * 1. The warm timeout expires (node should be destroyed)
   * 2. A workspace deletion is due
   *
   * Processes expired workspace deletions first, then handles warm timeout.
   */
  async alarm(): Promise<void> {
    if (await deferAlarmWhenDisabled(this.env, this.ctx.storage, 'NodeLifecycle')) return;
    if (await this.provisioning().alarm()) return;

    // Workspace deletion is independent from warm-pool state. In particular,
    // long-lived conversation workspaces can sleep before markIdle() has ever
    // initialized the per-node state record.
    await this.workspaceDeletionQueue().processExpired((attempt) => this.ctx.waitUntil(attempt));

    const state = await this.getStoredState();
    if (!state) {
      await this.recalculateAlarm(null);
      return;
    }

    if (state.status === 'destroying') {
      await this.handleDestroyingAlarm(state);
      return;
    }

    // No-op if node was claimed (active)
    if (state.status === 'active') {
      // Still recalculate alarm for any remaining pending workspace deletions
      await this.recalculateAlarm(null);
      return;
    }

    // status === 'warm' → check if warm timeout has actually expired
    if (state.warmSince) {
      const warmTimeout = state.warmTimeoutOverrideMs ?? this.getWarmTimeoutMs();
      const warmExpiry = state.warmSince + warmTimeout;
      if (Date.now() < warmExpiry) {
        // Warm timeout hasn't expired yet — alarm fired for workspace deletion only
        await this.recalculateAlarm(warmExpiry);
        return;
      }
    }

    await this.ctx.blockConcurrencyWhile(async () => {
      // Re-read after acquiring the input gate: a claim may have won during D1 I/O.
      const current = await this.getStoredState();
      if (!current || current.status !== 'warm') return;
      await this.handoffIdleNode(current);
    });
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  private async getStoredState(): Promise<StoredState | null> {
    return (await this.ctx.storage.get<StoredState>('state')) ?? null;
  }

  private async handleDestroyingAlarm(state: StoredState): Promise<void> {
    const now = Date.now();
    const destroyingSince = state.destroyingSince ?? state.warmSince ?? now;
    if (state.destroyingSince === undefined) {
      state.destroyingSince = destroyingSince;
      await this.ctx.storage.put('state', state);
    }

    if (now - destroyingSince >= this.getMaxDestroyingAgeMs()) {
      await this.cleanupDestroyingState(state.nodeId, 'max_destroying_age', false);
      return;
    }

    try {
      const node = await this.env.DATABASE.prepare('SELECT status FROM nodes WHERE id = ?')
        .bind(state.nodeId)
        .first<{ status: string }>();

      if (!node) {
        await this.cleanupDestroyingState(state.nodeId, 'node_absent', false);
        return;
      }

      if (node.status === 'stopped' || node.status === 'deleted') {
        await this.cleanupDestroyingState(state.nodeId, `node_${node.status}`, false);
        return;
      }

      // Legacy destroying records also need the final occupancy fence.
      await this.ctx.blockConcurrencyWhile(async () => {
        const current = await this.getStoredState();
        if (current?.status === 'destroying') await this.handoffIdleNode(current);
      });
      return;
    } catch (err) {
      log.error('node_lifecycle.destroying_d1_retry_failed', {
        nodeId: state.nodeId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    await this.recalculateAlarm(now + DEFAULT_NODE_LIFECYCLE_ALARM_RETRY_MS);
  }

  /** Atomic with workspace reservation, which only admits onto running nodes. */
  private async handoffIdleNode(state: StoredState): Promise<void> {
    const now = Date.now();
    const claimWindowMs = parsePositiveInt(
      this.env.NODE_WORKSPACE_IDLE_TIMEOUT_MS ?? this.env.NODE_ORPHAN_IDLE_TIMEOUT_MS,
      DEFAULT_NODE_WORKSPACE_IDLE_TIMEOUT_MS
    );
    try {
      const result = await this.env.DATABASE.prepare(
        `UPDATE nodes SET status = 'stopped', warm_since = NULL,
            health_status = 'stale', updated_at = ?
          WHERE id = ? AND user_id = ? AND status = 'running' AND node_class != 'user-owned'
            AND node_role = 'workspace'
            AND NOT EXISTS (
              SELECT 1 FROM workspaces
              WHERE node_id = nodes.id
                AND status IN (${ACTIVE_WORKSPACE_RESERVATION_STATUS_SQL})
            )
            ${boundedWarmPlacementClaimGuardSql('nodes.id')}`
      )
        .bind(
          new Date(now).toISOString(),
          state.nodeId,
          state.userId,
          new Date(now - claimWindowMs).toISOString()
        )
        .run();
      if ((result.meta.changes ?? 0) === 0) {
        const node = await this.env.DATABASE.prepare('SELECT status FROM nodes WHERE id = ?')
          .bind(state.nodeId)
          .first<{ status: string }>();
        if (!node || node.status === 'stopped' || node.status === 'deleted') {
          await this.cleanupDestroyingState(
            state.nodeId,
            node ? `node_${node.status}` : 'node_absent',
            false
          );
          return;
        }
        // A live reservation/claim or changed lifecycle won. Retire the stale
        // warm timer; workspace cleanup will arm a fresh timer when truly idle.
        state.status = 'active';
        state.warmSince = null;
        delete state.destroyingSince;
        await this.ctx.storage.put('state', state);
        await this.updateD1WarmSince(state.nodeId, null);
        await this.recalculateAlarm(null);
        log.info('node_lifecycle.warm_handoff_preserved', { nodeId: state.nodeId });
        return;
      }
      state.status = 'destroying';
      state.destroyingSince ??= now;
      await this.ctx.storage.put('state', state);
      log.info('node_lifecycle.alarm.warm_to_destroying', {
        nodeId: state.nodeId,
        userId: state.userId,
        warmSince: state.warmSince ? new Date(state.warmSince).toISOString() : null,
      });
    } catch (err) {
      log.error('node_lifecycle.alarm.d1_update_failed', {
        nodeId: state.nodeId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await this.recalculateAlarm(now + DEFAULT_NODE_LIFECYCLE_ALARM_RETRY_MS);
  }

  private async cleanupDestroyingState(
    nodeId: string,
    reason: string,
    terminalProof: boolean
  ): Promise<void> {
    if (terminalProof) {
      log.info('node_lifecycle.destroying_terminal', { nodeId, reason });
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      return;
    }

    // D1 lifecycle labels and row absence only retire the warm-node handoff;
    // they do not prove that every workspace runtime is gone. Keep durable
    // deletion claims (including detached in-flight attempts) and their next
    // alarm until VM/provider proof confirms them or they enter dead letter.
    log.info('node_lifecycle.destroying_state_retired', {
      nodeId,
      reason,
      workspaceDeletionsPreserved: true,
    });
    await this.ctx.storage.delete('state');
    await this.recalculateAlarm(null);
  }

  /**
   * True if the node is a user-owned (BYO) machine. On lookup failure returns false (treat as
   * managed) — the common case is a managed node, and the node-cleanup cron guards are the teardown
   * backstop, so failing to "managed" cannot destroy a BYO node.
   */
  private async hasActiveWorkspace(nodeId: string): Promise<boolean> {
    try {
      const row = await this.env.DATABASE.prepare(
        `SELECT 1 AS occupied FROM workspaces WHERE node_id = ?
          AND status IN (${ACTIVE_WORKSPACE_RESERVATION_STATUS_SQL}) LIMIT 1`
      )
        .bind(nodeId)
        .first<{ occupied: number }>();
      return row !== null;
    } catch (error) {
      // Never turn an uncertain occupancy read into a destructive fallback.
      log.warn('node_lifecycle.occupancy_unknown', { nodeId, error: String(error) });
      return true;
    }
  }

  private async isUserOwnedNode(nodeId: string): Promise<boolean> {
    try {
      const row = await this.env.DATABASE.prepare('SELECT node_class FROM nodes WHERE id = ?')
        .bind(nodeId)
        .first<{ node_class: string }>();
      return isUserOwnedNodeClass(row?.node_class);
    } catch (err) {
      log.error('node_lifecycle.node_class_lookup_failed', {
        nodeId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  private getWarmTimeoutMs(): number {
    const envValue = this.env.NODE_WARM_TIMEOUT_MS;
    if (envValue) {
      const parsed = parseInt(envValue, 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return DEFAULT_NODE_WARM_TIMEOUT_MS;
  }

  private getMaxDestroyingAgeMs(): number {
    const parsed = Number.parseInt(this.env.NODE_LIFECYCLE_MAX_DESTROYING_AGE_MS ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0
      ? parsed
      : DEFAULT_NODE_LIFECYCLE_MAX_DESTROYING_AGE_MS;
  }

  private toPublicState(state: StoredState): NodeLifecycleState {
    return {
      nodeId: state.nodeId,
      status: state.status,
      warmSince: state.warmSince ? new Date(state.warmSince).toISOString() : null,
      claimedByTask: state.claimedByTask,
    };
  }

  private async updateD1WarmSince(nodeId: string, value: string | null): Promise<void> {
    try {
      await this.env.DATABASE.prepare(
        `UPDATE nodes SET warm_since = ?, updated_at = ? WHERE id = ?`
      )
        .bind(value, new Date().toISOString(), nodeId)
        .run();
    } catch (err) {
      log.error('node_lifecycle.d1_warm_since_update_failed', {
        nodeId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Get the warm alarm time if the node is in warm state.
   */
  private async getWarmAlarmTime(): Promise<number | null> {
    const state = await this.getStoredState();
    if (!state || state.status !== 'warm' || !state.warmSince) return null;
    const warmTimeout = state.warmTimeoutOverrideMs ?? this.getWarmTimeoutMs();
    return state.warmSince + warmTimeout;
  }

  /**
   * Recalculate and set the alarm to the earliest time needed:
   * either the warm timeout expiry or the earliest pending workspace deletion.
   *
   * @param warmAlarmTime - The warm timeout expiry time, or null if not applicable
   */
  private async recalculateAlarm(warmAlarmTime: number | null): Promise<void> {
    await this.workspaceDeletionQueue().recalculateAlarm(warmAlarmTime);
  }

  private workspaceDeletionQueue(): NodeLifecycleWorkspaceDeletionQueue {
    return new NodeLifecycleWorkspaceDeletionQueue(
      this.env,
      this.ctx.storage,
      () => this.getWarmAlarmTime(),
      async () => (await this.getStoredState())?.nodeId
    );
  }
}
