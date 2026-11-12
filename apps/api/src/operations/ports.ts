/**
 * What the operations layer needs from the worker, as small injected interfaces.
 *
 * Operations own validation, authorization decisions, limits and projections. Anything
 * owned by another area of the worker (ProjectData, chat control, task lifecycle, triggers,
 * admin settings, GitHub, AI budgets) is reached through these ports, never by importing the
 * worker module. The worker builds one implementation per request in
 * `apps/api/src/operation-ports.ts` (`createOperationPorts`). Every method is already bound
 * to the worker environment, so no port call passes `env`.
 *
 * Step 1 of the operations package extraction derives the signatures from the worker
 * modules (type-only imports). Step 2 replaces them with declared structural types so the
 * package has no import from `apps/*`.
 */
import type { NotificationService } from '../durable-objects/notification';
import type * as projectEventSchedulesConfig from '../durable-objects/project-data/project-event-schedules-config';
import type * as projectEventsLimits from '../durable-objects/project-data/project-events-limits';
import type * as storageSafety from '../durable-objects/project-data/storage-safety';
import type * as chatWakeState from '../routes/chat/wake-state';
import type * as chatAcpInteractions from '../routes/chat-acp-interactions';
import type * as chatAgentState from '../routes/chat-agent-state';
import type * as chatAttention from '../routes/chat-attention';
import type * as chatCancel from '../routes/chat-cancel';
import type * as chatStop from '../routes/chat-stop';
import type * as schedulesRoute from '../routes/project-schedules';
import type * as acpInteractionStore from '../services/acp-interaction-store';
import type * as adminSettings from '../services/admin-settings';
import type * as agentActivity from '../services/agent-activity';
import type * as agentProfiles from '../services/agent-profiles';
import type * as aiTokenBudget from '../services/ai-token-budget';
import type * as cancelTaskService from '../services/cancel-task';
import type * as connectorAgentAnswer from '../services/connector-agent-answer';
import type * as connectorReadSettings from '../services/connector-read-settings';
import type * as credentialLimits from '../services/credential-limit-events/read';
import type * as githubApp from '../services/github-app';
import type * as projectData from '../services/project-data';
import type * as sendChat from '../services/send-chat';
import type * as sessionAccess from '../services/session-access';
import type * as sessionIdleness from '../services/session-idleness';
import type * as submitTaskService from '../services/submit-task';
import type * as taskFinalAssistantMessage from '../services/task-final-assistant-message';
import type * as triggerCreate from '../services/trigger-create';
import type * as workspaceResourceHistory from '../services/workspace-resource-history';
import type { OperationContext } from './types';

