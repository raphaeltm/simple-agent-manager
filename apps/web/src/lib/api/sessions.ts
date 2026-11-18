import type {
  ChatMessagesListResponse,
  ChatSessionDetailResponse,
  ChatSessionListResponse,
  ChatSessionStateResponse,
} from './session-transcript-types';
export type {
  ChatMessageResponse,
  ChatMessagesListResponse,
  ChatSessionDetailResponse,
  ChatSessionListItem,
  ChatSessionListResponse,
  ChatSessionResponse,
  ChatSessionStateResponse,
  ChatSessionTaskEmbed,
  SessionStateSnapshot,
  ToolSnapshotChanges,
} from './session-transcript-types';
import type { AgentEffort, AgentProfileRuntime } from '@simple-agent-manager/shared';
import { CHAT_TOOL_REPLACE_CAPABILITY } from '@simple-agent-manager/shared';

import { recordServerTime } from '../server-clock';
import { request } from './client';

// =============================================================================
// Chat Sessions (Project DO)
// =============================================================================

export async function listChatSessions(
  projectId: string,
  params: {
    status?: string;
    limit?: number;
    offset?: number;
    scope?: 'my' | 'all';
    /**
     * Also return every awake and sleeping session in scope that the newest page left out
     * (first page, no status filter). The chat sidebar groups by state, not by age.
     */
    includeLive?: boolean;
  } = {}
): Promise<ChatSessionListResponse> {
  const searchParams = new URLSearchParams();
  if (params.status) searchParams.set('status', params.status);
  if (params.limit !== undefined) searchParams.set('limit', String(params.limit));
  if (params.offset !== undefined) searchParams.set('offset', String(params.offset));
  if (params.scope) searchParams.set('scope', params.scope);
  if (params.includeLive) searchParams.set('include', 'live');

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

/** `before`/`after` are exact cursors from `lib/message-paging` (the rows at a page's edge). */
export async function getChatSession(
  projectId: string,
  sessionId: string,
  params: {
    limit?: number;
    before?: string;
    after?: string;
    afterToolRevision?: number;
    signal?: AbortSignal;
  } = {}
): Promise<ChatSessionDetailResponse> {
  const searchParams = new URLSearchParams();
  searchParams.set('toolReplace', CHAT_TOOL_REPLACE_CAPABILITY);
  if (params.afterToolRevision !== undefined)
    searchParams.set('afterToolRevision', String(params.afterToolRevision));
  if (params.limit !== undefined) searchParams.set('limit', String(params.limit));
  if (params.before !== undefined) searchParams.set('before', params.before);
  if (params.after !== undefined) searchParams.set('after', params.after);

  const qs = searchParams.toString();
  const endpoint = qs
    ? `/api/projects/${projectId}/sessions/${sessionId}?${qs}`
    : `/api/projects/${projectId}/sessions/${sessionId}`;

  const detail = await request<ChatSessionDetailResponse>(
    endpoint,
    params.signal ? { signal: params.signal } : {}
  );
  recordServerTime(detail.session?.access?.serverTime);
  return detail;
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
    before?: string;
    after?: string;
    afterToolRevision?: number;
    roles?: string[];
    compact?: boolean;
    order?: 'asc' | 'desc';
    signal?: AbortSignal;
  } = {}
): Promise<ChatMessagesListResponse> {
  const searchParams = new URLSearchParams();
  searchParams.set('toolReplace', CHAT_TOOL_REPLACE_CAPABILITY);
  if (params.afterToolRevision !== undefined)
    searchParams.set('afterToolRevision', String(params.afterToolRevision));
  if (params.limit !== undefined) searchParams.set('limit', String(params.limit));
  if (params.before !== undefined) searchParams.set('before', params.before);
  if (params.after !== undefined) searchParams.set('after', params.after);
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
): Promise<{
  content: unknown[];
  source?: 'inline' | 'archive' | 'archived_unavailable';
  archived?: { archivedAt: number; contentBytes: number; reason?: string };
}> {
  return request<{
    content: unknown[];
    source?: 'inline' | 'archive' | 'archived_unavailable';
    archived?: { archivedAt: number; contentBytes: number; reason?: string };
  }>(`/api/projects/${projectId}/sessions/${sessionId}/messages/${messageId}/tool-content`);
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
  /** Model for this chat only; omitted inherits the skill/profile model. */
  model?: string;
  /** Effort for this chat only; must be supported by the resolved agent. */
  effort?: AgentEffort;
  /** The caller's own account for this chat only; omitted uses the profile's account. */
  agentConfigurationId?: string;
  /** An open idea in this project this conversation starts from. The server links it
   * (`discusses`) before the agent receives its first prompt. */
  sourceIdeaId?: string;
}

export interface StartInstantChatSessionResponse {
  status: 'starting' | 'running';
  taskId: string;
  runtime: {
    runtime: AgentProfileRuntime;
    reason: string;
  };
  sessionId: string;
  workspaceId: string;
  nodeId: string;
  agentSessionId?: string;
  acpSessionId?: string;
  workspaceUrl: string;
  timings?: {
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

export async function resolveAttentionAnswer(
  projectId: string,
  sessionId: string,
  markerId: string,
  answer: string
): Promise<{
  resolved: boolean;
  alreadyResolved: boolean;
  inFlight?: boolean;
  answer: string;
}> {
  return request<{
    resolved: boolean;
    alreadyResolved: boolean;
    inFlight?: boolean;
    answer: string;
  }>(`/api/projects/${projectId}/sessions/${sessionId}/attention/${markerId}/resolve`, {
    method: 'POST',
    body: JSON.stringify({ answer }),
  });
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
