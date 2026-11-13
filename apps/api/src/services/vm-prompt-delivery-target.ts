/**
 * Resolving the runtime a durable prompt delivery targets, waking a sleeping
 * session when it has to. Split out of `vm-prompt-delivery-adapter.ts`
 * (`.claude/rules/18-file-size-limits.md`), which re-exports these types.
 */
import type {
  VmPromptDeliverySourceTaskGuard,
  VmPromptDeliveryTarget,
} from '@simple-agent-manager/project-data';

import type { PromptDeliveryResult } from '../durable-objects/project-data/prompt-delivery';
import { IN_PLACE_WAKEABLE_STATUSES } from '../durable-objects/vm-agent-container-recovery';
import type { Env } from '../env';
import {
  ensureSessionRecovery,
  reportSessionRecoveryRefusal,
  type SessionRecoveryResult,
} from './session-recovery';
import { classifySessionRecoveryRefusal } from './session-recovery-refusals';
import { sessionSleepClaimLeaseMs } from './session-snapshot-sleep-claim';
import { signalSessionWakeReadyBestEffort } from './session-wake-ready';
import {
  isSessionHistoricalWakeReceiptCurrent,
  isSessionWakeReadyCurrent,
} from './session-wake-ready-authority';

/** ProjectData owns the delivery contract these describe; re-exported for worker callers. */
export type { VmPromptDeliverySourceTaskGuard, VmPromptDeliveryTarget };

export type TargetResolution =
  | { kind: 'ready'; target: VmPromptDeliveryTarget }
  | { kind: 'retry'; reason: string }
  | { kind: 'failed'; reason: 'terminal_target' | 'dead_target' | 'wake_refused'; error: string }
  | { kind: 'guarded'; result: PromptDeliveryResult };

/**
 * A wake in progress, or a refusal that usually clears on its own (a replaced
 * workspace whose deletion still awaits its proof: typically the first minutes
 * after a sleep, exactly when a user replies), is retried until the delivery's
 * TTL; a retry does not spend a delivery attempt. Other refusals end it now.
 */
function recoveryResolution(
  recovery: SessionRecoveryResult,
  terminalError: string
): TargetResolution {
  if (recovery.status === 'waking') {
    return { kind: 'retry', reason: `Session is waking (${recovery.taskId})` };
  }
  const refusal = classifySessionRecoveryRefusal(recovery.reason);
  if (refusal.action === 'retry') {
    return { kind: 'retry', reason: `Session cannot wake yet (${recovery.reason})` };
  }
  if (refusal.action === 'drop') {
    return {
      kind: 'failed',
      reason: 'terminal_target',
      error: `${terminalError} (${recovery.reason})`,
    };
  }
  return {
    kind: 'failed',
    reason: 'wake_refused',
    error: `${refusal.description} (${recovery.reason})`,
  };
}

interface DeliveryTargetRow {
  workspace_id: string;
  user_id: string;
  workspace_status: string;
  workspace_deletion_confirmed_at: string | null;
  workspace_callback_generation: string | null;
  node_id: string | null;
  node_status: string | null;
  node_health_status: string | null;
  agent_version: string | null;
  node_runtime: string | null;
  agent_session_id: string | null;
  agent_session_status: string | null;
  agent_session_updated_at: string | null;
  snapshot_sleep_status: string | null;
  snapshot_sleep_claimed_at: string | null;
  snapshot_runtime: string | null;
  snapshot_recovery_status: string | null;
  snapshot_recovery_task_id: string | null;
  snapshot_recovery_workspace_id: string | null;
  snapshot_recovery_attempt_id: string | null;
  wake_task_status: string | null;
}

/** Statuses a live delivery target cannot come back from. */
const TERMINAL_WORKSPACE_STATUSES = ['stopping', 'stopped', 'evicted', 'deleted', 'error'];
const TERMINAL_NODE_STATUSES = ['stopping', 'stopped', 'deleted', 'error'];
const TERMINAL_AGENT_SESSION_STATUSES = ['completed', 'failed', 'error', 'stopped'];

/**
 * The workspace and node statuses a sleeping container can still wake from: the
 * container DO's own set, less `error` (see `resolveSleepingContainerTarget`).
 */
