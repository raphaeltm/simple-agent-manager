import type {
  AdminProjectEventInspectorResponse,
  AdminUsersResponse,
  CreatePlatformCredentialRequest,
  DebugDiagnosisListResponse,
  DebugDiagnosisRunDetailResponse,
  DebugDiagnosisRunEventsResponse,
  DebugProjectOptionsResponse,
  ErrorListResponse,
  ErrorTrendResponse,
  HealthSummary,
  ListPlatformCredentialsResponse,
  LogQueryResponse,
  PlatformCredentialResponse,
  RunDebugDiagnosisRequest,
  RunDebugDiagnosisResponse,
  SignupApprovalConfigResponse,
  UpdatePlatformCredentialRequest,
  UpdateSignupApprovalConfigRequest,
  UserRole,
  UserStatus,
} from '@simple-agent-manager/shared';
import { DEFAULT_DEBUG_DIAGNOSIS_EVENT_MAX_PAGES } from '@simple-agent-manager/shared';

import { API_URL, request } from './client';

export type { AdminProjectEventInspectorResponse };

const parsedDiagnosisEventMaxPages = Number.parseInt(
  import.meta.env.VITE_DEBUG_DIAGNOSIS_EVENT_MAX_PAGES ?? '',
  10
);
const diagnosisEventMaxPages =
  Number.isSafeInteger(parsedDiagnosisEventMaxPages) && parsedDiagnosisEventMaxPages > 0
    ? parsedDiagnosisEventMaxPages
    : DEFAULT_DEBUG_DIAGNOSIS_EVENT_MAX_PAGES;

