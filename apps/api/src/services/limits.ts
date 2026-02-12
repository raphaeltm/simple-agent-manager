import {
  DEFAULT_MAX_AGENT_SESSIONS_PER_WORKSPACE,
  DEFAULT_MAX_NODES_PER_USER,
  DEFAULT_MAX_WORKSPACES_PER_NODE,
  DEFAULT_MAX_WORKSPACES_PER_USER,
  DEFAULT_NODE_HEARTBEAT_STALE_SECONDS,
} from '@simple-agent-manager/shared';

export interface RuntimeLimits {
  maxNodesPerUser: number;
  maxWorkspacesPerUser: number;
  maxWorkspacesPerNode: number;
  maxAgentSessionsPerWorkspace: number;
  nodeHeartbeatStaleSeconds: number;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

export function getRuntimeLimits(env: {
  MAX_NODES_PER_USER?: string;
  MAX_WORKSPACES_PER_USER?: string;
  MAX_WORKSPACES_PER_NODE?: string;
  MAX_AGENT_SESSIONS_PER_WORKSPACE?: string;
  NODE_HEARTBEAT_STALE_SECONDS?: string;
}): RuntimeLimits {
  return {
    maxNodesPerUser: parsePositiveInt(env.MAX_NODES_PER_USER, DEFAULT_MAX_NODES_PER_USER),
    maxWorkspacesPerUser: parsePositiveInt(env.MAX_WORKSPACES_PER_USER, DEFAULT_MAX_WORKSPACES_PER_USER),
    maxWorkspacesPerNode: parsePositiveInt(env.MAX_WORKSPACES_PER_NODE, DEFAULT_MAX_WORKSPACES_PER_NODE),
    maxAgentSessionsPerWorkspace: parsePositiveInt(
      env.MAX_AGENT_SESSIONS_PER_WORKSPACE,
      DEFAULT_MAX_AGENT_SESSIONS_PER_WORKSPACE
    ),
    nodeHeartbeatStaleSeconds: parsePositiveInt(
      env.NODE_HEARTBEAT_STALE_SECONDS,
      DEFAULT_NODE_HEARTBEAT_STALE_SECONDS
    ),
  };
}
