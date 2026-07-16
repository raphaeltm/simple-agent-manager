import type { AgentProfileRuntime } from '@simple-agent-manager/shared';

import { request } from './client';

// =============================================================================
// Chat Sessions (Project DO)
// =============================================================================

/** Task embed shape — populated in the detail response, added via enrichment for list items. */
export interface ChatSessionTaskEmbed {
  id: string;
  status?: string;
  executionStep?: string | null;
  errorMessage?: string | null;
  outputBranch?: string | null;
  outputPrUrl?: string | null;
  outputSummary?: string | null;
  finalizedAt?: string | null;
  /** Task execution mode: 'task' (autonomous) or 'conversation' (interactive). */
  taskMode?: 'task' | 'conversation' | null;
  /** Agent profile name hint (human-readable label from dispatch). */
  agentProfileHint?: string | null;
}

/**
 * What the list API returns — no task embed.
 *
 * The list endpoint (`GET /api/projects/:id/sessions`) returns sessions from
 * the ProjectData DO, which only stores `taskId`. Task status, execution step,
 * and other task metadata live in D1 and are NOT included in list responses.
 */
export interface ChatSessionListItem {
  id: string;
  workspaceId: string | null;
  taskId: string | null;
  createdByUserId?: string | null;
  createdBy?: {
    id: string;
    name: string | null;
    email: string | null;
    image: string | null;
    avatarUrl: string | null;
  } | null;
  isMine?: boolean;
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
  /** Agent type from ACP session (e.g., 'claude-code', 'openai-codex'). */
  agentType?: string | null;
  /** Durable attention marker summary from backend (null = no active marker). */
  attention?: {
    kind: string;
    createdAt: number;
    expiresAt: number | null;
    reason: string | null;
  } | null;
}

/**
 * Enriched session — extends the list item with an optional task embed.
 *
 * This is the type used by components that need to distinguish completed/failed
 * tasks from stopped sessions. The `task` field is populated either by:
 * - The detail API (`GET /api/projects/:id/sessions/:sessionId`)
 * - Frontend enrichment from `taskInfoMap` (see SessionTreeItem)
 */
export interface ChatSessionResponse extends ChatSessionListItem {
  task?: ChatSessionTaskEmbed;
}

export interface ChatSessionListResponse {
  sessions: ChatSessionListItem[];
  total: number;
}

export interface ChatMessageResponse {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  toolMetadata: Record<string, unknown> | null;
  createdAt: number;
  sequence?: number | null;
  /** "system" for SAM-injected messages the UI collapses; absent for normal messages. */
  origin?: 'user' | 'system' | null;
}

/** Persisted session state snapshot from the DO (for catch-up on page load). */
export interface SessionStateSnapshot {
  activity: 'idle' | 'prompting' | 'recovering' | 'error' | 'stopped';
  activityAt: number;
  statusError: string | null;
  currentPlan: Array<{ content: string; status: string }> | null;
  planUpdatedAt: number | null;
  promptStartedAt: number | null;
  agentType: string | null;
  lastStopReason: string | null;
}

export interface ChatSessionDetailResponse {
  session: ChatSessionResponse;
  messages: ChatMessageResponse[];
  hasMore: boolean;
  state?: SessionStateSnapshot | null;
}

export interface ChatSessionStateResponse {
  state: SessionStateSnapshot | null;
  agentSessionId: string | null;
  agentType: string | null;
}

export interface ChatMessagesListResponse {
  messages: ChatMessageResponse[];
  hasMore: boolean;
}

export async function listChatSessions(
  projectId: string,
  params: { status?: string; limit?: number; offset?: number; scope?: 'my' | 'all' } = {}
): Promise<ChatSessionListResponse> {
  const searchParams = new URLSearchParams();
  if (params.status) searchParams.set('status', params.status);
  if (params.limit !== undefined) searchParams.set('limit', String(params.limit));
  if (params.offset !== undefined) searchParams.set('offset', String(params.offset));
  if (params.scope) searchParams.set('scope', params.scope);

  const qs = searchParams.toString();
  const endpoint = qs
    ? `/api/projects/${projectId}/sessions?${qs}`
    : `/api/projects/${projectId}/sessions`;

  return request<ChatSessionListResponse>(endpoint);
}

