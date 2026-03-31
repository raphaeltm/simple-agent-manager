export { jsonValidator, parseOptionalBody } from './_validator';
export type { ValidatedBody } from './_validator';

// Task schemas
export {
  SubmitTaskSchema,
  CreateTaskSchema,
  UpdateTaskSchema,
  UpdateTaskStatusSchema,
  CreateTaskDependencySchema,
  DelegateTaskSchema,
  RunTaskSchema,
  RequestAttachmentUploadSchema,
} from './tasks';

// Project schemas
export {
  CreateProjectSchema,
  UpdateProjectSchema,
  UpsertProjectRuntimeEnvVarSchema,
  UpsertProjectRuntimeFileSchema,
} from './projects';

// Credential schemas
export {
  CreateCredentialSchema,
  SaveAgentCredentialSchema,
  CredentialKindBodySchema,
} from './credentials';

// Node schemas
export {
  CreateNodeSchema,
  UpdateNodeLabelSchema,
  PatchNodeSchema,
} from './nodes';

// Workspace schemas
export {
  CreateWorkspaceSchema,
  UpdateWorkspaceSchema,
  CreateAgentSessionSchema,
  UpdateAgentSessionSchema,
  AgentTypeBodySchema,
  CredentialInjectionSchema,
  BootLogEntrySchema,
  AgentCredentialSyncSchema,
  WorkspaceStatusUpdateSchema,
  WorkspaceErrorSchema,
} from './workspaces';

// Notification schemas
export { UpdateNotificationPreferenceSchema } from './notifications';

// Agent profile schemas
export {
  CreateAgentProfileSchema,
  UpdateAgentProfileSchema,
  SetProjectDefaultProfileSchema,
} from './agent-profiles';

// Agent settings schemas
export { SaveAgentSettingsSchema } from './agent-settings';

// ACP session schemas
export {
  CreateAcpSessionSchema,
  AcpSessionAssignSchema,
  AcpSessionStatusReportSchema,
  AcpSessionHeartbeatSchema,
  AcpSessionForkSchema,
} from './acp-sessions';

// Admin schemas
export {
  AdminUserActionSchema,
  AdminUserRoleSchema,
  AnalyticsForwardSchema,
} from './admin';

// Miscellaneous schemas
export {
  TerminalRequestSchema,
  SmokeTestCreateSchema,
  SmokeTestRedeemSchema,
  SaveCachedCommandsSchema,
  TtsRequestSchema,
  CreateChatSessionSchema,
  SendChatMessageSchema,
  LinkTaskToChatSchema,
  GcpOAuthHandleSchema,
  GcpSetupSchema,
  ProjectDeploymentSetupSchema,
  ClientErrorBatchSchema,
  NodeHeartbeatSchema,
  NodeErrorBatchSchema,
  AdminAnalyticsQuerySchema,
  UIStandardUpsertSchema,
  ComponentDefinitionCreateSchema,
  ComponentDefinitionUpdateSchema,
  ComplianceRunCreateSchema,
  ExceptionRequestCreateSchema,
  MigrationWorkItemCreateSchema,
  MigrationWorkItemPatchSchema,
} from './misc';