const SLEEPING_CONTAINER_WAKEABLE_STATUSES = IN_PLACE_WAKEABLE_STATUSES.filter(
  (status) => status !== 'error'
);

/**
 * Whether the session slept as an Instant runtime, read from its snapshot: the marker that says
 * "wake this in place". A signal-only caller asks something else (would a request start a wake?)
 * and reads the node instead (`services/sleeping-container-runtime.ts`), which the wake clears first.
 */
function isSleepingContainer(runtime: string | null, sleepStatus: string | null): boolean {
  return runtime === 'cf-container' && sleepStatus === 'sleeping';
}

/** Statuses a VM wake's task holds until `transitionToInProgress` commits its handoff. */
const UNCOMMITTED_WAKE_TASK_STATUSES: ReadonlySet<string> = new Set(['queued', 'delegated']);

/**
 * Whether this VM workspace belongs to a TaskRunner wake that has not committed its
 * agent handoff. The commit (`transitionToInProgress`) is what releases queued prompts:
 * it signals readiness (`notifyWakeSettled` -> `signalSessionWakeReady`, validated by
 * `isSessionWakeReadyCurrent`). Before it, the replacement agent session already reads
 * `running` (`ensureAgentSessionRow` runs first), so the target looks ready while the
 * runner still re-checks its authority. Delivering then is unsafe: an accepted event-wake
 * prompt flips its batch to `delivered`, `validateProjectEventWakeRecoveryAuthority` reads
 * that as revocation, and the runner kills the runtime mid-prompt (production,
 * 2026-10-09). The hold covers every durable delivery, so no queued prompt enters a
 * runtime whose handoff can still be refused. The woken agent can also consume its batch
 * by reading or acking it, which nothing can hold; the runner's re-check accepts that
 * (`acceptConsumedByTarget`). The direct senders that bypass durable delivery are
 * enumerated in `tasks/archive/2026-10-10-vm-wake-event-delivery-revokes-handoff.md`.
 *
 * This mirrors the claim the runner holds: `waking` from `claimSessionSnapshotRecovery`,
 * then `restored` for this workspace once `completeSessionSnapshotRecovery` runs, while
 * the claiming task is still queued or delegated. `isSessionRecoveryTaskAuthorized` reads
 * the same claim to answer a different question (may the runner still act?), so the two
 * are not shared; a change to the commit boundary must update both.
 *
 * VM only: Instant wakes in place without a TaskRunner, and
 * `markSessionSnapshotAwakeInPlace` writes `restored` on every delivery attempt.
 */
function isVmWakeHandoffPending(row: DeliveryTargetRow): boolean {
  if (row.node_runtime !== 'vm') return false;
  if (!UNCOMMITTED_WAKE_TASK_STATUSES.has(row.wake_task_status ?? '')) return false;
  return (
    row.snapshot_recovery_status === 'waking' ||
    (row.snapshot_recovery_status === 'restored' &&
      row.snapshot_recovery_workspace_id === row.workspace_id)
  );
}

/**
 * A sleep owns this session: `preparing` inside its claim lease, or `stopping` (teardown, which
 * rolls forward and never back to a deliverable chat). A required sleep cancels the turn first and
 * the VM restarts the agent idle, so a prompt delivered now starts a new turn that aborts the sleep
 * and runs work nobody asked for (production 2026-11-04, idea 01M6K6QTEE7T9KNYB7317D7Y8E). Held
 * deliveries wake the session through the normal recovery path once it is `sleeping`. A
 * `preparing` claim past its lease is abandoned and no longer holds anything. `stopping` has no
 * lease of its own: it converges to `sleeping` or `terminal_failed`
 * (`session-sleep-stopping-failure.ts`), and each delivery's own TTL bounds the wait.
 */
function isSleepClaimHoldingDelivery(env: Env, row: DeliveryTargetRow, now = Date.now()): boolean {
  if (row.snapshot_sleep_status === 'stopping') return true;
  if (row.snapshot_sleep_status !== 'preparing') return false;
  const claimedAt = Date.parse(row.snapshot_sleep_claimed_at ?? '');
  return Number.isFinite(claimedAt) && claimedAt + sessionSleepClaimLeaseMs(env) > now;
}

