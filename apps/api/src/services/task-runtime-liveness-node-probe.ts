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
import {
  nodeAgentRequestInit,
  resolveNodeAgentRoute,
  retargetNodeAgentUrl,
} from './node-agent-route';
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

/** Reject with the same message `fetchWithTimeout` uses, so both count as a probe timeout. */
async function withinBudget<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Request timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe a VM node's `/health`. `nodeTransport` comes from the liveness snapshot the caller
 * already loaded (`loadRuntimeWorkspaceSnapshot`), so every transport other than
 * reverse-tunnel makes exactly the one public fetch it always made, with no D1 read. A
 * reverse-tunnel node has no public hostname: its route (the current incarnation's lease) is
 * read inside the same time budget, and any failure there is an inconclusive 'error' or
 * 'timeout', never a terminal verdict.
 */
export async function probeNodeHealthForTaskLiveness(
  env: TaskLivenessNodeHealthProbeEnv,
  nodeId: string,
  nodeTransport?: string | null
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

  const backendEnv = {
    BASE_DOMAIN: env.BASE_DOMAIN,
    VM_AGENT_PROTOCOL: env.VM_AGENT_PROTOCOL,
    VM_AGENT_PORT: env.VM_AGENT_PORT,
  };
  let url = `${getNodeBackendBaseUrl(nodeId, backendEnv)}/health`;
  let init: RequestInit = { method: 'GET' };
  // Existing transports keep the exact budget they always had; only the reverse-tunnel route
  // read spends part of it.
  let fetchTimeoutMs = timeoutMs;

  try {
    if (nodeTransport === 'reverse-tunnel') {
      if (!env.DATABASE) throw new Error('Reverse-tunnel node route needs DATABASE');
      const startedAt = Date.now();
      const route = await withinBudget(
        resolveNodeAgentRoute(
          {
            DATABASE: env.DATABASE,
            REVERSE_TUNNEL_PORT_RANGE_START: env.REVERSE_TUNNEL_PORT_RANGE_START,
            REVERSE_TUNNEL_PORT_RANGE_END: env.REVERSE_TUNNEL_PORT_RANGE_END,
            ...backendEnv,
          },
          nodeId
        ),
        timeoutMs
      );
      url = retargetNodeAgentUrl(url, route);
      init = nodeAgentRequestInit(route, init);
      fetchTimeoutMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
    }
    const response = await fetchWithTimeout(url, init, fetchTimeoutMs);
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
