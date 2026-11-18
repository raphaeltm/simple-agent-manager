import { request } from './client';

export interface AnalyticsDauResponse {
  dau: Array<{ date: string; unique_users: number }>;
  periodDays: number;
}

export interface AnalyticsEventsResponse {
  events: Array<{
    event_name: string;
    count: number;
    unique_users: number;
    avg_response_ms: number;
  }>;
  period: string;
}

export async function fetchAnalyticsDau(signal?: AbortSignal): Promise<AnalyticsDauResponse> {
  return request<AnalyticsDauResponse>('/api/admin/analytics/dau', { signal });
}

export async function fetchAnalyticsEvents(
  period?: string,
  signal?: AbortSignal
): Promise<AnalyticsEventsResponse> {
  const params = period ? `?period=${period}` : '';
  return request<AnalyticsEventsResponse>(`/api/admin/analytics/events${params}`, { signal });
}

// Feature adoption

export interface AnalyticsFeatureAdoptionResponse {
  totals: Array<{ event_name: string; count: number; unique_users: number }>;
  trend: Array<{ event_name: string; date: string; count: number }>;
  period: string;
}

export async function fetchAnalyticsFeatureAdoption(
  period?: string,
  signal?: AbortSignal
): Promise<AnalyticsFeatureAdoptionResponse> {
  const params = period ? `?period=${period}` : '';
  return request<AnalyticsFeatureAdoptionResponse>(
    `/api/admin/analytics/feature-adoption${params}`,
    { signal }
  );
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

export async function fetchAnalyticsWebsiteTraffic(
  period?: string,
  signal?: AbortSignal
): Promise<AnalyticsWebsiteTrafficResponse> {
  const params = period ? `?period=${period}` : '';
  return request<AnalyticsWebsiteTrafficResponse>(`/api/admin/analytics/website-traffic${params}`, {
    signal,
  });
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

export async function fetchAnalyticsForwardStatus(
  signal?: AbortSignal
): Promise<AnalyticsForwardStatusResponse> {
  return request<AnalyticsForwardStatusResponse>('/api/admin/analytics/forward-status', { signal });
}

// Phase 5: AI Usage (AI Gateway logs)

export interface AiUsageByModel {
  model: string;
  provider: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  cachedRequests: number;
  errorRequests: number;
}

export interface AiUsageByDay {
  date: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface AnalyticsAiUsageResponse {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  cachedRequests: number;
  errorRequests: number;
  byModel: AiUsageByModel[];
  byDay: AiUsageByDay[];
  period: string;
}

export async function fetchAnalyticsAiUsage(
  period?: string,
  signal?: AbortSignal
): Promise<AnalyticsAiUsageResponse> {
  const params = period ? `?period=${period}` : '';
  return request<AnalyticsAiUsageResponse>(`/api/admin/analytics/ai-usage${params}`, { signal });
}

// =============================================================================
// Admin Cost Monitoring
// =============================================================================

export interface CostByModel {
  model: string;
  provider: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface CostByDay {
  date: string;
  costUsd: number;
  requests: number;
}

export interface CostByUser {
  userId: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface CostSummaryResponse {
  llm: {
    totalCostUsd: number;
    totalRequests: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    cachedRequests: number;
    errorRequests: number;
    byModel: CostByModel[];
    byDay: CostByDay[];
    byUser: CostByUser[];
  };
  projection: {
    projectedMonthlyCostUsd: number;
    dailyAverageCostUsd: number;
    daysElapsed: number;
    daysInMonth: number;
  };
  period: string;
  periodLabel: string;
}

export async function fetchAdminCosts(
  period?: string,
  signal?: AbortSignal
): Promise<CostSummaryResponse> {
  const params = period ? `?period=${period}` : '';
  return request<CostSummaryResponse>(`/api/admin/costs${params}`, { signal });
}