function readyTarget(
  projectId: string,
  chatSessionId: string,
  row: DeliveryTargetRow,
  nodeId: string,
  agentSessionId: string
): TargetResolution {
  return {
    kind: 'ready',
    target: {
      projectId,
      chatSessionId,
      workspaceId: row.workspace_id,
      nodeId,
      agentSessionId,
      userId: row.user_id,
      runtimeIdentity: [
        nodeId,
        agentSessionId,
        row.agent_version ?? 'legacy',
        row.agent_session_updated_at ?? 'unknown',
      ].join(':'),
      runtime: row.node_runtime ?? row.snapshot_runtime ?? 'vm',
    },
  };
}

async function reportUnavailableContainer(
  env: Env,
  chatSessionId: string,
  detail: string,
  runSideEffectGuard: () => Promise<PromptDeliveryResult | null>
): Promise<TargetResolution> {
  const guarded = await runSideEffectGuard();
  if (guarded) return { kind: 'guarded', result: guarded };
  const refusal = await reportSessionRecoveryRefusal(
    env,
    chatSessionId,
    'container_runtime_unavailable',
    detail
  );
  return recoveryResolution(refusal, detail);
}

/**
 * A sleeping Instant runtime wakes in place: the capability probe reaches its
 * container Durable Object, whose `ensureAwake` restores the snapshot. So refuse
 * exactly what that resumer would refuse. Its precondition (`loadRuntimeRecoveryContext`,
 * `durable-objects/vm-agent-container-recovery.ts`) wants both rows present, their
 * status in `IN_PLACE_WAKEABLE_STATUSES`, a `cf-container` node and no confirmed
 * deletion. It never reads `nodes.health_status` or the agent session's status: the
 * sleep writers and the wake itself mark a perfectly wakeable runtime `unhealthy` and
 * `sleeping`/`recovery` (`.claude/rules/58`).
 *
 * Deliberately stricter than the resumer: it would accept `error` rows and any agent
 * session. A sleeping runtime reaches those terminal states only through an exhausted
 * wake (`persistRuntimeRecoveryFailed`) or an explicit stop, and after either the
 * container DO refuses to restart — so reporting now beats retrying until the delivery
 * expires.
 */
async function resolveSleepingContainerTarget(
  env: Env,
  projectId: string,
  chatSessionId: string,
  row: DeliveryTargetRow,
  runSideEffectGuard: () => Promise<PromptDeliveryResult | null>
): Promise<TargetResolution> {
  const unavailable = (detail: string) =>
    reportUnavailableContainer(env, chatSessionId, detail, runSideEffectGuard);
  if (!SLEEPING_CONTAINER_WAKEABLE_STATUSES.includes(row.workspace_status)) {
    return unavailable(`Sleeping container workspace is ${row.workspace_status}`);
  }
  if (row.workspace_deletion_confirmed_at) {
    return unavailable('Sleeping container workspace deletion is confirmed');
  }
  if (!row.node_id) return unavailable('Sleeping container has no assigned node');
  if (
    row.node_runtime !== 'cf-container' ||
    !SLEEPING_CONTAINER_WAKEABLE_STATUSES.includes(row.node_status ?? '')
  ) {
    return unavailable('Sleeping container node is unavailable');
  }
  if (!row.agent_session_id) return unavailable('Sleeping container has no agent session');
  if (TERMINAL_AGENT_SESSION_STATUSES.includes(row.agent_session_status ?? '')) {
    return unavailable(`Sleeping container agent session is ${row.agent_session_status}`);
  }
  return readyTarget(projectId, chatSessionId, row, row.node_id, row.agent_session_id);
}

/** A steer reports this instead of starting a wake; nothing it carries may restart a runtime. */
export const SESSION_NOT_AWAKE_REASON = 'session_not_awake';

export interface ResolveTargetOptions {
  /**
   * False for live steering: a sleeping or missing runtime has no running turn to
   * steer, so the resolver reports it instead of starting a recovery or container wake.
   */
  allowWake?: boolean;
}

