import type {
  AdminUsersResponse,
  UserRole,
  UserStatus,
  ErrorListResponse,
  HealthSummary,
  ErrorTrendResponse,
  LogQueryResponse,
} from '@simple-agent-manager/shared';
import { API_URL, request } from './client';

// =============================================================================
// Admin
// =============================================================================
export async function listAdminUsers(status?: UserStatus): Promise<AdminUsersResponse> {
  const params = status ? `?status=${status}` : '';
  return request<AdminUsersResponse>(`/api/admin/users${params}`);
}

export async function approveOrSuspendUser(
  userId: string,
  action: 'approve' | 'suspend'
): Promise<{ id: string; status: UserStatus }> {
  return request<{ id: string; status: UserStatus }>(`/api/admin/users/${userId}`, {
    method: 'PATCH',
    body: JSON.stringify({ action }),
  });
}

export async function changeUserRole(
  userId: string,
  role: Exclude<UserRole, 'superadmin'>
): Promise<{ id: string; role: UserRole }> {
  return request<{ id: string; role: UserRole }>(`/api/admin/users/${userId}/role`, {
    method: 'PATCH',
    body: JSON.stringify({ role }),
  });
}

// =============================================================================
// Admin Observability (spec 023)
// =============================================================================

export interface AdminErrorsFilter {
  source?: 'client' | 'vm-agent' | 'api' | 'all';
  level?: 'error' | 'warn' | 'info' | 'all';
  search?: string;
  startTime?: string;
  endTime?: string;
  limit?: number;
  cursor?: string;
}

export async function fetchAdminErrors(
  filter?: AdminErrorsFilter
): Promise<ErrorListResponse> {
  const params = new URLSearchParams();
  if (filter?.source && filter.source !== 'all') params.set('source', filter.source);
  if (filter?.level && filter.level !== 'all') params.set('level', filter.level);
  if (filter?.search) params.set('search', filter.search);
  if (filter?.startTime) params.set('startTime', filter.startTime);
  if (filter?.endTime) params.set('endTime', filter.endTime);
  if (filter?.limit) params.set('limit', String(filter.limit));
  if (filter?.cursor) params.set('cursor', filter.cursor);

  const qs = params.toString();
  return request<ErrorListResponse>(
    `/api/admin/observability/errors${qs ? `?${qs}` : ''}`
  );
}

export async function fetchAdminHealth(): Promise<HealthSummary> {
  return request<HealthSummary>('/api/admin/observability/health');
}

export async function fetchAdminErrorTrends(
  range?: string
): Promise<ErrorTrendResponse> {
  const params = range ? `?range=${range}` : '';
  return request<ErrorTrendResponse>(`/api/admin/observability/trends${params}`);
}

export interface AdminLogQueryParams {
  timeRange: { start: string; end: string };
  levels?: string[];
  search?: string;
  limit?: number;
  cursor?: string | null;
  /** Caller-supplied queryId for pagination consistency across paginated requests. */
  queryId?: string;
}

/**
 * Build the WebSocket URL for the admin real-time log stream.
 * Auth cookie is sent automatically via the WebSocket connection.
 */
export function getAdminLogStreamUrl(): string {
  const base = API_URL.replace(/^http/, 'ws');
  return `${base}/api/admin/observability/logs/stream`;
}

export async function queryAdminLogs(
  params: AdminLogQueryParams
): Promise<LogQueryResponse> {
  return request<LogQueryResponse>('/api/admin/observability/logs/query', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}
