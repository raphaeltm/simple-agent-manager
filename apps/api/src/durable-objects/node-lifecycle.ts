/**
 * NodeLifecycle Durable Object — per-node warm pool state machine.
 *
 * Manages the lifecycle of auto-provisioned nodes after task completion:
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
 *   scheduleWorkspaceDeletion(workspaceId, userId) → stores pending deletion, recalculates alarm
 *   cancelWorkspaceDeletion(workspaceId) → removes pending deletion, recalculates alarm
 *   alarm() → also processes expired workspace deletions (calls VM agent, updates D1)
 *
 * Actual infrastructure destruction (Hetzner API, DNS) is handled by the
 * cron sweep, NOT by this DO — because user credentials are encrypted in D1
 * and must be decrypted with CREDENTIAL_ENCRYPTION_KEY (or ENCRYPTION_KEY
 * fallback) in the worker context via getCredentialEncryptionKey(env).
 *
 * See: specs/021-task-chat-architecture/tasks.md (Phase 5)
 */
import type { NodeLifecycleState, NodeLifecycleStatus } from '@simple-agent-manager/shared';
import {
  DEFAULT_NODE_LIFECYCLE_ALARM_RETRY_MS,
  DEFAULT_NODE_WARM_TIMEOUT_MS,
  DEFAULT_WORKSPACE_STOPPED_TTL_MS,
} from '@simple-agent-manager/shared';
import { DurableObject } from 'cloudflare:workers';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { deleteWorkspaceOnNode } from '../services/node-agent';

type NodeLifecycleEnv = {
  DATABASE: D1Database;
  NODE_WARM_TIMEOUT_MS?: string;
  WORKSPACE_STOPPED_TTL_MS?: string;
};

interface StoredState {
  nodeId: string;
  userId: string;
  status: NodeLifecycleStatus;
  warmSince: number | null;
  claimedByTask: string | null;
  /** Per-project warm timeout override (ms). Null = use platform default. */
  warmTimeoutOverrideMs?: number | null;
}

interface PendingWorkspaceDeletion {
  workspaceId: string;
  userId: string;
  deleteAt: number;
}

