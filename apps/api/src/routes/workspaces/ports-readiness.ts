import type { WorkspacePortsState, WorkspaceStatus } from '@simple-agent-manager/shared';

const EXPECTED_WORKSPACE_PORTS_UPSTREAM_UNAVAILABLE = new Set([502, 503, 504]);

type WorkspacePortsReadinessPayload = {
  ports: [];
  state: WorkspacePortsState;
  workspaceStatus: WorkspaceStatus | null;
  retryable: boolean;
  message: string;
  diagnostics?: Record<string, unknown>;
};

export function isWorkspacePortsListRequest(
  method: string,
  pathname: string,
  workspaceId: string
): boolean {
  return method === 'GET' && pathname === `/workspaces/${workspaceId}/ports`;
}

export function workspacePortsStateForStatus(status: WorkspaceStatus): WorkspacePortsState {
  if (status === 'sleeping' || status === 'stopped' || status === 'deleted') return status;
  if (status === 'error') return 'error';
  return 'not_ready';
}

export function workspacePortsReadinessPayload(
  state: WorkspacePortsState,
  workspaceStatus: WorkspaceStatus | null,
  message: string,
  retryable: boolean,
  diagnostics?: Record<string, unknown>
): WorkspacePortsReadinessPayload {
  return {
    ports: [],
    state,
    workspaceStatus,
    retryable,
    message,
    ...(diagnostics ? { diagnostics } : {}),
  };
}

export function workspacePortsReadinessStatus(state: WorkspacePortsState): 200 | 202 {
  return state === 'not_ready' ? 202 : 200;
}

export function isExpectedWorkspacePortsUpstreamUnavailable(status: number): boolean {
  return EXPECTED_WORKSPACE_PORTS_UPSTREAM_UNAVAILABLE.has(status);
}