/** A worker function with its leading `env` parameter already bound. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches any leading env type
type Bound<F> = F extends (env: any, ...args: infer A) => infer R ? (...args: A) => R : never;

/** ProjectData Durable Object reads and writes the operations use (workstream W1 boundary). */
export interface OperationProjectDataPort {
  getSession: Bound<typeof projectData.getSession>;
  getSessionsByTaskIds: Bound<typeof projectData.getSessionsByTaskIds>;
  listSessions: Bound<typeof projectData.listSessions>;
  getArchivedToolPayloads: Bound<typeof projectData.getArchivedToolPayloads>;
  getMessages: Bound<typeof projectData.getMessages>;
  searchMessagesWithArchiveMetadata: Bound<typeof projectData.searchMessagesWithArchiveMetadata>;
  getLogicalTranscriptPage: Bound<typeof projectData.getLogicalTranscriptPage>;
  getLogicalMessage: Bound<typeof projectData.getLogicalMessage>;
  resolveTranscriptOwner: Bound<typeof projectData.resolveTranscriptOwner>;
  getMailboxMessage: Bound<typeof projectData.getMailboxMessage>;
  listActiveAttentionMarkers: Bound<typeof projectData.listActiveAttentionMarkers>;
  searchKnowledgeObservations: Bound<typeof projectData.searchKnowledgeObservations>;
  getIdeaWorkSnapshots: Bound<typeof projectData.getIdeaWorkSnapshots>;
  addIdeaUpdate: Bound<typeof projectData.addIdeaUpdate>;
  listIdeaUpdates: Bound<typeof projectData.listIdeaUpdates>;
  deleteIdeaUpdate: Bound<typeof projectData.deleteIdeaUpdate>;
  recordResourceLink: Bound<typeof projectData.recordResourceLink>;
  removeResourceLink: Bound<typeof projectData.removeResourceLink>;
  listResourceLinks: Bound<typeof projectData.listResourceLinks>;
  listLinksForTargets: Bound<typeof projectData.listLinksForTargets>;
  getResourceLinkSnapshot: Bound<typeof projectData.getResourceLinkSnapshot>;
  listProjectEventChannels: Bound<typeof projectData.listProjectEventChannels>;
  getProjectEventChannelHistory: Bound<typeof projectData.getProjectEventChannelHistory>;
  listProjectEventChannelSubscribers: Bound<typeof projectData.listProjectEventChannelSubscribers>;
  getProjectEventSubscription: Bound<typeof projectData.getProjectEventSubscription>;
  cancelProjectEventSubscription: Bound<typeof projectData.cancelProjectEventSubscription>;
  getProjectSchedule: Bound<typeof projectData.getProjectSchedule>;
  listProjectSchedules: Bound<typeof projectData.listProjectSchedules>;
  createProjectSchedule: Bound<typeof projectData.createProjectSchedule>;
  mutateProjectSchedule: Bound<typeof projectData.mutateProjectSchedule>;
}

/** Admin-panel runtime settings. */
export interface OperationSettingsPort {
  resolve: Bound<typeof adminSettings.resolveAdminSetting>;
  resolveDetailsMany: Bound<typeof adminSettings.resolveAdminSettingDetailsMany>;
  connectorReadLimits: Bound<typeof connectorReadSettings.getConnectorReadLimits>;
}

/** Project membership, capability and session-writer checks. Each throws the worker's `AppError`. */
export interface OperationAccessPort {
  requireProjectAccess(projectId: string, userId: string): Promise<unknown>;
  requireProjectCapability(
    projectId: string,
    userId: string,
    capability: 'task:write'
  ): Promise<unknown>;
  requireSessionWriter: Bound<typeof sessionAccess.requireSessionWriter>;
}

/** Connector (OAuth/PAT) write receipts, audit, and agent-answer preparation. */
export interface OperationConnectorPort {
  /** Runs a Connector/PAT write under its idempotency receipt; other actors run directly. */
  executeWrite<T>(
    ctx: OperationContext,
    operation: string,
    input: Record<string, unknown>,
    run: () => Promise<T>,
    preflight?: () => Promise<void>
  ): Promise<T>;
  /** Records a Connector/PAT write attempt in the operations audit; other actors run directly. */
  auditWrite<T>(
    ctx: OperationContext,
    operation: string,
    rawInput: unknown,
    run: () => Promise<T>
  ): Promise<T>;
  pendingInteractions: Bound<typeof connectorAgentAnswer.connectorPendingInteractions>;
  prepareAgentAnswer: Bound<typeof connectorAgentAnswer.prepareConnectorAgentAnswer>;
}

/** Live chat-session control and state. */
export interface OperationChatPort {
  authorizeSend: Bound<typeof sendChat.authorizeSendChat>;
  send: Bound<typeof sendChat.sendChat>;
  validateSendContent: typeof sendChat.validateSendChatContent;
  stop: Bound<typeof chatStop.stopChat>;
  interrupt: Bound<typeof chatCancel.interruptChat>;
  answerAttention: Bound<typeof chatAttention.answerAttention>;
  answerAgentInteraction: Bound<typeof chatAcpInteractions.answerAgentInteraction>;
  snapshotInteractions: Bound<typeof acpInteractionStore.snapshotInteractions>;
  resolveAgentState: Bound<typeof chatAgentState.resolveChatAgentState>;
  attachWakeState(
    ...args: Parameters<typeof chatWakeState.attachWakeState> extends [unknown, ...infer A]
      ? A
      : never
  ): ReturnType<typeof chatWakeState.attachWakeState>;
}

