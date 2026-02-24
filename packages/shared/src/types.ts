// =============================================================================
// User
// =============================================================================
export type UserRole = 'superadmin' | 'admin' | 'user';
export type UserStatus = 'active' | 'pending' | 'suspended';

export interface User {
  id: string;
  githubId: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
}

// =============================================================================
// Admin User Management
// =============================================================================
export interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
}

export interface AdminUsersResponse {
  users: AdminUser[];
}

export interface AdminUserActionRequest {
  action: 'approve' | 'suspend';
}

export interface AdminUserRoleRequest {
  role: Exclude<UserRole, 'superadmin'>;
}

// =============================================================================
// Credential
// =============================================================================
export type CredentialProvider = 'hetzner';

export interface Credential {
  id: string;
  userId: string;
  provider: CredentialProvider;
  encryptedToken: string;
  iv: string;
  createdAt: string;
  updatedAt: string;
}

/** API response (safe to expose - no encrypted data) */
export interface CredentialResponse {
  id: string;
  provider: CredentialProvider;
  connected: boolean;
  createdAt: string;
}

export interface CreateCredentialRequest {
  provider: CredentialProvider;
  token: string;
}

// =============================================================================
// GitHub Installation
// =============================================================================
export type AccountType = 'personal' | 'organization';

export interface GitHubInstallation {
  id: string;
  userId: string;
  installationId: string;
  accountType: AccountType;
  accountName: string;
  createdAt: string;
  updatedAt: string;
}

export interface Repository {
  id: number;
  fullName: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  installationId: string;
}

export interface Branch {
  name: string;
  isDefault: boolean;
}

/** GitHub repository returned from GitHub API */
export interface GitHubRepository {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  description: string | null;
}

/** GitHub installation token */
export interface GitHubInstallationToken {
  token: string;
  expiresAt: string;
  repositories: string[];
  permissions: {
    contents?: string;
  };
}

/** GitHub connection status */
export interface GitHubConnection {
  installationId: number;
  accountLogin: string;
  accountType: 'User' | 'Organization';
  installedAt: string;
  repositories: string[];
  status: 'active' | 'suspended' | 'pending';
  lastTokenAt: string | null;
}

// =============================================================================
// Projects & Tasks
// =============================================================================

export interface Project {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  installationId: string;
  repository: string;
  defaultBranch: string;
  defaultVmSize?: VMSize | null;
  status?: ProjectStatus;
  createdAt: string;
  updatedAt: string;
}

export type ProjectStatus = 'active' | 'detached';

export type ChatSessionStatus = 'active' | 'stopped' | 'error';

export interface ProjectSummary {
  id: string;
  name: string;
  repository: string;
  githubRepoId: number | null;
  defaultBranch: string;
  status: ProjectStatus;
  activeWorkspaceCount: number;
  activeSessionCount: number;
  lastActivityAt: string | null;
  createdAt: string;
  taskCountsByStatus: Partial<Record<TaskStatus, number>>;
  linkedWorkspaces: number;
}

export interface ProjectDetail extends Project {
  githubRepoId: number | null;
  githubRepoNodeId: string | null;
  status: ProjectStatus;
  lastActivityAt: string | null;
  activeSessionCount: number;
  workspaces: WorkspaceResponse[];
  recentSessions: ChatSession[];
  recentActivity: ActivityEvent[];
}

export interface ProjectDetailResponse extends Project {
  summary: Omit<ProjectSummary, 'id' | 'name' | 'repository' | 'githubRepoId' | 'defaultBranch' | 'status' | 'createdAt'>;
}

export interface ChatSession {
  id: string;
  workspaceId: string | null;
  topic: string | null;
  status: ChatSessionStatus;
  messageCount: number;
  startedAt: number;
  endedAt: number | null;
  createdAt: number;
}

export interface ChatSessionDetail extends ChatSession {
  messages: ChatMessage[];
  hasMoreMessages: boolean;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolMetadata: {
    tool: string;
    target: string;
    status: 'success' | 'error';
  } | null;
  createdAt: number;
}

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

export interface PersistMessageRequest {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolMetadata?: {
    tool: string;
    target: string;
    status: 'success' | 'error';
  } | null;
}

export interface CreateProjectRequest {
  name: string;
  description?: string;
  installationId: string;
  repository: string;
  githubRepoId?: number;
  githubRepoNodeId?: string;
  defaultBranch: string;
}

