// Types barrel — named re-exports only (no `export *`)

// User & Credentials
export type {
  AdminUser,
  AdminUserActionRequest,
  AdminUserRoleRequest,
  AdminUsersResponse,
  CreateCredentialRequest,
  Credential,
  CredentialProvider,
  CredentialResponse,
  GcpOidcCredential,
  ProjectDeploymentCredential,
  ProjectDeploymentCredentialResponse,
  SetupProjectDeploymentRequest,
  User,
  UserRole,
  UserStatus,
} from './user';
export { CREDENTIAL_PROVIDERS } from './user';

// GitHub
export type {
  AccountType,
  Branch,
  GitHubConnection,
  GitHubInstallation,
  GitHubInstallationToken,
  GitHubRepository,
  Repository,
  RepositoryListResponse,
} from './github';

// Workspace & Node
export type {
  BootLogEntry,
  BootstrapResponse,
  BootstrapTokenData,
  BrowserSidecarPortInfo,
  BrowserSidecarPortsResponse,
  BrowserSidecarResponse,
  BrowserSidecarStatus,
  ContainerInfo,
  ContainerState,
  CreateNodeRequest,
  CreateWorkspaceRequest,
  DetectedPort,
  Event,
  EventLevel,
  Node,
  NodeHealthStatus,
  NodeLifecycleState,
  NodeLifecycleStatus,
  NodeLogEntry,
  NodeLogFilter,
  NodeLogLevel,
  NodeLogResponse,
  NodeLogSource,
  NodeMetrics,
  NodeResponse,
  NodeStatus,
  NodeSystemInfo,
  PortsResponse,
  SidecarAlias,
  StartBrowserSidecarRequest,
  UpdateWorkspaceRequest,
  VMLocation,
  VMSize,
  Workspace,
  WorkspaceProfile,
  WorkspaceResponse,
  WorkspaceRuntimeAssetsResponse,
  WorkspaceRuntimeEnvVar,
  WorkspaceRuntimeFile,
  WorkspaceStatus,
} from './workspace';
export { isSidecarAlias, SIDECAR_ALIASES } from './workspace';

// Provider Catalog
export type {
  LocationInfo,
  ProviderCatalog,
  ProviderCatalogResponse,
  SizeInfo,
} from './provider';

// Project
export type {
  CreateProjectRequest,
  ListProjectsResponse,
  Project,
  ProjectDetail,
  ProjectDetailResponse,
  ProjectRuntimeConfigResponse,
  ProjectRuntimeEnvVarResponse,
  ProjectRuntimeFileResponse,
  ProjectStatus,
  ProjectSummary,
  UpdateProjectRequest,
  UpsertProjectRuntimeEnvVarRequest,
  UpsertProjectRuntimeFileRequest,
} from './project';

// Task
export type {
  CreateTaskDependencyRequest,
  CreateTaskRequest,
  DashboardActiveTasksResponse,
  DashboardTask,
  DelegateTaskRequest,
  GitPushResult,
  ListTaskEventsResponse,
  ListTasksResponse,
  RequestAttachmentUploadRequest,
  RequestAttachmentUploadResponse,
  RunTaskRequest,
  RunTaskResponse,
  SessionSummaryResponse,
  SubmitTaskRequest,
  SubmitTaskResponse,
  Task,
  TaskActorType,
  TaskAttachment,
  TaskDependency,
  TaskDetailResponse,
  TaskExecutionStep,
  TaskMode,
  TaskSortOrder,
  TaskStatus,
  TaskStatusEvent,
  UpdateTaskRequest,
  UpdateTaskStatusRequest,
} from './task';
export {
  ATTACHMENT_DEFAULTS,
  EXECUTION_STEP_LABELS,
  EXECUTION_STEP_ORDER,
  isTaskExecutionStep,
  isTaskStatus,
  SAFE_FILENAME_REGEX,
  TASK_EXECUTION_STEPS,
  TASK_STATUSES,
} from './task';

// Session (Chat, Agent, ACP)
export type {
  AcpSession,
  AcpSessionAssignRequest,
  AcpSessionEvent,
  AcpSessionEventActorType,
  AcpSessionForkRequest,
  AcpSessionHeartbeatRequest,
  AcpSessionLineageResponse,
  AcpSessionStatus,
  AcpSessionStatusReport,
  AgentHostStatus,
  AgentSession,
  AgentSessionStatus,
  ChatMessage,
  ChatSession,
  ChatSessionDetail,
  ChatSessionStatus,
  ChatSessionTaskEmbed,
  CreateAgentSessionRequest,
  CreateWorktreeRequest,
  GitBranchListResponse,
  PersistMessageBatchRequest,
  PersistMessageBatchResponse,
  PersistMessageItem,
  PersistMessageRequest,
  ProjectWebSocketEvent,
  ProjectWebSocketEventType,
  RemoveWorktreeResponse,
  SessionIdeaLink,
  TerminalTokenRequest,
  TerminalTokenResponse,
  UpdateAgentSessionRequest,
  WorkspaceTab,
  WorktreeInfo,
  WorktreeListResponse,
} from './session';
export {
  ACP_SESSION_DEFAULTS,
  ACP_SESSION_TERMINAL_STATUSES,
  ACP_SESSION_VALID_TRANSITIONS,
} from './session';

// Activity
export type {
  ActivityActorType,
  ActivityEvent,
  ActivityEventType,
} from './activity';

// Notification
export type {
  CreateNotificationRequest,
  ListNotificationsResponse,
  NotificationChannel,
  NotificationPreference,
  NotificationPreferencesResponse,
  NotificationResponse,
  NotificationType,
  NotificationUrgency,
  NotificationWsMessage,
  UpdateNotificationPreferenceRequest,
} from './notification';
export {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_TYPES,
  NOTIFICATION_URGENCIES,
} from './notification';

// Admin Observability
export type {
  AdminLogEntry,
  ErrorListResponse,
  ErrorTrendBucket,
  ErrorTrendResponse,
  HealthSummary,
  LogQueryParams,
  LogQueryResponse,
  LogStreamClientMessage,
  LogStreamClientMessageType,
  LogStreamMessage,
  LogStreamMessageType,
  PlatformError,
  PlatformErrorLevel,
  PlatformErrorSource,
} from './admin';

// Agent Settings & Profiles
export type {
  AgentPermissionMode,
  AgentProfile,
  AgentSettings,
  AgentSettingsResponse,
  CreateAgentProfileRequest,
  ResolvedAgentProfile,
  SaveAgentSettingsRequest,
  UpdateAgentProfileRequest,
} from './agent-settings';

// Orchestration (Parent ↔ Child Agent Communication)
export type {
  SendMessageToSubtaskRequest,
  SendMessageToSubtaskResponse,
  StopSubtaskRequest,
  StopSubtaskResponse,
} from './orchestration';

// API Error
export type { ApiError } from './api-error';