// =============================================================================
// Cross-Project Chat Sessions (D1 session_summaries)
// =============================================================================

export interface SessionSummaryItem {
  id: string;
  projectId: string;
  projectName: string;
  userId: string;
  status: string;
  topic: string | null;
  taskId: string | null;
  workspaceId: string | null;
  messageCount: number;
  startedAt: number;
  lastMessageAt: number | null;
  agentCompletedAt: number | null;
  endedAt: number | null;
  updatedAt: number;
}

export interface RecentChatsApiResponse {
  sessions: SessionSummaryItem[];
  totalActive: number;
}

export interface AllChatsApiResponse {
  sessions: SessionSummaryItem[];
  total: number;
}

/** Fetch recent active sessions across all projects (single D1 query). */
export async function getRecentChats(
  params: { limit?: number; staleThreshold?: number } = {}
): Promise<RecentChatsApiResponse> {
  const searchParams = new URLSearchParams();
  if (params.limit !== undefined) searchParams.set('limit', String(params.limit));
  if (params.staleThreshold !== undefined)
    searchParams.set('staleThreshold', String(params.staleThreshold));

  const qs = searchParams.toString();
  return request<RecentChatsApiResponse>(qs ? `/api/chats/recent?${qs}` : '/api/chats/recent');
}

/** Fetch all sessions across all projects with pagination (single D1 query). */
export async function getAllChats(
  params: { limit?: number; offset?: number; status?: string } = {}
): Promise<AllChatsApiResponse> {
  const searchParams = new URLSearchParams();
  if (params.limit !== undefined) searchParams.set('limit', String(params.limit));
  if (params.offset !== undefined) searchParams.set('offset', String(params.offset));
  if (params.status) searchParams.set('status', params.status);

  const qs = searchParams.toString();
  return request<AllChatsApiResponse>(qs ? `/api/chats?${qs}` : '/api/chats');
}

// =============================================================================
// Per-Project Chat Session Detail
// =============================================================================

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

  return request<ChatSessionDetailResponse>(
    endpoint,
    params.signal ? { signal: params.signal } : {}
  );
}

export async function getChatSessionState(
  projectId: string,
  sessionId: string,
  params: { signal?: AbortSignal } = {}
): Promise<ChatSessionStateResponse> {
  return request<ChatSessionStateResponse>(
    `/api/projects/${projectId}/sessions/${sessionId}/state`,
    params.signal ? { signal: params.signal } : {}
  );
}

export async function listChatMessages(
  projectId: string,
  sessionId: string,
  params: {
    limit?: number;
    before?: number;
    roles?: string[];
    compact?: boolean;
    order?: 'asc' | 'desc';
    signal?: AbortSignal;
  } = {}
): Promise<ChatMessagesListResponse> {
  const searchParams = new URLSearchParams();
  if (params.limit !== undefined) searchParams.set('limit', String(params.limit));
  if (params.before !== undefined) searchParams.set('before', String(params.before));
  if (params.roles && params.roles.length > 0) searchParams.set('roles', params.roles.join(','));
  if (params.compact !== undefined) searchParams.set('compact', String(params.compact));
  if (params.order !== undefined) searchParams.set('order', params.order);

  const qs = searchParams.toString();
  const endpoint = qs
    ? `/api/projects/${projectId}/sessions/${sessionId}/messages?${qs}`
    : `/api/projects/${projectId}/sessions/${sessionId}/messages`;

  return request<ChatMessagesListResponse>(
    endpoint,
    params.signal ? { signal: params.signal } : {}
  );
}