export interface UpdateProjectRequest {
  name?: string;
  description?: string;
  defaultBranch?: string;
  defaultVmSize?: VMSize | null;
}

export interface ProjectRuntimeEnvVarResponse {
  key: string;
  value: string | null;
  isSecret: boolean;
  hasValue: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertProjectRuntimeEnvVarRequest {
  key: string;
  value: string;
  isSecret?: boolean;
}

export interface ProjectRuntimeFileResponse {
  path: string;
  content: string | null;
  isSecret: boolean;
  hasValue: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertProjectRuntimeFileRequest {
  path: string;
  content: string;
  isSecret?: boolean;
}

export interface ProjectRuntimeConfigResponse {
  envVars: ProjectRuntimeEnvVarResponse[];
  files: ProjectRuntimeFileResponse[];
}

export type TaskStatus =
  | 'draft'
  | 'ready'
  | 'queued'
  | 'delegated'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type TaskActorType = 'user' | 'system' | 'workspace_callback';

export type TaskSortOrder = 'createdAtDesc' | 'updatedAtDesc' | 'priorityDesc';

export interface Task {
  id: string;
  projectId: string;
  userId: string;
  parentTaskId: string | null;
  workspaceId: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: number;
  agentProfileHint: string | null;
  blocked?: boolean;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  outputSummary: string | null;
  outputBranch: string | null;
  outputPrUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskDependency {
  taskId: string;
  dependsOnTaskId: string;
  createdAt: string;
}

export interface TaskStatusEvent {
  id: string;
  taskId: string;
  fromStatus: TaskStatus | null;
  toStatus: TaskStatus;
  actorType: TaskActorType;
  actorId: string | null;
  reason: string | null;
  createdAt: string;
}

export interface TaskDetailResponse extends Task {
  dependencies: TaskDependency[];
  blocked: boolean;
}

export interface CreateTaskRequest {
  title: string;
  description?: string;
  priority?: number;
  parentTaskId?: string;
  agentProfileHint?: string;
}

export interface UpdateTaskRequest {
  title?: string;
  description?: string;
  priority?: number;
  parentTaskId?: string | null;
}

export interface UpdateTaskStatusRequest {
  toStatus: TaskStatus;
  reason?: string;
  outputSummary?: string;
  outputBranch?: string;
  outputPrUrl?: string;
  errorMessage?: string;
}

export interface CreateTaskDependencyRequest {
  dependsOnTaskId: string;
}

export interface DelegateTaskRequest {
  workspaceId: string;
}

export interface RunTaskRequest {
  vmSize?: VMSize;
  vmLocation?: VMLocation;
  nodeId?: string;
  branch?: string;
}

export interface RunTaskResponse {
  taskId: string;
  status: TaskStatus;
  workspaceId: string | null;
  nodeId: string | null;
  autoProvisionedNode: boolean;
}

export interface ListProjectsResponse {
  projects: Project[];
  nextCursor?: string | null;
}

export interface ListTasksResponse {
  tasks: Task[];
  nextCursor?: string | null;
}

export interface ListTaskEventsResponse {
  events: TaskStatusEvent[];
}

// =============================================================================
// Workspace
// =============================================================================
export type NodeStatus = 'pending' | 'creating' | 'running' | 'stopping' | 'stopped' | 'error';

export type NodeHealthStatus = 'healthy' | 'stale' | 'unhealthy';

export type WorkspaceStatus =
  | 'pending'
  | 'creating'
  | 'running'
  | 'recovery'
  | 'stopping'
  | 'stopped'
  | 'error';

export type VMSize = 'small' | 'medium' | 'large';

export type VMLocation = 'nbg1' | 'fsn1' | 'hel1';

export interface Node {
  id: string;
  userId: string;
  name: string;
  status: NodeStatus;
  healthStatus?: NodeHealthStatus;
  vmSize: VMSize;
  vmLocation: VMLocation;
  providerInstanceId: string | null;
  ipAddress: string | null;
  lastHeartbeatAt: string | null;
  heartbeatStaleAfterSeconds?: number;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Lightweight metrics from node heartbeat (stored in D1) */
export interface NodeMetrics {
  cpuLoadAvg1?: number;
  memoryPercent?: number;
  diskPercent?: number;
}

export interface NodeResponse {
  id: string;
  name: string;
  status: NodeStatus;
  healthStatus?: NodeHealthStatus;
  vmSize: VMSize;
  vmLocation: VMLocation;
  ipAddress: string | null;
  lastHeartbeatAt: string | null;
  heartbeatStaleAfterSeconds?: number;
  lastMetrics?: NodeMetrics | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Full system info from on-demand VM Agent endpoint */
export interface NodeSystemInfo {
  cpu: {
    loadAvg1: number;
    loadAvg5: number;
    loadAvg15: number;
    numCpu: number;
  };
  memory: {
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
    usedPercent: number;
  };
  disk: {
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
    usedPercent: number;
    mountPath: string;
  };
  network: {
    interface: string;
    rxBytes: number;
    txBytes: number;
  };
  uptime: {
    seconds: number;
    humanFormat: string;
  };
  docker: {
    version: string;
    containers: number;
    containerList: ContainerInfo[];
    error?: string | null;
  };
  software: {
    goVersion: string;
    nodeVersion: string;
    dockerVersion: string;
    devcontainerCliVersion: string;
  };
  agent: {
    version: string;
    buildDate: string;
    goRuntime: string;
    goroutines: number;
    heapBytes: number;
  };
}

export interface CreateNodeRequest {
  name: string;
  vmSize?: VMSize;
  vmLocation?: VMLocation;
}

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
  projectId?: string;
  nodeId?: string;
  repository?: string;
  branch?: string;
  vmSize?: VMSize;
  vmLocation?: VMLocation;
  installationId?: string;
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

// =============================================================================
// Node Observability — Log Types
// =============================================================================

/** Log entry from any source on the node */
export interface NodeLogEntry {
  timestamp: string; // ISO 8601
  level: NodeLogLevel;
  source: string; // e.g., "agent", "docker:ws-abc", "cloud-init"
  message: string;
  metadata?: Record<string, unknown>;
}

/** Log source filter values */
export type NodeLogSource = 'all' | 'agent' | 'cloud-init' | 'docker' | 'systemd';

/** Log level filter values */
export type NodeLogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Parameters for log retrieval */
export interface NodeLogFilter {
  source?: NodeLogSource;
  level?: NodeLogLevel;
  container?: string;
  since?: string;
  until?: string;
  search?: string;
  cursor?: string;
  limit?: number;
}

/** Response from log retrieval endpoint */
export interface NodeLogResponse {
  entries: NodeLogEntry[];
  nextCursor?: string | null;
  hasMore: boolean;
}

// =============================================================================
// Node Observability — Container Types
// =============================================================================

/** Machine-readable container state */
export type ContainerState =
  | 'running'
  | 'exited'
  | 'paused'
  | 'created'
  | 'restarting'
  | 'removing'
  | 'dead';

/** Container info with full state and metrics */
export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  status: string; // Human-readable (e.g., "Up 2 hours")
  state: ContainerState; // Machine-readable enum
  cpuPercent: number;
  memUsage: string;
  memPercent: number;
  createdAt: string;
}

// =============================================================================
// API Error
// =============================================================================
export interface ApiError {
  error: string;
  message: string;
  details?: Record<string, unknown>;
}

// =============================================================================
// Agent Settings (per-user, per-agent configuration)
// =============================================================================

/** Valid permission modes for agent sessions */
export type AgentPermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'dontAsk'
  | 'bypassPermissions';

/** Agent settings stored per-user, per-agent in D1 */
export interface AgentSettings {
  id: string;
  agentType: string;
  model: string | null;
  permissionMode: AgentPermissionMode | null;
  allowedTools: string[] | null;
  deniedTools: string[] | null;
  additionalEnv: Record<string, string> | null;
  createdAt: string;
  updatedAt: string;
}

/** API response for GET /api/agent-settings/:agentType */
export interface AgentSettingsResponse {
  agentType: string;
  model: string | null;
  permissionMode: AgentPermissionMode | null;
  allowedTools: string[] | null;
  deniedTools: string[] | null;
  additionalEnv: Record<string, string> | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Request body for PUT /api/agent-settings/:agentType */
export interface SaveAgentSettingsRequest {
  model?: string | null;
  permissionMode?: AgentPermissionMode | null;
  allowedTools?: string[] | null;
  deniedTools?: string[] | null;
  additionalEnv?: Record<string, string> | null;
}
