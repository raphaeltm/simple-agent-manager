/**
 * Bounded node-health authority probe used when a VM node's D1 heartbeat mirror is
 * stale. Shared by both liveness adapters (`.claude/rules/61`).
 *
 * Split out of `task-runtime-liveness.ts` to keep that module under the 500-line
 * ceiling (`.claude/rules/18`). Re-exported from `task-runtime-liveness.ts` so
 * existing imports are unchanged.
 */
import { DEFAULT_TASK_LIVENESS_NODE_HEALTH_PROBE_TIMEOUT_MS } from '@simple-agent-manager/shared';

import { fetchWithTimeout, getTimeoutMs } from './fetch-timeout';
import { getNodeBackendBaseUrl } from './node-agent-readiness';
import type {
  RuntimeWorkspaceSnapshot,
  TaskLivenessNodeHealthProbeEnv,
  TaskLivenessNodeHealthProbeResult,
  TaskRuntimeLivenessSignals,
} from './task-runtime-liveness-types';

export const TERMINAL_NODE_STATUSES = new Set([
  'stopped',
  'deleted',
  'destroyed',
  'destroying',
  'error',
]);

export function getTaskLivenessNodeHealthProbeTimeoutMs(
  env: Pick<TaskLivenessNodeHealthProbeEnv, 'TASK_LIVENESS_NODE_HEALTH_PROBE_TIMEOUT_MS'>
): number {
  return getTimeoutMs(
    env.TASK_LIVENESS_NODE_HEALTH_PROBE_TIMEOUT_MS,
    DEFAULT_TASK_LIVENESS_NODE_HEALTH_PROBE_TIMEOUT_MS
  );
}

export function isVmNodeHeartbeatStale(
  workspace: RuntimeWorkspaceSnapshot,
  nowMs: number,
  heartbeatStaleMs: number
): boolean {
  return (
    workspace.nodeHealthStatus !== 'healthy' ||
    workspace.nodeHeartbeatAt === null ||
    nowMs - workspace.nodeHeartbeatAt > heartbeatStaleMs
  );
}

/**
 * A stale D1 heartbeat/health field is a weak self-signal, not proof of VM
 * death. Both liveness adapters make the same bounded authority probe, but a
 * failed request still cannot manufacture terminal ownership evidence
 * (`.claude/rules/61`).
 */
export function needsNodeHealthProbe(signals: TaskRuntimeLivenessSignals): boolean {
  const workspace = signals.workspace;
  if (signals.workspaceProbeOutcome !== 'ok') return false;
  if (!signals.taskWorkspaceId || !workspace) return false;
  if (workspace.status !== 'running') return false;
  if (workspace.nodeRuntime === 'cf-container') return false;
  if (!workspace.nodeId) return false;
  if (workspace.nodeStatus && TERMINAL_NODE_STATUSES.has(workspace.nodeStatus)) return false;
  if (signals.nodeHealthProbeOutcome !== 'not_run') return false;
  return isVmNodeHeartbeatStale(workspace, signals.nowMs, signals.heartbeatStaleMs);
}

function isNodeHealthProbeTimeout(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'AbortError' || err.message.startsWith('Request timed out after ');
}

export async function probeNodeHealthForTaskLiveness(
  env: TaskLivenessNodeHealthProbeEnv,
  nodeId: string
): Promise<TaskLivenessNodeHealthProbeResult> {
  const timeoutMs = getTaskLivenessNodeHealthProbeTimeoutMs(env);
  if (!env.BASE_DOMAIN) {
    return {
      outcome: 'error',
      timeoutMs,
      url: null,
      status: null,
      error: 'BASE_DOMAIN is not configured',
    };
  }

  const url = `${getNodeBackendBaseUrl(nodeId, {
    BASE_DOMAIN: env.BASE_DOMAIN,
    VM_AGENT_PROTOCOL: env.VM_AGENT_PROTOCOL,
    VM_AGENT_PORT: env.VM_AGENT_PORT,
  })}/health`;

  try {
    const response = await fetchWithTimeout(url, { method: 'GET' }, timeoutMs);
    return {
      outcome: response.ok ? 'ok' : 'failed',
      timeoutMs,
      url,
      status: response.status,
      error: null,
    };
  } catch (err) {
    return {
      outcome: isNodeHealthProbeTimeout(err) ? 'timeout' : 'error',
      timeoutMs,
      url,
      status: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
