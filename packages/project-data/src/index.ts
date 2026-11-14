// Public entry point of @simple-agent-manager/project-data: the ProjectData client,
// its env and ports, and the ProjectData types and helpers the worker uses.
// The Durable Object class is './durable-object'; the cron jobs are './scheduled'.
//
// The client module is re-exported wholesale: it is the RPC surface the worker calls
// (~150 functions), and a hand-kept list would drift with every new RPC.
export {
  breakerWasClosedBeforeOpening,
  type ProjectDataArchiveBreakerOpening,
} from './archive/breaker-opening';
export * from './client/project-data';
export {
  freezeProjectDataArchiveProject,
  getProjectDataArchiveManualCanaryConfig,
  getProjectDataArchiveRolloutListConfig,
  getProjectDataArchiveRolloutState,
  listProjectDataArchiveProblemMigrations,
  setProjectDataArchiveCircuitBreaker,
} from './client/project-data-archive-rollout-controls';
export {
  buildDeploymentEnvironmentLifecycleEventInput,
  buildDeploymentPublishJobLifecycleEventInput,
  buildDeploymentReleaseLifecycleEventInput,
  buildSessionLifecycleEventInput,
  buildTaskLifecycleEventInput,
  type DeploymentEnvironmentLifecycleEventInput,
  type DeploymentPublishJobLifecycleEventInput,
  type DeploymentReleaseLifecycleEventInput,
  isLifecycleTaskStatus,
  PROJECT_LIFECYCLE_EVENT_SOURCE,
  type SessionLifecycleEventInput,
  type TaskLifecycleEventInput,
  taskLifecycleEventType,
} from './client/project-data-lifecycle-event-inputs';
export { describeRootSearchCoverage } from './client/project-data-search-coverage';
export { isAgentMessageChannelName } from './do/agent-message-notice';
export {
  AGENT_WAKE_POLICY_MODES,
  type AgentWakeActorAccess,
  type AgentWakeDecision,
  type AgentWakeDenial,
  type AgentWakeGrant,
  type AgentWakePolicyMode,
  agentWakeRecord,
  type AgentWakeRequest,
  type AgentWakeTrigger,
  decideAgentWake,
  DEFAULT_AGENT_WAKE_POLICY_MODE,
  HUMAN_AGENT_WAKE_TRIGGERS,
  HUMAN_PROMPT_DELIVERY_TRIGGERS,
  type HumanPromptDeliveryTrigger,
  isHumanPromptDeliveryTrigger,
} from './do/agent-wake-policy';
export { computeHumanInputSchedule, parseAttentionOptions } from './do/attention';
export { CommentNotFoundError } from './do/comment-contracts';
export { resolveDurableExecutionConfig } from './do/durable-execution-config';
export {
  type GroupedFtsWallRecoveryConfig,
  resolveGroupedFtsWallRecoveryConfig,
} from './do/grouped-fts-wall-recovery';
export { type IdeaWorkSnapshot } from './do/idea-work';
export { type KnowledgeEntityIndexEntry } from './do/knowledge';
export { type LinkLimits, type LinkRemove, type LinkWrite, type ResourceLink } from './do/links';
export { type LogicalActivity, type LogicalEntry } from './do/logical-transcript';
export { type LogicalMessage } from './do/logical-transcript-model';
export {
  configureProjectDataPort,
  configureProjectDataPorts,
  type CredentialsPort,
  type NoticesPort,
  type NotificationsPort,
  type ObservabilityPort,
  type OperationsPort,
  type ProjectDataPorts,
  type SessionRecoverySourceTaskGuard as ProjectDataSourceTaskGuard,
  type ProjectEventWakeRecoveryGuard,
  type RuntimePort,
  type SessionLifecyclePort,
  type TaskLifecyclePort,
  type TaskRuntimeLivenessPort,
  type VmPromptDeliveryAdapter,
  type VmPromptDeliveryAdapterInput,
  type VmPromptDeliverySourceTaskGuard,
  type VmPromptDeliveryTarget,
} from './do/ports';
export {
  channelLimits,
  channelName,
  type ProjectEventChannelEnv,
} from './do/project-event-channels-config';
export { type ScheduleCreator } from './do/project-event-schedules-authority';
export { scheduleLimits } from './do/project-event-schedules-config';
export { ProjectScheduleNotFoundError } from './do/project-event-schedules-storage';
export {
  ProjectEventCursorError,
  ProjectEventIdempotencyConflictError,
  ProjectEventLimitExceededError,
  ProjectEventNotFoundError,
  ProjectEventValidationError,
} from './do/project-events-contracts';
export {
  decodeProjectEventSubscriptionEventsCursor,
  isProjectEventSubscriptionEventsCursorToken,
} from './do/project-events-cursors';
export { resolveProjectEventLimits } from './do/project-events-limits';
export { normalizeProjectEventInput } from './do/project-events-normalization';
export { normalizeNullableText } from './do/project-events-values';
export { isProjectEventWakeEnabled } from './do/project-events-wake-config';
export {
  type AcceptPromptDeliveryInput,
  type PromptDeliveryClaim,
  type PromptDeliveryResult,
} from './do/prompt-delivery';
// Shared with the worker's Notification Durable Object, which already read them from here.
export { parseCountCnt, parseEnabled, parseMigrationName } from './do/row-schemas';
export { type SessionAccessGrantRecord, type SessionAccessResolution } from './do/session-access';
export { type SessionWakeProgressInput } from './do/session-wake-progress';
export { type SessionWakeReadyInput } from './do/session-wake-ready';
export { type ActivityReportOutcome } from './do/session-work-clock';
export {
  buildSharedSessionSpeakerLine,
  loadSharedSessionNames,
  type SharedSessionNames,
} from './do/shared-session-names';
export { resolveStorageSafetyConfig } from './do/storage-safety';
export { readTaskAcpLivenessSignals } from './do/task-acp-liveness-signals';
export {
  type RuntimeAcpSessionSnapshot,
  type RuntimeSessionWorkSnapshot,
  type RuntimeWorkEvidenceSnapshot,
  type RuntimeWorkState,
  type TaskAcpLivenessSignals,
} from './do/task-acp-liveness-types';
export { resolveTaskWaitConfig } from './do/task-wait-config';
export {
  DEFAULT_TERMINAL_SESSION_RECONCILE_DEFER_MS,
  MAX_TERMINAL_SESSION_RECONCILE_DEFER_MS,
  type TerminalSessionReconciliationStats,
} from './do/terminal-session-reconciliation';
export { ProjectDataManualToolPayloadCleanupStateError } from './do/tool-payload-cleanup-types';
export { type ProjectDataEnv } from './do/types';
// Resolves where a session's rows live (root object or an archive shard). Worker services that
// must not mistake an archived session for a missing one use it (services/session-expiry.ts).
export { resolveProjectDataSessionLocation } from './client/project-data-archive-routing';
export { DEFAULT_ROW_USAGE_INTERVAL_MS } from './do/row-usage-config';
