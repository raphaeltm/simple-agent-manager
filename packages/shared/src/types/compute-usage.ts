import type { CredentialSource } from './user';

// =============================================================================
// Compute Usage Metering Types
// =============================================================================

/** A single compute usage record — tracks one workspace session that is later aggregated by node for billing. */
export interface ComputeUsageRecord {
  id: string;
  userId: string;
  workspaceId: string;
  nodeId: string;
  serverType: string;
  vcpuCount: number;
  credentialSource: CredentialSource;
  startedAt: string;
  endedAt: string | null;
  createdAt: string;
}

/** Active compute session shown in usage responses. */
export interface ActiveComputeSession {
  workspaceId: string;
  serverType: string;
  vcpuCount: number;
  startedAt: string;
  credentialSource: CredentialSource;
}

/** Period summary for compute usage. */
export interface ComputeUsagePeriod {
  start: string;
  end: string;
  totalVcpuHours: number;
  platformVcpuHours: number;
  userVcpuHours: number;
  activeWorkspaces: number;
}

/** Response for GET /api/usage/compute (current user). */
export interface ComputeUsageResponse {
  currentPeriod: ComputeUsagePeriod;
  activeSessions: ActiveComputeSession[];
}

/** Per-user usage summary for admin overview. */
export interface AdminUserUsageSummary {
  userId: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
  totalVcpuHours: number;
  platformVcpuHours: number;
  userVcpuHours: number;
  activeWorkspaces: number;
}

/** Response for GET /api/admin/usage/compute. */
export interface AdminComputeUsageResponse {
  period: { start: string; end: string };
  users: AdminUserUsageSummary[];
}

/** Detailed usage record for admin per-user view. */
export interface AdminUserDetailedUsage {
  currentPeriod: ComputeUsagePeriod;
  activeSessions: ActiveComputeSession[];
  recentRecords: ComputeUsageRecord[];
}

// =============================================================================
// Node-Centric Usage Types (admin view)
// =============================================================================

/** A single node's usage record — tracks the node's lifetime. */
export interface NodeUsageRecord {
  nodeId: string;
  name: string;
  vmSize: string;
  vcpuCount: number;
  vmLocation: string;
  cloudProvider: string | null;
  credentialSource: CredentialSource;
  status: string;
  createdAt: string;
  /** Null if node is still alive. Derived from updatedAt when status is destroyed/destroying/deleted. */
  endedAt: string | null;
  /** Number of workspaces that have run on this node. */
  workspaceCount: number;
}

/** Per-user node usage summary for admin overview. */
export interface AdminUserNodeUsageSummary {
  userId: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
  totalNodeHours: number;
  totalVcpuHours: number;
  platformNodeHours: number;
  activeNodes: number;
}

/** Response for GET /api/admin/usage/nodes. */
export interface AdminNodeUsageResponse {
  period: { start: string; end: string };
  users: AdminUserNodeUsageSummary[];
}

/** Detailed node usage for a specific user. */
export interface AdminUserNodeDetailedUsage {
  period: { start: string; end: string };
  totalNodeHours: number;
  totalVcpuHours: number;
  platformNodeHours: number;
  activeNodes: number;
  nodes: NodeUsageRecord[];
}
