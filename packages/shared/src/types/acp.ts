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