export async function resolveVmPromptDeliveryTarget(
  env: Env,
  projectId: string,
  chatSessionId: string,
  sourceTaskGuard: VmPromptDeliverySourceTaskGuard | undefined,
  runSideEffectGuard: () => Promise<PromptDeliveryResult | null>,
  options: ResolveTargetOptions = {}
): Promise<TargetResolution> {
  const allowWake = options.allowWake ?? true;
  const notAwake: TargetResolution = { kind: 'retry', reason: SESSION_NOT_AWAKE_REASON };
  const row = await env.DATABASE.prepare(
    `SELECT w.id AS workspace_id,
            w.user_id AS user_id,
            w.status AS workspace_status,
            w.runtime_deletion_confirmed_at AS workspace_deletion_confirmed_at,
            w.callback_generation AS workspace_callback_generation,
            w.node_id AS node_id,
            n.status AS node_status,
            n.health_status AS node_health_status,
            n.agent_version AS agent_version,
            n.runtime AS node_runtime,
            a.id AS agent_session_id,
            a.status AS agent_session_status,
            a.updated_at AS agent_session_updated_at,
            s.sleep_status AS snapshot_sleep_status,
            s.sleep_claimed_at AS snapshot_sleep_claimed_at,
            s.runtime AS snapshot_runtime,
            s.recovery_status AS snapshot_recovery_status,
            s.recovery_task_id AS snapshot_recovery_task_id,
            s.recovery_workspace_id AS snapshot_recovery_workspace_id,
            s.recovery_attempt_id AS snapshot_recovery_attempt_id,
            wake.status AS wake_task_status
     FROM workspaces w
     LEFT JOIN nodes n ON n.id = w.node_id
     LEFT JOIN agent_sessions a ON a.workspace_id = w.id AND a.user_id = w.user_id
     LEFT JOIN session_snapshots s ON s.chat_session_id = w.chat_session_id
     LEFT JOIN tasks wake ON wake.id = s.recovery_task_id AND wake.project_id = w.project_id
     WHERE w.project_id = ? AND w.chat_session_id = ?
     ORDER BY w.updated_at DESC,
       CASE WHEN s.recovery_status = 'restored' AND s.recovery_workspace_id = w.id
         AND wake.status IN ('in_progress', 'awaiting_followup')
         AND a.status = 'running' THEN 0 ELSE 1 END,
       a.created_at DESC
     LIMIT 1`
  )
    .bind(projectId, chatSessionId)
    .first<DeliveryTargetRow>();

  if (!row) {
    if (!allowWake) return notAwake;
    const snapshot = await env.DATABASE.prepare(
      `SELECT runtime, sleep_status FROM session_snapshots WHERE chat_session_id = ? LIMIT 1`
    )
      .bind(chatSessionId)
      .first<{ runtime: string | null; sleep_status: string | null }>();
    if (snapshot && isSleepingContainer(snapshot.runtime, snapshot.sleep_status)) {
      return reportUnavailableContainer(
        env,
        chatSessionId,
        'Sleeping container workspace no longer exists',
        runSideEffectGuard
      );
    }
    const guarded = await runSideEffectGuard();
    if (guarded) return { kind: 'guarded', result: guarded };
    const recovery = await ensureSessionRecovery(env, projectId, chatSessionId, sourceTaskGuard);
    return recoveryResolution(recovery, 'Target workspace no longer exists');
  }
  if (
    (row.snapshot_runtime ?? row.node_runtime) !== 'cf-container' &&
    ['sleeping', 'stopping', 'stopped', 'deleted', 'error'].includes(row.workspace_status)
  ) {
    if (!allowWake) return notAwake;
    const guarded = await runSideEffectGuard();
    if (guarded) return { kind: 'guarded', result: guarded };
    const recovery = await ensureSessionRecovery(env, projectId, chatSessionId, sourceTaskGuard);
    return recoveryResolution(recovery, `Target workspace is ${row.workspace_status}`);
  }
  if (isSleepingContainer(row.snapshot_runtime ?? row.node_runtime, row.snapshot_sleep_status)) {
    if (!allowWake) return notAwake;
    return resolveSleepingContainerTarget(env, projectId, chatSessionId, row, runSideEffectGuard);
  }
  if (TERMINAL_WORKSPACE_STATUSES.includes(row.workspace_status)) {
    return {
      kind: 'failed',
      reason: 'terminal_target',
      error: `Target workspace is ${row.workspace_status}`,
    };
  }
  if (!row.node_id) {
    return { kind: 'retry', reason: 'Target workspace has no assigned node yet' };
  }
  if (
    TERMINAL_NODE_STATUSES.includes(row.node_status ?? '') ||
    row.node_health_status === 'unhealthy'
  ) {
    return {
      kind: 'failed',
      reason: 'dead_target',
      error: 'Target node is unavailable',
    };
  }
  const wakeableStatuses = ['running', 'recovery', 'sleeping'];
  if (
    !wakeableStatuses.includes(row.workspace_status) ||
    !wakeableStatuses.includes(row.node_status ?? '')
  ) {
    return {
      kind: 'retry',
      reason: `Target runtime is not ready (${row.workspace_status}/${row.node_status ?? 'unknown'})`,
    };
  }
  if (!row.agent_session_id) {
    return { kind: 'retry', reason: 'Target agent session has not started yet' };
  }
  if (row.agent_session_status !== 'running') {
    if (TERMINAL_AGENT_SESSION_STATUSES.includes(row.agent_session_status ?? '')) {
      return {
        kind: 'failed',
        reason: 'terminal_target',
        error: `Target agent session is ${row.agent_session_status}`,
      };
    }
    return { kind: 'retry', reason: `Target agent session is ${row.agent_session_status}` };
  }
  if (isSleepClaimHoldingDelivery(env, row)) {
    // A retry cannot exhaust the delivery attempt budget (`applyPromptDeliveryResult`); TTL bounds it.
    return { kind: 'retry', reason: `Session is going to sleep (${row.snapshot_sleep_status})` };
  }
  if (isVmWakeHandoffPending(row)) {
    // A not_ready retry cannot exhaust the delivery attempt budget (`applyPromptDeliveryResult`
    // caps it below the maximum); the committed wake's readiness signal makes it due.
    return {
      kind: 'retry',
      reason: `Session is waking (${row.snapshot_recovery_task_id}); agent handoff not committed`,
    };
  }

  if (
    row.node_runtime === 'vm' &&
    row.snapshot_recovery_status === 'restored' &&
    row.snapshot_recovery_task_id &&
    row.snapshot_recovery_attempt_id
  ) {
    const expectedRuntime = {
      nodeId: row.node_id,
      workspaceCallbackGeneration: row.workspace_callback_generation,
    };
    const readiness = {
      projectId,
      chatSessionId,
      workspaceId: row.workspace_id,
      agentSessionId: row.agent_session_id,
      expectedRuntime,
      fence: {
        runtime: 'vm' as const,
        taskId: row.snapshot_recovery_task_id,
        recoveryAttemptId: row.snapshot_recovery_attempt_id,
      },
    };
    // Preflight before any activation: a replaced runtime cannot nudge an old captured target.
    if (!(await isSessionWakeReadyCurrent(env, readiness))) {
      if (!(await isSessionHistoricalWakeReceiptCurrent(env, readiness, expectedRuntime)))
        return {
          kind: 'retry',
          reason: allowWake
            ? 'Committed wake activation is pending'
            : 'Committed wake authority is no longer current',
        };
      return readyTarget(projectId, chatSessionId, row, row.node_id, row.agent_session_id);
    }
    // Steering and receipt probes never activate a chat, nudge its inbox or re-arm its alarm.
    if (!allowWake)
      return readyTarget(projectId, chatSessionId, row, row.node_id, row.agent_session_id);
    const guarded = await runSideEffectGuard();
    if (guarded) return { kind: 'guarded', result: guarded };
    // The durable inbox retry also repairs a lost activation signal without a browser
    // or a second human prompt. The DO validates the exact committed fence again.
    if (
      !(await signalSessionWakeReadyBestEffort(env, readiness)) ||
      !(await isSessionWakeReadyCurrent(env, readiness))
    )
      return { kind: 'retry', reason: 'Committed wake activation is pending' };
  }

  return readyTarget(projectId, chatSessionId, row, row.node_id, row.agent_session_id);
}
