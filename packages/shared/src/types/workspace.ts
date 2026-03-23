import type { VMSize, VMLocation, WorkspaceProfile } from './common';
import type { CredentialProvider } from './credential';

// =============================================================================
// Workspace
// =============================================================================

export type WorkspaceStatus =
  | 'pending'
  | 'creating'
  | 'running'
  | 'recovery'
  | 'stopping'
  | 'stopped'
  | 'deleted'
  | 'error';

export interface Workspace {
  id: string;
  nodeId?: string;
  userId: string;
  projectId?: string | null;
  installationId: string | null;
  name: string;
  displayName?: string;
  repository: string;
  branch: string;
  status: WorkspaceStatus;
  vmSize: VMSize;
  vmLocation: VMLocation;
  hetznerServerId: string | null;
  vmIp: string | null;
  dnsRecordId: string | null;
  lastActivityAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Boot log entry for workspace provisioning/bootstrap progress */
export interface BootLogEntry {
  step: string;
  status: 'started' | 'completed' | 'failed';
  message: string;
  detail?: string;
  timestamp: string;
}

/** API response (includes computed URL) */
export interface WorkspaceResponse {
  id: string;
  nodeId?: string;
  projectId?: string | null;
  name: string;
  displayName?: string;
  repository: string;
  branch: string;
  status: WorkspaceStatus;
  vmSize: VMSize;
  vmLocation: VMLocation;
  workspaceProfile?: WorkspaceProfile | null;
  vmIp: string | null;
  lastActivityAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  url?: string;
  bootLogs?: BootLogEntry[];
}

export interface CreateWorkspaceRequest {
  name: string;
  projectId: string;
  nodeId?: string;
  repository?: string;
  branch?: string;
  vmSize?: VMSize;
  vmLocation?: VMLocation;
  installationId?: string;
  provider?: CredentialProvider;
}

export interface UpdateWorkspaceRequest {
  displayName: string;
}

export type EventLevel = 'info' | 'warn' | 'error';

export interface Event {
  id: string;
  nodeId?: string | null;
  workspaceId?: string | null;
  level: EventLevel;
  type: string;
  message: string;
  detail?: Record<string, unknown> | null;
  createdAt: string;
}

/** A port detected listening inside a workspace container. */
export interface DetectedPort {
  port: number;
  address: string;
  label: string;
  url: string;
  detectedAt: string;
}

/** Response from GET /workspaces/{id}/ports on the VM agent. */
export interface PortsResponse {
  ports: DetectedPort[];
}

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
// Bootstrap Token (Secure Credential Delivery)
// =============================================================================

/** Internal: Bootstrap token data stored in KV */
export interface BootstrapTokenData {
  workspaceId: string;
  encryptedHetznerToken: string;
  hetznerTokenIv: string;
  callbackToken: string;
  encryptedGithubToken: string | null;
  githubTokenIv: string | null;
  gitUserName?: string | null;
  gitUserEmail?: string | null;
  githubId?: string | null;
  createdAt: string;
}

/** API response when VM redeems bootstrap token */
export interface BootstrapResponse {
  workspaceId: string;
  hetznerToken: string;
  callbackToken: string;
  githubToken: string | null;
  gitUserName?: string | null;
  gitUserEmail?: string | null;
  githubId?: string | null;
  controlPlaneUrl: string;
}

export interface WorkspaceRuntimeEnvVar {
  key: string;
  value: string;
  isSecret: boolean;
}

export interface WorkspaceRuntimeFile {
  path: string;
  content: string;
  isSecret: boolean;
}

export interface WorkspaceRuntimeAssetsResponse {
  workspaceId: string;
  envVars: WorkspaceRuntimeEnvVar[];
  files: WorkspaceRuntimeFile[];
}
