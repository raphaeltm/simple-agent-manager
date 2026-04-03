import type {
  AdminUsersResponse,
  ErrorListResponse,
  ErrorTrendResponse,
  HealthSummary,
  LogQueryResponse,
  UserRole,
  UserStatus,
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

// =============================================================================
// Admin Analytics
// =============================================================================

export interface AnalyticsDauResponse {
  dau: Array<{ date: string; unique_users: number }>;
  periodDays: number;
}

export interface AnalyticsEventsResponse {
  events: Array<{ event_name: string; count: number; unique_users: number; avg_response_ms: number }>;
  period: string;
}

export interface AnalyticsFunnelResponse {
  funnel: Array<{ event_name: string; unique_users: number }>;
  periodDays: number;
}

export async function fetchAnalyticsDau(): Promise<AnalyticsDauResponse> {
  return request<AnalyticsDauResponse>('/api/admin/analytics/dau');
}

export async function fetchAnalyticsEvents(period?: string): Promise<AnalyticsEventsResponse> {
  const params = period ? `?period=${period}` : '';
  return request<AnalyticsEventsResponse>(`/api/admin/analytics/events${params}`);
}

export async function fetchAnalyticsFunnel(): Promise<AnalyticsFunnelResponse> {
  return request<AnalyticsFunnelResponse>('/api/admin/analytics/funnel');
}

// Phase 3: Feature adoption, geo distribution, retention cohorts

export interface AnalyticsFeatureAdoptionResponse {
  totals: Array<{ event_name: string; count: number; unique_users: number }>;
  trend: Array<{ event_name: string; date: string; count: number }>;
  period: string;
}

export interface AnalyticsGeoResponse {
  geo: Array<{ country: string; event_count: number; unique_users: number }>;
  period: string;
}

export interface AnalyticsRetentionResponse {
  retention: Array<{
    cohortWeek: string;
    cohortSize: number;
    weeks: Array<{ week: number; users: number; rate: number }>;
  }>;
  weeks: number;
  truncated?: boolean;
}

export async function fetchAnalyticsFeatureAdoption(period?: string): Promise<AnalyticsFeatureAdoptionResponse> {
  const params = period ? `?period=${period}` : '';
  return request<AnalyticsFeatureAdoptionResponse>(`/api/admin/analytics/feature-adoption${params}`);
}

export async function fetchAnalyticsGeo(period?: string): Promise<AnalyticsGeoResponse> {
  const params = period ? `?period=${period}` : '';
  return request<AnalyticsGeoResponse>(`/api/admin/analytics/geo${params}`);
}

export async function fetchAnalyticsRetention(weeks?: number): Promise<AnalyticsRetentionResponse> {
  const params = weeks ? `?weeks=${weeks}` : '';
  return request<AnalyticsRetentionResponse>(`/api/admin/analytics/retention${params}`);
}

// Website traffic analytics

export interface WebsiteTrafficSection {
  name: string;
  views: number;
  unique_visitors: number;
  topPages: Array<{ page: string; views: number; unique_visitors: number }>;
}

export interface WebsiteTrafficHost {
  host: string;
  totalViews: number;
  uniqueVisitors: number;
  uniqueSessions: number;
  sections: WebsiteTrafficSection[];
}

export interface AnalyticsWebsiteTrafficResponse {
  hosts: WebsiteTrafficHost[];
  trend: Array<{ host: string; date: string; views: number }>;
  period: string;
}

export async function fetchAnalyticsWebsiteTraffic(period?: string): Promise<AnalyticsWebsiteTrafficResponse> {
  const params = period ? `?period=${period}` : '';
  return request<AnalyticsWebsiteTrafficResponse>(`/api/admin/analytics/website-traffic${params}`);
}

// Analytics forwarding status (Phase 4)
export interface AnalyticsForwardStatusResponse {
  enabled: boolean;
  lastForwardedAt: string | null;
  destinations: {
    segment: { configured: boolean };
    ga4: { configured: boolean };
  };
  events: string[];
}

export async function fetchAnalyticsForwardStatus(): Promise<AnalyticsForwardStatusResponse> {
  return request<AnalyticsForwardStatusResponse>('/api/admin/analytics/forward-status');
}
