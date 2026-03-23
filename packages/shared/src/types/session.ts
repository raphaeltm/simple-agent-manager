import type { TaskStatus, TaskExecutionStep } from './task';

// =============================================================================
// Chat Sessions & Messages
// =============================================================================

export type ChatSessionStatus = 'active' | 'stopped' | 'error';

export interface ChatSession {
  id: string;
  workspaceId: string | null;
  taskId: string | null;
  topic: string | null;
  status: ChatSessionStatus;
  messageCount: number;
  startedAt: number;
  endedAt: number | null;
  createdAt: number;
  agentCompletedAt: number | null;
  /** Timestamp (ms) of the last message or session update */
  lastMessageAt: number | null;
  /** Computed: true when status === 'active' && agentCompletedAt != null */
  isIdle: boolean;
  /** Computed: true when status === 'stopped' */
  isTerminated: boolean;
  /** Computed: derived from workspaceId + BASE_DOMAIN */
  workspaceUrl: string | null;
}

export interface ChatSessionTaskEmbed {
  id: string;
  status: TaskStatus;
  executionStep: TaskExecutionStep | null;
  errorMessage: string | null;
  outputBranch: string | null;
  outputPrUrl: string | null;
  outputSummary: string | null;
  finalizedAt: string | null;
}

export interface ChatSessionDetail extends ChatSession {
  messages: ChatMessage[];
  hasMoreMessages: boolean;
  task: ChatSessionTaskEmbed | null;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system' | 'tool' | 'thinking' | 'plan';
  content: string;
  toolMetadata: Record<string, unknown> | null;
  createdAt: number;
}

/** Many-to-many link between a chat session and an idea (task). */
export interface SessionIdeaLink {
  sessionId: string;
  taskId: string;
  context: string | null;
  createdAt: number;
}

// =============================================================================
// Activity Events
// =============================================================================

export type ActivityEventType =
  | 'workspace.created'
  | 'workspace.stopped'
  | 'workspace.restarted'
  | 'session.started'
  | 'session.stopped'
  | 'task.status_changed'
  | 'task.created'
  | 'task.delegated';

export type ActivityActorType = 'user' | 'system' | 'agent';

export interface ActivityEvent {
  id: string;
  eventType: ActivityEventType;
  actorType: ActivityActorType;
  actorId: string | null;
  workspaceId: string | null;
  sessionId: string | null;
  taskId: string | null;
  payload: Record<string, unknown> | null;
  createdAt: number;
}

// =============================================================================
// Message Persistence
// =============================================================================

export interface PersistMessageRequest {
  role: 'user' | 'assistant' | 'system' | 'tool' | 'thinking' | 'plan';
  content: string;
  toolMetadata?: Record<string, unknown> | null;
}

// =============================================================================
// Batch Message Persistence (VM Agent → Control Plane)
// =============================================================================

export interface PersistMessageItem {
  messageId: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system' | 'tool' | 'thinking' | 'plan';
  content: string;
  toolMetadata?: Record<string, unknown> | null;
  timestamp: string; // ISO 8601
}

export interface PersistMessageBatchRequest {
  messages: PersistMessageItem[];
}

export interface PersistMessageBatchResponse {
  persisted: number;
  duplicates: number;
}

// =============================================================================
// ProjectData WebSocket Broadcast Events
// =============================================================================

export type ProjectWebSocketEventType =
  | 'message.new'
  | 'session.created'
  | 'session.stopped'
  | 'activity.new';

export interface ProjectWebSocketEvent {
  type: ProjectWebSocketEventType;
  payload: Record<string, unknown>;
}
