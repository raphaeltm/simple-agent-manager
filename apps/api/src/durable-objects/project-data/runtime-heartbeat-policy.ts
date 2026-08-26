import { DEFAULT_TASK_LIVENESS_PROBE_TIMEOUT_MS } from '@simple-agent-manager/shared';

import type { VmAgentContainer } from '../vm-agent-container';
import { isVmAgentContainerLifecycleTerminal } from '../vm-agent-container-lifecycle';
import { checkHeartbeatTimeouts } from './acp-sessions';
import type { Env } from './types';

interface HeartbeatTimeoutCandidate {
  workspaceId: string | null;
  nodeId: string | null;
}

const TERMINAL_WORKSPACE_STATUSES = new Set(['stopping', 'stopped', 'error', 'deleted']);

export function checkRuntimeHeartbeatTimeouts(
  sql: SqlStorage,
  env: Env,
  transitionFn: Parameters<typeof checkHeartbeatTimeouts>[2],
  projectId: string | null
) {
  return checkHeartbeatTimeouts(sql, env, transitionFn, {
    shouldDeferTimeout: (session) => shouldDeferRuntimeHeartbeatTimeout(env, session, projectId),
  });
}

function probeTimeoutMs(env: Env): number {
  const configured = Number.parseInt(env.TASK_LIVENESS_PROBE_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_TASK_LIVENESS_PROBE_TIMEOUT_MS;
}

export async function shouldDeferRuntimeHeartbeatTimeout(
  env: Env,
  candidate: HeartbeatTimeoutCandidate,
  projectId: string | null
): Promise<{ defer: boolean; reason: string }> {
  if (!candidate.workspaceId || !candidate.nodeId) {
    return { defer: false, reason: 'runtime_identity_incomplete' };
  }
  if (!projectId) {
    return { defer: true, reason: 'project_identity_unavailable' };
  }

  const row = await env.DATABASE.prepare(
    `SELECT w.status AS workspace_status, n.runtime AS node_runtime
     FROM workspaces w
     LEFT JOIN nodes n ON n.id = w.node_id
     WHERE w.project_id = ? AND w.id = ? AND w.node_id = ?
     LIMIT 1`
  )
    .bind(projectId, candidate.workspaceId, candidate.nodeId)
    .first<{ workspace_status: string; node_runtime: string | null }>();
  if (!row) {
    return { defer: false, reason: 'workspace_missing' };
  }
  if (TERMINAL_WORKSPACE_STATUSES.has(row.workspace_status)) {
    return { defer: false, reason: `workspace_${row.workspace_status}` };
  }
  if (row.node_runtime !== 'cf-container') {
    return { defer: true, reason: 'vm_runtime_projectdata_heartbeat_suspect' };
  }
  if (!env.VM_AGENT_CONTAINER) {
    return { defer: true, reason: 'cf_container_lifecycle_binding_unavailable' };
  }

  const id = env.VM_AGENT_CONTAINER.idFromName(candidate.nodeId.toLowerCase());
  const stub = env.VM_AGENT_CONTAINER.get(id) as DurableObjectStub<VmAgentContainer>;
  const timeoutMs = probeTimeoutMs(env);
  const timeout = Symbol('container_lifecycle_probe_timeout');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const lifecycle = await Promise.race([
    stub.inspectLifecycle(),
    new Promise<typeof timeout>((resolve) => {
      timer = setTimeout(() => resolve(timeout), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
  if (lifecycle === timeout) {
    return { defer: true, reason: 'cf_container_lifecycle_timeout' };
  }
  return {
    defer: !isVmAgentContainerLifecycleTerminal(lifecycle.status),
    reason: `cf_container_${lifecycle.status ?? 'unknown'}`,
  };
}
