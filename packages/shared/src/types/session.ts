import type { TaskExecutionStep, TaskStatus } from './task';

// =============================================================================
// Chat Sessions
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

// =============================================================================
// Agent Sessions
// =============================================================================

export type AgentSessionStatus = 'running' | 'suspended' | 'stopped' | 'error';

/** Live host status from the VM Agent's SessionHost (more granular than AgentSessionStatus). */
export type AgentHostStatus = 'idle' | 'starting' | 'ready' | 'prompting' | 'error' | 'stopped';

export interface WorktreeInfo {
  path: string;
  branch: string;
  headCommit: string;
  isPrimary: boolean;
  isDirty: boolean;
  dirtyFileCount: number;
  isPrunable?: boolean;
}

export interface WorktreeListResponse {
  worktrees: WorktreeInfo[];
}

export interface CreateWorktreeRequest {
  branch: string;
  createBranch?: boolean;
  baseBranch?: string;
}

export interface RemoveWorktreeResponse {
  removed: string;
}

export interface GitBranchListResponse {
  branches: Array<{ name: string }>;
}

export interface AgentSession {
  id: string;
  workspaceId: string;
  status: AgentSessionStatus;
  createdAt: string;
  updatedAt: string;
  stoppedAt?: string | null;
  suspendedAt?: string | null;
  errorMessage?: string | null;
  label?: string | null;
  /** Selected agent type (e.g., 'claude-code', 'openai-codex'). Persisted so the
   *  correct agent is restored after a page refresh. */
  agentType?: string | null;
  worktreePath?: string | null;
  /** Last user message for session discoverability in history UI. */
  lastPrompt?: string | null;
  /** Live host status from the VM Agent SessionHost (only present in live/enriched responses). */
  hostStatus?: AgentHostStatus | null;
  /** Number of connected browser viewers (only present in live/enriched responses). */
  viewerCount?: number | null;
}

export interface CreateAgentSessionRequest {
  label?: string;
  agentType?: string;
  worktreePath?: string;
}

export interface UpdateAgentSessionRequest {
  label: string;
}

// =============================================================================
// Terminal
// =============================================================================
export interface TerminalTokenRequest {
  workspaceId: string;
}

export interface TerminalTokenResponse {
  token: string;
  expiresAt: string;
  workspaceUrl?: string;
}

// =============================================================================
// Workspace Tabs (Persisted Session State)
// =============================================================================

/** A persisted workspace tab (terminal or chat session) from the VM agent. */
export interface WorkspaceTab {
  id: string;
  workspaceId: string;
  type: 'terminal' | 'chat';
  label: string;
  agentId: string;
  sortOrder: number;
  createdAt: string;
}

// =============================================================================
// ACP Session (DO-Owned Lifecycle — Spec 027)
// =============================================================================

export type AcpSessionStatus =
  | 'pending'
  | 'assigned'
  | 'running'
  | 'completed'
  | 'failed'
  | 'interrupted';

export const ACP_SESSION_TERMINAL_STATUSES: readonly AcpSessionStatus[] = [
  'completed',
  'failed',
  'interrupted',
] as const;

/** Valid state machine transitions for ACP sessions. */
export const ACP_SESSION_VALID_TRANSITIONS: Record<AcpSessionStatus, readonly AcpSessionStatus[]> = {
  pending: ['assigned'],
  assigned: ['running', 'failed', 'interrupted'],
  running: ['completed', 'failed', 'interrupted'],
  completed: [],
  failed: [],
  interrupted: [],
} as const;

export interface AcpSession {
  id: string;
  chatSessionId: string;
  workspaceId: string | null;
  nodeId: string | null;
  acpSdkSessionId: string | null;
  parentSessionId: string | null;
  status: AcpSessionStatus;
  agentType: string | null;
  initialPrompt: string | null;
  errorMessage: string | null;
  lastHeartbeatAt: number | null;
  forkDepth: number;
  createdAt: number;
  updatedAt: number;
  assignedAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  interruptedAt: number | null;
}

export type AcpSessionEventActorType = 'system' | 'vm-agent' | 'user' | 'alarm';

export interface AcpSessionEvent {
  id: string;
  acpSessionId: string;
  fromStatus: AcpSessionStatus | null;
  toStatus: AcpSessionStatus;
  actorType: AcpSessionEventActorType;
  actorId: string | null;
  reason: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: number;
}

/** Default configurable values for ACP session lifecycle (overridable via env vars). */
export const ACP_SESSION_DEFAULTS = {
  /** VM agent heartbeat frequency (ms). Env: ACP_SESSION_HEARTBEAT_INTERVAL_MS */
  HEARTBEAT_INTERVAL_MS: 60_000,
  /** DO heartbeat timeout before marking interrupted (ms). Env: ACP_SESSION_DETECTION_WINDOW_MS */
  DETECTION_WINDOW_MS: 300_000,
  /** VM agent startup reconciliation timeout (ms). Env: ACP_SESSION_RECONCILIATION_TIMEOUT_MS */
  RECONCILIATION_TIMEOUT_MS: 30_000,
  /** Messages to include in fork context summary. Env: ACP_SESSION_FORK_CONTEXT_MESSAGES */
  FORK_CONTEXT_MESSAGES: 20,
  /** Maximum fork chain length. Env: ACP_SESSION_MAX_FORK_DEPTH */
  MAX_FORK_DEPTH: 10,
} as const;

export interface AcpSessionForkRequest {
  contextSummary: string;
}

export interface AcpSessionAssignRequest {
  workspaceId: string;
  nodeId: string;
}

export interface AcpSessionStatusReport {
  status: 'running' | 'completed' | 'failed';
  acpSdkSessionId?: string;
  errorMessage?: string;
  nodeId: string;
}

export interface AcpSessionHeartbeatRequest {
  nodeId: string;
  acpSdkSessionId?: string;
}

export interface AcpSessionLineageResponse {
  sessions: AcpSession[];
}