export class NodeLifecycle extends DurableObject<NodeLifecycleEnv> {
  /**
   * Mark a node as idle (warm). Called after the last workspace on the node
   * is destroyed. Schedules an alarm at now + warm_timeout.
   *
   * If already warm, resets the alarm to a new timeout.
   * Throws if the node is currently being destroyed.
   */
  async markIdle(nodeId: string, userId: string, warmTimeoutOverrideMs?: number | null): Promise<NodeLifecycleState> {
    const state = await this.getStoredState();
    const now = Date.now();

    if (state && state.status === 'destroying') {
      throw new Error('node_lifecycle_conflict: node is being destroyed');
    }

    // User-owned (BYO) machines must NEVER enter the warm → destroying teardown pipeline: SAM does
    // not own the hardware and must not schedule its destruction. Keep the node active (no warm
    // alarm) instead. BYO nodes are never auto-provisioned so markIdle should not reach them, but
    // this is the DO chokepoint guard. See architecture-critique #2.
    if (await this.isUserOwnedNode(nodeId)) {
      log.info('node_lifecycle.mark_idle_skipped_user_owned', { nodeId, action: 'kept_active' });
      const activeState: StoredState = {
        nodeId,
        userId,
        status: 'active',
        warmSince: null,
        claimedByTask: null,
        warmTimeoutOverrideMs: null,
      };
      await this.ctx.storage.put('state', activeState);
      // No warm alarm; preserve any pending workspace-deletion alarms.
      await this.recalculateAlarm(null);
      await this.updateD1WarmSince(nodeId, null);
      return this.toPublicState(activeState);
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

    state.status = 'active';
    state.claimedByTask = null;
    state.warmSince = null;
    await this.ctx.storage.put('state', state);

    // Recalculate alarm — pending workspace deletions still need to fire
    await this.recalculateAlarm(null);

    // Clear D1 warm_since
    await this.updateD1WarmSince(state.nodeId, null);

    return this.toPublicState(state);
  }

  /**
   * Try to claim a warm node for a new task. Only succeeds on `warm` nodes.
   *
   * Returns `{ claimed: true, state }` if the node was warm and is now active,
   * or `{ claimed: false, state }` if the node was already active or destroying.
   */
  async tryClaim(taskId: string): Promise<{ claimed: boolean; state: NodeLifecycleState }> {
    const state = await this.getStoredState();
    if (!state) {
      return { claimed: false, state: { nodeId: '', status: 'active', warmSince: null, claimedByTask: null } };
    }

    if (state.status !== 'warm') {
      return { claimed: false, state: this.toPublicState(state) };
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

  // =========================================================================
  // Workspace auto-deletion scheduling
  // =========================================================================

  /**
   * Schedule a stopped workspace for automatic deletion after the configured TTL.
   * Called when a workspace transitions to 'stopped' status.
   */
  async scheduleWorkspaceDeletion(workspaceId: string, userId: string): Promise<void> {
    const ttl = this.getWorkspaceStoppedTtlMs();
    const deleteAt = Date.now() + ttl;

    const entry: PendingWorkspaceDeletion = { workspaceId, userId, deleteAt };
    await this.ctx.storage.put(`ws-delete:${workspaceId}`, entry);

    log.info('node_lifecycle.workspace_deletion_scheduled', {
      workspaceId,
      userId,
      deleteAt: new Date(deleteAt).toISOString(),
      ttlMs: ttl,
    });

    await this.recalculateAlarm(await this.getWarmAlarmTime());
  }

  /**
   * Cancel a pending workspace deletion. Called when a workspace is restarted
   * before the TTL expires.
   */
  async cancelWorkspaceDeletion(workspaceId: string): Promise<void> {
    await this.ctx.storage.delete(`ws-delete:${workspaceId}`);

    log.info('node_lifecycle.workspace_deletion_cancelled', { workspaceId });

    await this.recalculateAlarm(await this.getWarmAlarmTime());
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
    // Process any expired workspace deletions
    await this.processExpiredDeletions();

    const state = await this.getStoredState();
    if (!state) return;

    // No-op if node was claimed (active) or already destroying
    if (state.status === 'active') {
      // Still recalculate alarm for any remaining pending workspace deletions
      await this.recalculateAlarm(null);
      return;
    }

    if (state.status === 'destroying') {
      // Already destroying — retry: schedule another alarm in case destruction
      // hasn't been picked up by cron yet
      await this.ctx.storage.setAlarm(Date.now() + DEFAULT_NODE_LIFECYCLE_ALARM_RETRY_MS);
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

    // Warm timeout expired → transition to destroying
    state.status = 'destroying';
    await this.ctx.storage.put('state', state);

    log.info('node_lifecycle.alarm.warm_to_destroying', {
      nodeId: state.nodeId,
      userId: state.userId,
      warmSince: state.warmSince ? new Date(state.warmSince).toISOString() : null,
    });

    // Mark the node as stopped in D1 so the cron sweep can clean it up
    try {
      await this.env.DATABASE.prepare(
        `UPDATE nodes SET status = 'stopped', warm_since = NULL, health_status = 'stale', updated_at = ? WHERE id = ?`
      )
        .bind(new Date().toISOString(), state.nodeId)
        .run();
    } catch (err) {
      log.error('node_lifecycle.alarm.d1_update_failed', {
        nodeId: state.nodeId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Schedule retry (use recalculateAlarm to not delay pending workspace deletions)
      await this.recalculateAlarm(Date.now() + DEFAULT_NODE_LIFECYCLE_ALARM_RETRY_MS);
    }
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  private async getStoredState(): Promise<StoredState | null> {
    return (await this.ctx.storage.get<StoredState>('state')) ?? null;
  }

  /**
   * True if the node is a user-owned (BYO) machine. On lookup failure returns false (treat as
   * managed) — the common case is a managed node, and the node-cleanup cron guards are the teardown
   * backstop, so failing to "managed" cannot destroy a BYO node.
   */
  private async isUserOwnedNode(nodeId: string): Promise<boolean> {
    try {
      const row = await this.env.DATABASE.prepare('SELECT node_class FROM nodes WHERE id = ?')
        .bind(nodeId)
        .first<{ node_class: string }>();
      return row?.node_class === 'user-owned';
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

  private getWorkspaceStoppedTtlMs(): number {
    const envValue = this.env.WORKSPACE_STOPPED_TTL_MS;
    if (envValue) {
      const parsed = parseInt(envValue, 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return DEFAULT_WORKSPACE_STOPPED_TTL_MS;
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
   * Get all pending workspace deletions from DO storage.
   */
  private async getPendingDeletions(): Promise<Map<string, PendingWorkspaceDeletion>> {
    return await this.ctx.storage.list<PendingWorkspaceDeletion>({ prefix: 'ws-delete:' });
  }

  /**
   * Process all workspace deletions whose deleteAt time has passed.
   */
  private async processExpiredDeletions(): Promise<void> {
    const pending = await this.getPendingDeletions();
    const now = Date.now();

    // Load state once to get nodeId — avoids N storage reads in the loop
    const state = await this.getStoredState();
    if (!state) return;

    for (const [key, entry] of pending) {
      if (entry.deleteAt > now) continue;

      try {
        await this.deleteWorkspace(state.nodeId, entry.workspaceId, entry.userId);
        await this.ctx.storage.delete(key);

        log.info('node_lifecycle.workspace_auto_deleted', {
          workspaceId: entry.workspaceId,
          userId: entry.userId,
        });
      } catch (err) {
        log.error('node_lifecycle.workspace_deletion_failed', {
          workspaceId: entry.workspaceId,
          userId: entry.userId,
          error: err instanceof Error ? err.message : String(err),
        });
        // Leave the entry for retry on next alarm. Push deleteAt forward slightly
        // to avoid tight retry loops.
        entry.deleteAt = now + DEFAULT_NODE_LIFECYCLE_ALARM_RETRY_MS;
        await this.ctx.storage.put(key, entry);
      }
    }
  }

  /**
   * Delete a workspace: call VM agent to remove Docker container + volume,
   * then update D1 status to 'deleted'.
   */
  private async deleteWorkspace(nodeId: string, workspaceId: string, userId: string): Promise<void> {
    // Call VM agent DELETE endpoint via shared helper (handles JWT auth, proper URL routing)
    try {
      await deleteWorkspaceOnNode(nodeId, workspaceId, this.env as unknown as Env, userId);
    } catch (err) {
      // If the node is unreachable (already destroyed), log but don't fail
      // The D1 status update below still marks the workspace as deleted
      log.warn('node_lifecycle.workspace_delete_vm_agent_failed', {
        workspaceId,
        nodeId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Update D1 workspace status to 'deleted'
    const now = new Date().toISOString();
    await this.env.DATABASE.prepare(
      `UPDATE workspaces SET status = 'deleted', updated_at = ? WHERE id = ? AND status = 'stopped'`
    ).bind(now, workspaceId).run();

    // Clean up any agent_sessions referencing this workspace (best-effort)
    try {
      await this.env.DATABASE.prepare(
        `UPDATE agent_sessions SET status = 'completed', updated_at = ? WHERE workspace_id = ? AND status NOT IN ('completed', 'failed')`
      ).bind(now, workspaceId).run();
    } catch {
      // best-effort
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
    let earliest = warmAlarmTime;

    const pending = await this.getPendingDeletions();
    for (const [, entry] of pending) {
      if (earliest === null || entry.deleteAt < earliest) {
        earliest = entry.deleteAt;
      }
    }

    if (earliest !== null) {
      await this.ctx.storage.setAlarm(earliest);
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }
}
