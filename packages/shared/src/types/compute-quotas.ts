// =============================================================================
// Compute Quota Types
// =============================================================================

/** Source of the resolved quota. */
export type QuotaSource = 'user_override' | 'default' | 'unlimited';

/** Response for GET /api/usage/quota (current user's quota status). */
export interface UserQuotaStatusResponse {
  monthlyVcpuHoursLimit: number | null;
  source: QuotaSource;
  currentUsage: number;
  remaining: number | null;
  periodStart: string;
  periodEnd: string;
  byocExempt: boolean;
}

/** Admin view of a single user's quota with usage. */
export interface AdminUserQuotaSummary {
  userId: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
  monthlyVcpuHoursLimit: number | null;
  source: QuotaSource;
  currentUsage: number;
  percentUsed: number | null;
}

/** Response for GET /api/admin/quotas/default. */
export interface AdminDefaultQuotaResponse {
  monthlyVcpuHoursLimit: number | null;
  updatedAt: string | null;
}

/** Response for GET /api/admin/quotas/users. */
export interface AdminUserQuotasListResponse {
  defaultQuota: AdminDefaultQuotaResponse;
  users: AdminUserQuotaSummary[];
}

/** Resolved quota for a specific user (admin per-user view). */
export interface AdminUserResolvedQuota {
  userId: string;
  monthlyVcpuHoursLimit: number | null;
  source: QuotaSource;
  currentUsage: number;
  remaining: number | null;
  percentUsed: number | null;
}
