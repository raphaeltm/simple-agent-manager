import type {
  SessionAccessSummary,
  SessionViewerAccess,
  TaskExecutionStep,
  WakeWaitReason,
} from '@simple-agent-manager/shared';

// =============================================================================
// Chat Sessions (Project DO)
// =============================================================================

/** Task embed shape — populated in the detail response, added via enrichment for list items. */
export interface ChatSessionTaskEmbed {
  providerLimitReason?: string | null;
  /** Opaque wait generation; changes when a new blocked wait replaces an accepted resume. */
  providerLimitVersion?: string | null;
  /** True while a never-started task waits at admission on a provider limit, so its owner
   * may start it anyway (for example to spend extra credits the limit does not show). */
  providerLimitCanStartAnyway?: boolean;
  triggeredBy?: string;
  connectorClientName?: string | null;
  id: string;
  /** Canonical, user-safe saved placement diagnostics, including queued runs. */
  placementExplanationJson?: string | null;
  status?: string;
  executionStep?: string | null;
  terminalReason?: string | null;
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

/** Session list item, including authoritative task outcome from D1. */
export interface ChatSessionListItem {
  task?: ChatSessionTaskEmbed;
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
    markerId: string;
    kind: string;
    createdAt: number;
    expiresAt: number | null;
    reason: string | null;
    options: string[];
  } | null;
}

/**
 * Enriched session — extends the list item with an optional task embed.
 *
 * This is the type used by components that need to distinguish completed/failed
 * tasks from stopped sessions. The `task` field is populated either by:
 * - The detail API (`GET /api/projects/:id/sessions/:sessionId`)
 * - List API outcome, plus frontend hints from `taskInfoMap` (see SessionTreeItem)
 */
export interface ChatSessionResponse extends ChatSessionListItem {
  task?: ChatSessionTaskEmbed;
  /**
   * What the viewer may do in this session (session detail only). `owner` and `grantee`
   * drive the agent; `reader` can read and comment. Absent on list items and on detail
   * responses cached before shared sessions shipped — see `resolveSessionViewerAccess`.
   */
  viewerAccess?: SessionViewerAccess;
  /** The owner and active shared-access grants (session detail only). */
  access?: SessionAccessSummary;
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
  runtimeWorkState: 'inactive' | 'active' | 'settling' | null;
  runtimeWorkCount: number | null;
  runtimeWorkSource: string | null;
  runtimeWorkUpdatedAt: number | null;
  runtimeWorkProgressAt: number | null;
  /** Whether the session's agent adapter can steer; null until the VM agent reports it. */
  steeringSupported?: boolean | null;
  recoveryStatus?: 'waking' | 'restored' | 'failed' | null;
  /** The wake attempt `recoveryStatus` describes (mirrors the shared snapshot). */
  wakeAttemptId?: string | null;
  /**
   * Execution step of the replacement TaskRunner waking this session. Drives
   * phase-level wake progress; null when no wake is in flight.
   */
  wakePhase?: TaskExecutionStep | null;
  /** Why the wake is waiting, when the server knows (mirrors the shared snapshot). */
  waitReason?: WakeWaitReason | null;
  waitRetryAt?: string | null;
}

export interface ChatSessionDetailResponse {
  toolChanges?: ToolSnapshotChanges;
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
  toolChanges?: ToolSnapshotChanges;
  messages: ChatMessageResponse[];
  hasMore: boolean;
}

export interface ToolSnapshotChanges {
  revision: number;
  floor?: number;
  resetRequired: boolean;
  messages: ChatMessageResponse[];
}