/**
 * Lazy-load the tool_metadata.content array for a single message.
 * Used by compact mode when the user expands a tool call card.
 */
export async function getMessageToolContent(
  projectId: string,
  sessionId: string,
  messageId: string
): Promise<{ content: unknown[] }> {
  return request<{ content: unknown[] }>(
    `/api/projects/${projectId}/sessions/${sessionId}/messages/${messageId}/tool-content`
  );
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

export interface StartInstantChatSessionRequest {
  message: string;
  agentProfileId?: string;
  skillId?: string;
  parentTaskId?: string;
  contextSummary?: string;
}

export interface StartInstantChatSessionResponse {
  status: 'running';
  taskId: string;
  runtime: {
    runtime: AgentProfileRuntime;
    reason: string;
  };
  sessionId: string;
  workspaceId: string;
  nodeId: string;
  agentSessionId: string;
  acpSessionId: string;
  workspaceUrl: string;
  timings: {
    totalDurationMs: number;
    preContainerDurationMs: number;
    containerLaunchDurationMs: number;
    /** @deprecated backward-compat alias for totalDurationMs; prefer totalDurationMs. */
    setupDurationMs: number;
    /** @deprecated backward-compat alias for containerLaunchDurationMs; prefer containerLaunchDurationMs. */
    installDurationMs: number;
    agentReadyDurationMs: number;
    workspaceCreateDurationMs: number;
    acpSessionCreateDurationMs: number;
    acpSessionStartDurationMs: number;
  };
}

export async function startInstantChatSession(
  projectId: string,
  data: StartInstantChatSessionRequest
): Promise<StartInstantChatSessionResponse> {
  return request<StartInstantChatSessionResponse>(`/api/projects/${projectId}/sessions/start`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function stopChatSession(
  projectId: string,
  sessionId: string
): Promise<{ status: string; workspaceDeleted?: boolean }> {
  return request<{ status: string; workspaceDeleted?: boolean }>(
    `/api/projects/${projectId}/sessions/${sessionId}/stop`,
    {
      method: 'POST',
    }
  );
}

// Context summarization (conversation forking)
export interface ForkPreparationResponse {
  parentTaskId: string;
  parentSessionId: string;
  parentBranch: string | null;
  sessionLabel: string;
  summary: string;
  messageCount: number;
  repaired: boolean;
}

export async function prepareForkSession(
  projectId: string,
  sessionId: string
): Promise<ForkPreparationResponse> {
  return request<ForkPreparationResponse>(
    `/api/projects/${projectId}/sessions/${sessionId}/fork-prepare`,
    { method: 'POST' }
  );
}

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
  return request<{ cleanupAt: number }>(
    `/api/projects/${projectId}/sessions/${sessionId}/idle-reset`,
    {
      method: 'POST',
    }
  );
}

/** Send a follow-up prompt to the running agent via the REST API. */
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

/** Cancel the current in-flight prompt on the running agent session. */
export async function cancelAgentPrompt(
  projectId: string,
  sessionId: string
): Promise<{ status: string; message: string }> {
  return request<{ status: string; message: string }>(
    `/api/projects/${projectId}/sessions/${sessionId}/cancel`,
    { method: 'POST' }
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
  params?: { eventType?: string; sessionId?: string; before?: number; limit?: number }
): Promise<ActivityEventsListResponse> {
  const searchParams = new URLSearchParams();
  if (params?.eventType) searchParams.set('eventType', params.eventType);
  if (params?.sessionId) searchParams.set('sessionId', params.sessionId);
  if (params?.before) searchParams.set('before', String(params.before));
  if (params?.limit) searchParams.set('limit', String(params.limit));

  const qs = searchParams.toString();
  const endpoint = `/api/projects/${projectId}/activity${qs ? `?${qs}` : ''}`;
  return request<ActivityEventsListResponse>(endpoint);
}
