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
  CredentialValidationStatus,
  GcpCredential,
  GcpCredentialAuthType,
  GcpCredentialMetadata,
  GcpOidcCredential,
  GcpServiceAccountKeyCredential,
  GcpWorkloadIdentityCredential,
  ListPlatformCredentialsResponse,
  PlatformCredential,
  PlatformCredentialResponse,
  PlatformCredentialType,
  ProjectDeploymentCredential,
  ProjectDeploymentCredentialResponse,
  SaveGcpServiceAccountCredentialRequest,
  SetupProjectDeploymentRequest,
  SignupApprovalConfig,
  SignupApprovalConfigResponse,
  SignupApprovalConfigSource,
  UpdatePlatformCredentialRequest,
  UpdateSignupApprovalConfigRequest,
  User,
  UserRole,
  UserStatus,
} from './user';
export { CREDENTIAL_PROVIDERS, GCP_CREDENTIAL_VERSION } from './user';

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

// GitLab
export type { GitLabProject, GitLabProjectListResponse } from './gitlab';

// Repo Browse (remote-branch git browser + diff)
export type {
  RepoBranch,
  RepoBranchesResponse,
  RepoCompareFile,
  RepoCompareFileStatus,
  RepoCompareResponse,
  RepoFileContent,
  RepoTreeEntry,
  RepoTreeResponse,
} from './repo-browse';

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
  NodeContainerListResponse,
  NodeContainerLogTarget,
  NodeHealthStatus,
  NodeClass,
  NodeLifecycleState,
  NodeLifecycleStatus,
  NodeLogEntry,
  NodeLogFilter,
  NodeLogLevel,
  NodeLogResponse,
  NodeLogSource,
  NodeMetrics,
  NodeResponse,
  NodeRole,
  NodeStatus,
  NodeSystemInfo,
  NodeTransport,
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
// Node class runtime guards (value exports, not types)
export { isNodeClass, isUserOwnedNodeClass } from './workspace';
// Provider Catalog
export type { LocationInfo, ProviderCatalog, ProviderCatalogResponse, SizeInfo } from './provider';

// Project
export type {
  AddProjectRepositoryRequest,
  AvailableRepositoriesResponse,
  AvailableRepository,
  CreatedProjectInviteLinkResponse,
  CreateProjectInviteRequest,
  CreateProjectRequest,
  CredentialAttributionCheck,
  CredentialAttributionConsumerKind,
  CredentialAttributionResource,
  CredentialAttributionResourceKind,
  CredentialAttributionSource,
  CredentialAttributionUser,
  DecideProjectAccessRequest,
  ListProjectsResponse,
  Project,
  ProjectAccessRequestResponse,
  ProjectAgentDefaults,
  ProjectCredentialAttributionHealthSummary,
  ProjectDetail,
  ProjectDetailResponse,
  ProjectInviteGithubAccessStatus,
  ProjectInviteLinkResponse,
  ProjectInviteLinkStatus,
  ProjectInvitePreviewResponse,
  ProjectMemberOffboardingAction,
  ProjectMemberOffboardingApplyActionSelection,
  ProjectMemberOffboardingApplyRequest,
  ProjectMemberOffboardingApplyResponse,
  ProjectMemberOffboardingCredentialSource,
  ProjectMemberOffboardingPlanStatus,
  ProjectMemberOffboardingPreviewResponse,
  ProjectMemberOffboardingResourceKind,
  ProjectMemberOffboardingResourcePreview,
  ProjectMemberOffboardingResourceResult,
  ProjectMemberOffboardingResourceStatus,
  ProjectMemberResponse,
  ProjectMemberRole,
  ProjectMembersResponse,
  ProjectMemberStatus,
  ProjectOwnershipTransferRequest,
  ProjectOwnershipTransferResponse,
  ProjectRepository,
  ProjectRepositoryAccessResponse,
  ProjectRepositoryStatus,
  ProjectRuntimeConfigResponse,
  ProjectRuntimeEnvVarResponse,
  ProjectRuntimeFileResponse,
  ProjectStatus,
  ProjectSummary,
  RepoProvider,
  SubmoduleDiscoveryResponse,
  SubmoduleSuggestion,
  UpdateProjectRequest,
  UpsertProjectRuntimeEnvVarRequest,
  UpsertProjectRuntimeFileRequest,
} from './project';
export { ARTIFACTS_DEFAULTS, VALID_REPO_PROVIDERS } from './project';

