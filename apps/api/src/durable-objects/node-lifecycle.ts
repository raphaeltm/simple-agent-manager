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
 * Actual infrastructure destruction (Hetzner API, DNS) is handled by the
 * cron sweep, NOT by this DO — because user credentials are encrypted in D1
 * and must be decrypted with ENCRYPTION_KEY in the worker context.
 *
 * See: specs/021-task-chat-architecture/tasks.md (Phase 5)
 */
import { DurableObject } from 'cloudflare:workers';
import {
  DEFAULT_NODE_WARM_TIMEOUT_MS,
  DEFAULT_NODE_LIFECYCLE_ALARM_RETRY_MS,
} from '@simple-agent-manager/shared';
import type { NodeLifecycleStatus, NodeLifecycleState } from '@simple-agent-manager/shared';

type NodeLifecycleEnv = {
  DATABASE: D1Database;
  NODE_WARM_TIMEOUT_MS?: string;
};

interface StoredState {
  nodeId: string;
  userId: string;
  status: NodeLifecycleStatus;
  warmSince: number | null;
  claimedByTask: string | null;
}

export class NodeLifecycle extends DurableObject<NodeLifecycleEnv> {
  /**
   * Mark a node as idle (warm). Called after the last workspace on the node
   * is destroyed. Schedules an alarm at now + warm_timeout.
   *
   * If already warm, resets the alarm to a new timeout.
   * Throws if the node is currently being destroyed.
   */
  async markIdle(nodeId: string, userId: string): Promise<NodeLifecycleState> {
    const state = await this.getStoredState();
    const now = Date.now();

    if (state && state.status === 'destroying') {
      throw new Error('node_lifecycle_conflict: node is being destroyed');
    }

    const warmTimeout = this.getWarmTimeoutMs();

    const newState: StoredState = {
      nodeId,
      userId,
      status: 'warm',
      warmSince: now,
      claimedByTask: null,
    };
    await this.ctx.storage.put('state', newState);

    // Schedule (or reschedule) alarm
    await this.ctx.storage.setAlarm(now + warmTimeout);

    // Update D1 warm_since column
    await this.updateD1WarmSince(nodeId, new Date(now).toISOString());

    return this.toPublicState(newState);
  }

  /**
   * Mark a node as active. Called when a workspace starts on the node.
   * Cancels any pending warm timeout alarm.
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

    // Cancel any pending alarm
    await this.ctx.storage.deleteAlarm();

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

    // Cancel alarm
    await this.ctx.storage.deleteAlarm();

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

  /**
   * Alarm handler. Fires when the warm timeout expires.
   *
   * If the node is still warm, transitions to `destroying` and marks D1
   * for the cron sweep to handle actual infrastructure teardown.
   * If the node was claimed between schedule and fire, this is a no-op.
   */
  async alarm(): Promise<void> {
    const state = await this.getStoredState();
    if (!state) return;

    // No-op if node was claimed (active) or already destroying
    if (state.status === 'active') {
      return;
    }

    if (state.status === 'destroying') {
      // Already destroying — retry: schedule another alarm in case destruction
      // hasn't been picked up by cron yet
      await this.ctx.storage.setAlarm(Date.now() + DEFAULT_NODE_LIFECYCLE_ALARM_RETRY_MS);
      return;
    }

    // status === 'warm' → transition to destroying
    state.status = 'destroying';
    await this.ctx.storage.put('state', state);

    // Mark the node as stopped in D1 so the cron sweep can clean it up
    try {
      await this.env.DATABASE.prepare(
        `UPDATE nodes SET status = 'stopped', warm_since = NULL, health_status = 'stale', updated_at = ? WHERE id = ?`
      )
        .bind(new Date().toISOString(), state.nodeId)
        .run();
    } catch (err) {
      console.error('NodeLifecycle alarm: failed to update D1', err);
      // Schedule retry
      await this.ctx.storage.setAlarm(Date.now() + DEFAULT_NODE_LIFECYCLE_ALARM_RETRY_MS);
    }
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  private async getStoredState(): Promise<StoredState | null> {
    return (await this.ctx.storage.get<StoredState>('state')) ?? null;
  }

  private getWarmTimeoutMs(): number {
    const envValue = this.env.NODE_WARM_TIMEOUT_MS;
    if (envValue) {
      const parsed = parseInt(envValue, 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return DEFAULT_NODE_WARM_TIMEOUT_MS;
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
      console.error('NodeLifecycle: failed to update D1 warm_since', err);
    }
  }
}
