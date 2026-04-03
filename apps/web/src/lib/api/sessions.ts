import { request } from './client';

// =============================================================================
// Chat Sessions (Project DO)
// =============================================================================

export interface ChatSessionListResponse {
  sessions: ChatSessionResponse[];
  total: number;
}

export interface ChatSessionResponse {
  id: string;
  workspaceId: string | null;
  taskId: string | null;
  topic: string | null;
  status: string;
  messageCount: number;
  startedAt: number;
  endedAt: number | null;
  createdAt: number;
  /** Timestamp when the agent completed its work (null if still running or never started). */
  agentCompletedAt?: number | null;
  /** Timestamp of the last message in the session. */
  lastMessageAt?: number | null;
  /** Whether the session is idle (agent completed but session still active). */
  isIdle?: boolean;
  /** Whether the session has been stopped. */
  isTerminated?: boolean;
  /** Full workspace URL for direct access. */
  workspaceUrl?: string | null;
  /** Scheduled cleanup timestamp for idle sessions (from idle_cleanup_schedule). */
  cleanupAt?: number | null;
  /** Active agent session ID (ULID) from D1, used for ACP WebSocket routing. */
  agentSessionId?: string | null;
  /** Embedded task summary (populated in session detail response). */
  task?: {
    id: string;
    status?: string;
    executionStep?: string | null;
    errorMessage?: string | null;
    outputBranch?: string | null;
    outputPrUrl?: string | null;
    outputSummary?: string | null;
    finalizedAt?: string | null;
  };
}

export interface ChatMessageResponse {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  toolMetadata: Record<string, unknown> | null;
  createdAt: number;
  sequence?: number | null;
}

export interface ChatSessionDetailResponse {
  session: ChatSessionResponse;
  messages: ChatMessageResponse[];
  hasMore: boolean;
}

export async function listChatSessions(
  projectId: string,
  params: { status?: string; limit?: number; offset?: number } = {}
): Promise<ChatSessionListResponse> {
  const searchParams = new URLSearchParams();
  if (params.status) searchParams.set('status', params.status);
  if (params.limit !== undefined) searchParams.set('limit', String(params.limit));
  if (params.offset !== undefined) searchParams.set('offset', String(params.offset));

  const qs = searchParams.toString();
  const endpoint = qs
    ? `/api/projects/${projectId}/sessions?${qs}`
    : `/api/projects/${projectId}/sessions`;

  return request<ChatSessionListResponse>(endpoint);
}

export async function getChatSession(
  projectId: string,
  sessionId: string,
  params: { limit?: number; before?: number; signal?: AbortSignal } = {}
): Promise<ChatSessionDetailResponse> {
  const searchParams = new URLSearchParams();
  if (params.limit !== undefined) searchParams.set('limit', String(params.limit));
  if (params.before !== undefined) searchParams.set('before', String(params.before));

  const qs = searchParams.toString();
  const endpoint = qs
    ? `/api/projects/${projectId}/sessions/${sessionId}?${qs}`
    : `/api/projects/${projectId}/sessions/${sessionId}`;

  return request<ChatSessionDetailResponse>(endpoint, params.signal ? { signal: params.signal } : {});
}

export async function createChatSession(
  projectId: string,
  data: { workspaceId?: string; topic?: string } = {}
): Promise<{ id: string }> {
  return request<{ id: string }>(`/api/projects/${projectId}/sessions`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function stopChatSession(
  projectId: string,
  sessionId: string
): Promise<{ status: string }> {
  return request<{ status: string }>(`/api/projects/${projectId}/sessions/${sessionId}/stop`, {
    method: 'POST',
  });
}

// Context summarization (conversation forking)
export interface SessionSummaryResponse {
  summary: string;
  messageCount: number;
  filteredCount: number;
  method: 'ai' | 'heuristic' | 'verbatim';
}

export async function summarizeSession(
  projectId: string,
  sessionId: string
): Promise<SessionSummaryResponse> {
  return request<SessionSummaryResponse>(
    `/api/projects/${projectId}/sessions/${sessionId}/summarize`,
    { method: 'POST' }
  );
}

export async function resetIdleTimer(
  projectId: string,
  sessionId: string
): Promise<{ cleanupAt: number }> {
  return request<{ cleanupAt: number }>(`/api/projects/${projectId}/sessions/${sessionId}/idle-reset`, {
    method: 'POST',
  });
}

/** @deprecated Use ACP WebSocket session/prompt instead (useProjectAgentSession.sendPrompt). */
export async function sendFollowUpPrompt(
  projectId: string,
  sessionId: string,
  content: string
): Promise<{ status: string; sessionId?: string; message?: string }> {
  return request<{ status: string; sessionId?: string; message?: string }>(
    `/api/projects/${projectId}/sessions/${sessionId}/prompt`,
    {
      method: 'POST',
      body: JSON.stringify({ content }),
    }
  );
}

// =============================================================================
// Activity Events
// =============================================================================

export interface ActivityEventResponse {
  id: string;
  eventType: string;
  actorType: string;
  actorId: string | null;
  workspaceId: string | null;
  sessionId: string | null;
  taskId: string | null;
  payload: Record<string, unknown> | null;
  createdAt: number;
}

export interface ActivityEventsListResponse {
  events: ActivityEventResponse[];
  hasMore: boolean;
}

export async function listActivityEvents(
  projectId: string,
  params?: { eventType?: string; before?: number; limit?: number }
): Promise<ActivityEventsListResponse> {
  const searchParams = new URLSearchParams();
  if (params?.eventType) searchParams.set('eventType', params.eventType);
  if (params?.before) searchParams.set('before', String(params.before));
  if (params?.limit) searchParams.set('limit', String(params.limit));

  const qs = searchParams.toString();
  const endpoint = `/api/projects/${projectId}/activity${qs ? `?${qs}` : ''}`;
  return request<ActivityEventsListResponse>(endpoint);
}