// Deployment
export type {
  DeploymentEnvironmentConfigResponse,
  DeploymentEnvironmentConfigVarResponse,
  UpsertDeploymentEnvironmentConfigVarRequest,
} from './deployment';

// Task
export type {
  CompletionEvidence,
  CompletionEvidenceVerificationKind,
  CompletionTestRun,
  CompletionVerification,
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
  COMPLETION_EVIDENCE_VERIFICATION_KINDS,
  EXECUTION_STEP_LABELS,
  EXECUTION_STEP_ORDER,
  isTaskExecutionStep,
  isTaskMode,
  isTaskStatus,
  parseCompletionEvidenceJson,
  SAFE_FILENAME_REGEX,
  TASK_EXECUTION_STEPS,
  TASK_MODES,
  TASK_STATUSES,
  validateCompletionEvidence,
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
  AllChatsResponse,
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
  PlanEntry,
  ProjectWebSocketEvent,
  ProjectWebSocketEventType,
  RecentChatsResponse,
  RemoveWorktreeResponse,
  SessionIdeaLink,
  SessionStateSnapshot,
  SessionSummary,
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
export type { ActivityActorType, ActivityEvent, ActivityEventType } from './activity';

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
export { NOTIFICATION_CHANNELS, NOTIFICATION_TYPES, NOTIFICATION_URGENCIES } from './notification';

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
  AgentEffort,
  AgentPermissionMode,
  AgentProfile,
  AgentProfileRuntime,
  AgentProviderMode,
  AgentSettings,
  AgentSettingsResponse,
  AgentSkill,
  CreateAgentProfileRequest,
  CreateSkillRequest,
  GitHubCliContentsPermissionLevel,
  GitHubCliPermissionLevel,
  GitHubCliPolicy,
  GitHubCliPolicyMode,
  GitHubCliPolicyPermissions,
  OpenCodeProvider,
  OpenCodeProviderMeta,
  ResolvedAgentProfile,
  ResolvedSkillProfile,
  SaveAgentSettingsRequest,
  UpdateAgentProfileRequest,
  UpdateSkillRequest,
} from './agent-settings';
export {
  AGENT_EFFORT_LEVELS,
  AGENT_PROFILE_RUNTIMES,
  DEFAULT_AGENT_EFFORT,
  DEFAULT_GITHUB_CLI_POLICY,
  DEFAULT_OPENCODE_GO_MODEL,
  DEFAULT_OPENCODE_PROVIDER,
  DEFAULT_OPENCODE_ZEN_MODEL,
  getSupportedEffortsForAgent,
  GITHUB_CLI_POLICY_PERMISSION_KEYS,
  isAgentEffort,
  isAgentEffortSupported,
  isAgentProfileRuntime,
  OPENCODE_PROVIDER_OPTIONS,
  OPENCODE_PROVIDERS,
  resolveOpenCodeProvider,
  VALID_AGENT_PROVIDER_MODES,
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
  CreateGitHubTriggerRequest,
  CreateTriggerRequest,
  CreateTriggerResponse,
  CronTemplateContext,
  CronValidationResult,
  GitHubTemplateContext,
  GitHubTriggerConfig,
  GitHubTriggerEventType,
  GitHubTriggerFilters,
  ListTriggerExecutionsResponse,
  ListTriggersResponse,
  ListWebhookDeliveriesResponse,
  RunTriggerRequest,
  Trigger,
  TriggeredBy,
  TriggerExecution,
  TriggerExecutionResponse,
  TriggerExecutionStatus,
  TriggerPreviewRequest,
  TriggerPreviewResponse,
  TriggerResponse,
  TriggerSkipReason,
  TriggerSourceType,
  TriggerStatus,
  UpdateTriggerRequest,
  WebhookCredential,
  WebhookDelivery,
  WebhookDeliveryOutcome,
  WebhookFilterMode,
  WebhookFilterOperator,
  WebhookFilterResult,
  WebhookTemplateContext,
  WebhookTriggerConfig,
  WebhookTriggerConfigInput,
  WebhookTriggerFilter,
} from './trigger';
export {
  GITHUB_TRIGGER_EVENT_TYPES,
  TRIGGER_EXECUTION_STATUSES,
  TRIGGER_SKIP_REASONS,
  TRIGGER_SOURCE_TYPES,
  TRIGGER_STATUSES,
  TRIGGERED_BY_VALUES,
  WEBHOOK_DELIVERY_OUTCOMES,
  WEBHOOK_FILTER_MODES,
  WEBHOOK_FILTER_OPERATORS,
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

// Agent Mailbox (Durable Messaging)
export type {
  AckMessageRequest,
  AckMessageResponse,
  AgentMailboxMessage,
  DeliveryState,
  GetPendingMessagesResponse,
  ListMailboxResponse,
  MessageClass,
  SendDurableMessageRequest,
  SendDurableMessageResponse,
  SenderType,
} from './mailbox';
export {
  DELIVERY_STATE_TRANSITIONS,
  DELIVERY_STATES,
  DELIVERY_TERMINAL_STATES,
  DURABLE_MESSAGE_CLASSES,
  MAILBOX_DEFAULTS,
  MESSAGE_CLASSES,
  SENDER_TYPES,
} from './mailbox';

// Mission (Phase 2: Orchestration Primitives)
export type {
  CreateMissionRequest,
  HandoffArtifactRef,
  HandoffFact,
  HandoffPacket,
  Mission,
  MissionBudgetConfig,
  MissionStateEntry,
  MissionStateEntryType,
  MissionStatus,
  MissionTaskSummary,
  MissionWithTasks,
  PublishHandoffRequest,
  PublishMissionStateRequest,
  SchedulerState,
} from './mission';
export {
  isMissionStateEntryType,
  isMissionStatus,
  isSchedulerState,
  MISSION_STATE_ENTRY_TYPES,
  MISSION_STATUSES,
  SCHEDULER_STATES,
} from './mission';

// Orchestrator (Phase 3: Project Orchestrator)
export type {
  DecisionAction,
  DecisionLogEntry,
  OrchestratorMissionEntry,
  OrchestratorStatus,
  OverrideTaskStateRequest,
  SchedulingQueueEntry,
  TaskEventNotification,
  TaskEventType,
} from './orchestrator';
export { DECISION_ACTIONS, OVERRIDABLE_SCHEDULER_STATES } from './orchestrator';

// Project Policy (Phase 4: Policy Propagation)
export type {
  CreatePolicyRequest,
  ListPoliciesResponse,
  PolicyCategory,
  PolicySource,
  ProjectPolicy,
  UpdatePolicyRequest,
} from './policy';
export {
  isPolicyCategory,
  isPolicySource,
  POLICY_CATEGORIES,
  POLICY_DEFAULTS,
  POLICY_SOURCES,
} from './policy';

// User AI Usage
export type {
  AdminAiAllowance,
  AdminAiAllowanceResponse,
  UpdateAdminAiAllowanceRequest,
  UpdateAiBudgetRequest,
  UserAiBudgetResponse,
  UserAiBudgetSettings,
  UserAiUsageByDay,
  UserAiUsageByModel,
  UserAiUsageByProvider,
  UserAiUsageResponse,
} from './ai-usage';

// API Error
export type { ApiError } from './api-error';

// Sandbox Agent
export type {
  SandboxAgentConfig,
  SandboxExecResult,
  SandboxFileListResult,
  SandboxFileReadResult,
} from './sandbox';

// Resource Requirements & Reservations
export type {
  PlacementExplanation,
  ResolvedResourceReservation,
  ResourceRequirements,
  ResourceRequirementsSource,
  ResourceResolutionInput,
} from './resource';
