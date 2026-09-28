/**
 * Resolving the runtime a durable prompt delivery targets, waking a sleeping
 * session when it has to. Split out of `vm-prompt-delivery-adapter.ts`
 * (`.claude/rules/18-file-size-limits.md`), which re-exports these types.
 */
import type { PromptDeliveryResult } from '../durable-objects/project-data/prompt-delivery';
import { IN_PLACE_WAKEABLE_STATUSES } from '../durable-objects/vm-agent-container-recovery';
import type { Env } from '../env';
import {
  ensureSessionRecovery,
  reportSessionRecoveryRefusal,
  type SessionRecoveryResult,
} from './session-recovery';
import type { ProjectEventWakeRecoveryGuard } from './session-recovery-authority';
import { classifySessionRecoveryRefusal } from './session-recovery-refusals';

export interface VmPromptDeliveryTarget {
  projectId: string;
  chatSessionId: string;
  workspaceId: string;
  nodeId: string;
  agentSessionId: string;
  userId: string;
  runtimeIdentity: string;
  runtime: string;
}

export interface VmPromptDeliverySourceTaskGuard {
  taskId: string;
  projectId: string;
  chatSessionId: string;
  projectEventWake?: ProjectEventWakeRecoveryGuard | null;
  requiredProjectMemberId?: string | null;
}

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
  node_id: string | null;
  node_status: string | null;
  node_health_status: string | null;
  agent_version: string | null;
  node_runtime: string | null;
  agent_session_id: string | null;
  agent_session_status: string | null;
  agent_session_updated_at: string | null;
  snapshot_sleep_status: string | null;
  snapshot_runtime: string | null;
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

function isSleepingContainer(runtime: string | null, sleepStatus: string | null): boolean {
  return runtime === 'cf-container' && sleepStatus === 'sleeping';
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

export async function resolveVmPromptDeliveryTarget(
  env: Env,
  projectId: string,
  chatSessionId: string,
  sourceTaskGuard: VmPromptDeliverySourceTaskGuard | undefined,
  runSideEffectGuard: () => Promise<PromptDeliveryResult | null>
): Promise<TargetResolution> {
  const row = await env.DATABASE.prepare(
    `SELECT w.id AS workspace_id,
            w.user_id AS user_id,
            w.status AS workspace_status,
            w.runtime_deletion_confirmed_at AS workspace_deletion_confirmed_at,
            w.node_id AS node_id,
            n.status AS node_status,
            n.health_status AS node_health_status,
            n.agent_version AS agent_version,
            n.runtime AS node_runtime,
            a.id AS agent_session_id,
            a.status AS agent_session_status,
            a.updated_at AS agent_session_updated_at,
            s.sleep_status AS snapshot_sleep_status,
            s.runtime AS snapshot_runtime
     FROM workspaces w
     LEFT JOIN nodes n ON n.id = w.node_id
     LEFT JOIN agent_sessions a ON a.workspace_id = w.id
     LEFT JOIN session_snapshots s ON s.chat_session_id = w.chat_session_id
     WHERE w.project_id = ? AND w.chat_session_id = ?
     ORDER BY w.updated_at DESC, a.created_at DESC
     LIMIT 1`
  )
    .bind(projectId, chatSessionId)
    .first<DeliveryTargetRow>();

  if (!row) {
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
    const guarded = await runSideEffectGuard();
    if (guarded) return { kind: 'guarded', result: guarded };
    const recovery = await ensureSessionRecovery(env, projectId, chatSessionId, sourceTaskGuard);
    return recoveryResolution(recovery, `Target workspace is ${row.workspace_status}`);
  }
  if (isSleepingContainer(row.snapshot_runtime ?? row.node_runtime, row.snapshot_sleep_status)) {
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

  return readyTarget(projectId, chatSessionId, row, row.node_id, row.agent_session_id);
}