// =============================================================================
// Admin
// =============================================================================
export async function listAdminUsers(
  status?: UserStatus,
  signal?: AbortSignal
): Promise<AdminUsersResponse> {
  const params = status ? `?status=${status}` : '';
  return request<AdminUsersResponse>(`/api/admin/users${params}`, { signal });
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

export async function fetchSignupApprovalConfig(
  signal?: AbortSignal
): Promise<SignupApprovalConfigResponse> {
  return request<SignupApprovalConfigResponse>('/api/admin/signup-approval', { signal });
}

export async function updateSignupApprovalConfig(
  body: UpdateSignupApprovalConfigRequest
): Promise<SignupApprovalConfigResponse> {
  return request<SignupApprovalConfigResponse>('/api/admin/signup-approval', {
    method: 'PUT',
    body: JSON.stringify(body),
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
  nodeId?: string;
  workspaceId?: string;
  taskId?: string;
  sessionId?: string;
  userId?: string;
}

export async function fetchAdminErrors(filter?: AdminErrorsFilter): Promise<ErrorListResponse> {
  const params = new URLSearchParams();
  if (filter?.source && filter.source !== 'all') params.set('source', filter.source);
  if (filter?.level && filter.level !== 'all') params.set('level', filter.level);
  if (filter?.search) params.set('search', filter.search);
  if (filter?.startTime) params.set('startTime', filter.startTime);
  if (filter?.endTime) params.set('endTime', filter.endTime);
  if (filter?.limit) params.set('limit', String(filter.limit));
  if (filter?.cursor) params.set('cursor', filter.cursor);
  if (filter?.nodeId) params.set('nodeId', filter.nodeId);
  if (filter?.workspaceId) params.set('workspaceId', filter.workspaceId);
  if (filter?.taskId) params.set('taskId', filter.taskId);
  if (filter?.sessionId) params.set('sessionId', filter.sessionId);
  if (filter?.userId) params.set('userId', filter.userId);

  const qs = params.toString();
  return request<ErrorListResponse>(`/api/admin/observability/errors${qs ? `?${qs}` : ''}`);
}

export async function fetchAdminHealth(signal?: AbortSignal): Promise<HealthSummary> {
  return request<HealthSummary>('/api/admin/observability/health', { signal });
}

export async function fetchAdminProjectEventInspector(
  projectId: string,
  limit?: number
): Promise<AdminProjectEventInspectorResponse> {
  const params = new URLSearchParams();
  if (limit !== undefined) params.set('limit', String(limit));
  const query = params.toString();
  return request<AdminProjectEventInspectorResponse>(
    `/api/admin/project-events/${encodeURIComponent(projectId)}/inspector${
      query ? `?${query}` : ''
    }`
  );
}

export async function fetchAdminErrorTrends(
  range?: string,
  signal?: AbortSignal
): Promise<ErrorTrendResponse> {
  const params = range ? `?range=${range}` : '';
  return request<ErrorTrendResponse>(`/api/admin/observability/trends${params}`, { signal });
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

export async function queryAdminLogs(params: AdminLogQueryParams): Promise<LogQueryResponse> {
  return request<LogQueryResponse>('/api/admin/observability/logs/query', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export async function runAdminDebugDiagnosis(
  body: RunDebugDiagnosisRequest
): Promise<RunDebugDiagnosisResponse> {
  return request<RunDebugDiagnosisResponse>('/api/admin/observability/diagnoses', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function fetchAdminDebugDiagnoses(
  filter: {
    errorId?: string;
    startTime?: string;
    endTime?: string;
    summaryOnly?: boolean;
  },
  signal?: AbortSignal
): Promise<DebugDiagnosisListResponse> {
  const params = new URLSearchParams();
  if (filter.summaryOnly) params.set('summaryOnly', 'true');
  if (filter.errorId) params.set('errorId', filter.errorId);
  if (filter.startTime) params.set('startTime', filter.startTime);
  if (filter.endTime) params.set('endTime', filter.endTime);
  return request<DebugDiagnosisListResponse>(
    `/api/admin/observability/diagnoses?${params.toString()}`,
    { signal }
  );
}

export async function fetchAdminDebugProjects(): Promise<DebugProjectOptionsResponse> {
  return request<DebugProjectOptionsResponse>('/api/admin/observability/debug/projects');
}

export async function fetchAdminDebugDiagnosisRun(
  runId: string,
  cursor = 0
): Promise<DebugDiagnosisRunDetailResponse> {
  const detail = await request<DebugDiagnosisRunDetailResponse>(
    '/api/admin/observability/diagnosis-runs/' + encodeURIComponent(runId) + '?cursor=' + cursor
  );
  const events = [...detail.events];
  const seenCursors = new Set<number>([cursor]);
  let nextCursor = detail.nextCursor;
  let pages = 1;
  while (nextCursor !== null) {
    const pageCursor = nextCursor;
    if (seenCursors.has(pageCursor) || pages >= diagnosisEventMaxPages) {
      throw new Error('Diagnosis event pagination did not make bounded forward progress');
    }
    seenCursors.add(pageCursor);
    const page = await fetchAdminDebugDiagnosisRunEvents(runId, pageCursor);
    if (page.events.some((event) => event.sequence <= pageCursor)) {
      throw new Error('Diagnosis event pagination returned a non-monotonic sequence');
    }
    events.push(...page.events);
    nextCursor = page.nextCursor;
    pages++;
  }
  return { ...detail, events, nextCursor: null };
}

export async function fetchAdminDebugDiagnosisRunEvents(
  runId: string,
  cursor = 0
): Promise<DebugDiagnosisRunEventsResponse> {
  return request<DebugDiagnosisRunEventsResponse>(
    '/api/admin/observability/diagnosis-runs/' +
      encodeURIComponent(runId) +
      '/events?cursor=' +
      cursor
  );
}

export async function downloadAdminDiagnosticArtifact(
  errorId: string,
  artifactId: string
): Promise<void> {
  const response = await fetch(
    `${API_URL}/api/admin/observability/errors/${encodeURIComponent(
      errorId
    )}/incident/artifacts/${encodeURIComponent(artifactId)}/download`,
    { credentials: 'include' }
  );
  if (!response.ok) {
    throw new Error(`Automatic evidence download failed (HTTP ${response.status})`);
  }
  const blob = await response.blob();
  const disposition = response.headers.get('content-disposition');
  const filename =
    disposition?.match(/filename="([^"]+)"/)?.[1] ?? `vm-incident-${artifactId}.tar.gz`;
  const href = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = href;
    link.download = filename;
    link.click();
  } finally {
    URL.revokeObjectURL(href);
  }
}

export async function cancelAdminDebugDiagnosisRun(runId: string): Promise<{ accepted: boolean }> {
  return request(
    '/api/admin/observability/diagnosis-runs/' + encodeURIComponent(runId) + '/cancel',
    { method: 'POST' }
  );
}

export async function retryAdminDebugDiagnosisRun(
  runId: string
): Promise<RunDebugDiagnosisResponse> {
  return request<RunDebugDiagnosisResponse>(
    `/api/admin/observability/diagnosis-runs/${encodeURIComponent(runId)}/retry`,
    {
      method: 'POST',
    }
  );
}

export async function saveAdminDebugDiagnosisAsIdea(
  diagnosisId: string,
  body: { projectId: string; title?: string }
): Promise<{ ideaId: string }> {
  return request<{ ideaId: string }>(`/api/admin/observability/diagnoses/${diagnosisId}/idea`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// =============================================================================
// Admin Analytics
// =============================================================================

export * from './admin-analytics';

// =============================================================================
// Admin AI Proxy Config
// =============================================================================

export type BillingMode = 'unified' | 'platform-key' | 'auto';

export interface AIProxyConfigResponse {
  defaultModel: string;
  source: 'admin' | 'env' | 'default';
  updatedAt: string | null;
  hasAnthropicCredential: boolean;
  hasOpenAICredential: boolean;
  hasUnifiedBilling: boolean;
  billingMode: BillingMode;
  models: Array<{
    id: string;
    label: string;
    provider: 'workers-ai' | 'anthropic' | 'openai';
    tier: 'low-cost' | 'standard' | 'premium';
    costPer1kInputTokens: number;
    costPer1kOutputTokens: number;
    isDefault?: boolean;
    available: boolean;
  }>;
}

export async function fetchAIProxyConfig(signal?: AbortSignal): Promise<AIProxyConfigResponse> {
  return request<AIProxyConfigResponse>('/api/admin/ai-proxy/config', { signal });
}

export async function updateAIProxyConfig(defaultModel: string): Promise<{
  defaultModel: string;
  source: 'admin';
  updatedAt: string;
}> {
  return request('/api/admin/ai-proxy/config', {
    method: 'PUT',
    body: JSON.stringify({ defaultModel }),
  });
}

export async function updateAIProxyBillingMode(billingMode: BillingMode): Promise<{
  billingMode: BillingMode;
}> {
  return request('/api/admin/ai-proxy/config', {
    method: 'PATCH',
    body: JSON.stringify({ billingMode }),
  });
}

export async function resetAIProxyConfig(): Promise<{
  defaultModel: string;
  source: 'env' | 'default';
  updatedAt: null;
}> {
  return request('/api/admin/ai-proxy/config', { method: 'DELETE' });
}

// =============================================================================
// Admin Trials Config
// =============================================================================

export interface AdminTrialsConfigResponse {
  enabled: boolean;
  kvKey: string;
  cacheTtlMs: number;
}

export async function fetchAdminTrialsConfig(
  signal?: AbortSignal
): Promise<AdminTrialsConfigResponse> {
  return request<AdminTrialsConfigResponse>('/api/admin/trials/config', { signal });
}

export async function updateAdminTrialsConfig(
  enabled: boolean
): Promise<AdminTrialsConfigResponse> {
  return request<AdminTrialsConfigResponse>('/api/admin/trials/config', {
    method: 'PATCH',
    body: JSON.stringify({ enabled }),
  });
}

// =============================================================================
// Admin Platform Credentials
// =============================================================================

export async function listPlatformCredentials(
  signal?: AbortSignal
): Promise<ListPlatformCredentialsResponse> {
  return request<ListPlatformCredentialsResponse>('/api/admin/platform-credentials', { signal });
}

export async function createPlatformCredential(
  data: CreatePlatformCredentialRequest
): Promise<PlatformCredentialResponse> {
  return request<PlatformCredentialResponse>('/api/admin/platform-credentials', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updatePlatformCredential(
  id: string,
  data: UpdatePlatformCredentialRequest
): Promise<PlatformCredentialResponse> {
  return request<PlatformCredentialResponse>(`/api/admin/platform-credentials/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export async function deletePlatformCredential(id: string): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`/api/admin/platform-credentials/${id}`, {
    method: 'DELETE',
  });
}

export * from './admin-compute';
export type {
  FeedbackProjectStatus,
  PlatformConfigFieldStatus,
  PlatformConfigSource,
  PlatformConfigStatus,
  PlatformConfigStatusResponse,
  PlatformIntegrationConfigInput,
  PlatformIntegrationStatus,
} from './admin-platform-config';
export { fetchAdminPlatformConfig, updateAdminPlatformConfig } from './admin-platform-config';
