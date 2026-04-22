// Types barrel — named re-exports only (no `export *`)

// User & Credentials
export type {
  AdminUser,
  AdminUserActionRequest,
  AdminUserRoleRequest,
  AdminUsersResponse,
  CreateCredentialRequest,
  CreatePlatformCredentialRequest,
  Credential,
  CredentialProvider,
  CredentialResponse,
  CredentialSource,
  GcpOidcCredential,
  ListPlatformCredentialsResponse,
  PlatformCredential,
  PlatformCredentialResponse,
  PlatformCredentialType,
  ProjectDeploymentCredential,
  ProjectDeploymentCredentialResponse,
  SetupProjectDeploymentRequest,
  UpdatePlatformCredentialRequest,
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
  ProjectAgentDefaults,
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
  TaskTriggerExecutionInfo,
  TaskTriggerInfo,
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
  AdminPlatformInfraResponse,
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
  PlatformInfraAssociationReason,
  PlatformInfraNodeAssociation,
  PlatformInfraNodeSummary,
  PlatformInfraTrialSummary,
  PlatformInfraUserOption,
  UpsertPlatformInfraAssociationRequest,
} from './admin';

// Agent Settings & Profiles
export type {
  AgentPermissionMode,
  AgentProfile,
  AgentSettings,
  AgentSettingsResponse,
  CreateAgentProfileRequest,
  OpenCodeProvider,
  OpenCodeProviderMeta,
  ResolvedAgentProfile,
  SaveAgentSettingsRequest,
  UpdateAgentProfileRequest,
} from './agent-settings';
export {
  OPENCODE_PROVIDER_OPTIONS,
  OPENCODE_PROVIDERS,
} from './agent-settings';

// Orchestration (agent-to-agent communication)
export type {
  AddDependencyRequest,
  AddDependencyResponse,
  RemovePendingSubtaskRequest,
  RemovePendingSubtaskResponse,
  RetrySubtaskRequest,
  RetrySubtaskResponse,
} from './orchestration';

// Project File Library
export type {
  CreateFileRequest,
  DirectoryEntry,
  FileEncryptionMetadata,
  FileMetadataResponse,
  FileStatus,
  FileTagSource,
  FileUploadSource,
  ListDirectoriesRequest,
  ListFilesRequest,
  ListFilesResponse,
  MoveFileRequest,
  ProjectFile,
  ProjectFileTag,
  ReplaceFileRequest,
  UpdateTagsRequest,
} from './library';
export {
  buildLibraryR2Key,
  LIBRARY_DEFAULTS,
  LIBRARY_DIRECTORY_SEGMENT_PATTERN,
  LIBRARY_FILENAME_PATTERN,
  LIBRARY_TAG_PATTERN,
  validateDirectoryPath,
} from './library';

// Triggers (Event-Driven Agent Triggers)
export type {
  CreateTriggerRequest,
  CronTemplateContext,
  CronValidationResult,
  ListTriggerExecutionsResponse,
  ListTriggersResponse,
  Trigger,
  TriggeredBy,
  TriggerExecution,
  TriggerExecutionResponse,
  TriggerExecutionStatus,
  TriggerResponse,
  TriggerSkipReason,
  TriggerSourceType,
  TriggerStatus,
  UpdateTriggerRequest,
} from './trigger';
export {
  TRIGGER_EXECUTION_STATUSES,
  TRIGGER_SKIP_REASONS,
  TRIGGER_SOURCE_TYPES,
  TRIGGER_STATUSES,
  TRIGGERED_BY_VALUES,
} from './trigger';

// Compute Usage
export type {
  ActiveComputeSession,
  AdminComputeUsageResponse,
  AdminNodeUsageResponse,
  AdminUserDetailedUsage,
  AdminUserNodeDetailedUsage,
  AdminUserNodeUsageSummary,
  AdminUserUsageSummary,
  ComputeUsagePeriod,
  ComputeUsageRecord,
  ComputeUsageResponse,
  NodeUsageRecord,
} from './compute-usage';

// Compute Quotas
export type {
  AdminDefaultQuotaResponse,
  AdminUserQuotasListResponse,
  AdminUserQuotaSummary,
  AdminUserResolvedQuota,
  QuotaSource,
  UserQuotaStatusResponse,
} from './compute-quotas';

// Knowledge Graph
export type {
  AddObservationRequest,
  CreateKnowledgeEntityRequest,
  KnowledgeEntity,
  KnowledgeEntityDetail,
  KnowledgeEntityType,
  KnowledgeObservation,
  KnowledgeRelation,
  KnowledgeRelationType,
  KnowledgeSourceType,
  ListKnowledgeEntitiesResponse,
  SearchKnowledgeResponse,
  UpdateKnowledgeEntityRequest,
  UpdateObservationRequest,
} from './knowledge';
export {
  KNOWLEDGE_DEFAULTS,
  KNOWLEDGE_ENTITY_TYPES,
  KNOWLEDGE_RELATION_TYPES,
  KNOWLEDGE_SOURCE_TYPES,
} from './knowledge';

// API Error
export type { ApiError } from './api-error';
