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