/** Task lifecycle and task-derived reads. */
export interface OperationTaskPort {
  submit: Bound<typeof submitTaskService.submitTask>;
  cancel(
    ...args: Parameters<typeof cancelTaskService.cancelTask> extends [unknown, unknown, ...infer A]
      ? A
      : never
  ): ReturnType<typeof cancelTaskService.cancelTask>;
  recentAssistantMessages: Bound<
    typeof taskFinalAssistantMessage.getRecentAssistantMessagesForTask
  >;
  listAgentActivity: Bound<typeof agentActivity.listAgentActivityTasks>;
  listCredentialLimits: Bound<typeof credentialLimits.listProjectCredentialLimits>;
}

/** Recurring trigger (cron) persistence and validation. */
export interface OperationTriggerPort {
  create(
    ...args: Parameters<typeof triggerCreate.createTrigger> extends [unknown, unknown, ...infer A]
      ? A
      : never
  ): ReturnType<typeof triggerCreate.createTrigger>;
  validateCron: Bound<typeof triggerCreate.validateCron>;
  clearPageCaches(projectId: string): void;
  rethrowScheduleError: typeof schedulesRoute.rethrowScheduleError;
}

/** Agent profiles, AI usage budgets and GitHub App tokens. */
export interface OperationAccountPort {
  listProfiles(projectId: string, userId: string): ReturnType<typeof agentProfiles.listProfiles>;
  tokenUsage(userId: string): ReturnType<typeof aiTokenBudget.getTokenUsage>;
  budgetSettings(userId: string): ReturnType<typeof aiTokenBudget.getUserBudgetSettings>;
  effectiveBudgetLimits(
    settings: Parameters<typeof aiTokenBudget.resolveEffectiveLimits>[0]
  ): ReturnType<typeof aiTokenBudget.resolveEffectiveLimits>;
  githubInstallationToken(
    installationId: string
  ): ReturnType<typeof githubApp.getInstallationToken>;
  /** The user's notification inbox (Notification Durable Object, keyed by user). */
  listNotifications: NotificationService['listNotifications'];
}

/** Environment-derived limits owned by other areas, resolved by the worker. */
export interface OperationConfigPort {
  scheduleLimits(): ReturnType<typeof projectEventSchedulesConfig.scheduleLimits>;
  projectEventLimits(): ReturnType<typeof projectEventsLimits.resolveProjectEventLimits>;
  storageSafety(): ReturnType<typeof storageSafety.resolveStorageSafetyConfig>;
  /** Validates and normalizes a channel name against the deployment's channel limits. */
  channelName(value: string): string;
  harnessWork(): ReturnType<typeof sessionIdleness.parseHarnessWorkConfig>;
}

/** Workspace runtime observations. */
export interface OperationWorkspacePort {
  resourceHistory: Bound<typeof workspaceResourceHistory.getWorkspaceResourceHistory>;
}

/** Mission scheduling (ProjectOrchestrator Durable Object). */
export interface OperationMissionPort {
  /** Registers a mission with the project's orchestrator for scheduling. */
  startOrchestration(projectId: string, missionId: string): Promise<void>;
}

export interface OperationPorts {
  config: OperationConfigPort;
  projectData: OperationProjectDataPort;
  settings: OperationSettingsPort;
  access: OperationAccessPort;
  connector: OperationConnectorPort;
  chat: OperationChatPort;
  tasks: OperationTaskPort;
  triggers: OperationTriggerPort;
  account: OperationAccountPort;
  workspaces: OperationWorkspacePort;
  missions: OperationMissionPort;
}
