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
 * Signatures are declared here (with value types in `./port-types.ts`), never derived from
 * worker modules, so the operations package does not depend on the worker. The worker's
 * implementation is checked against them structurally.
 */
import type {
  AcpInteractionBrowserAnswer,
  AcpInteractionSafeSummary,
  AcpInteractionState,
  AgentProfile,
  CredentialLimitsResponse,
  NotificationResponse,
  NotificationType,
  SessionStateSnapshot,
  SubmitTaskResponse,
  TaskStatus,
  TriggerStatus,
  UserAiBudgetSettings,
} from '@simple-agent-manager/shared';
import type * as schema from '@simple-agent-manager/worker-core/schema';

import type { ConnectorAnswerChoice } from './connector-answer-input';
import type { ConnectorReadSettingName } from './connector-read-settings-definition';
import type {
  AgentActivityTask,
  LimitKey,
  ListAgentActivityTasksOptions,
  ReconciledSamDispatch,
  ResolveChatAgentStateInput,
  SamDispatchReservation,
  SessionIdlenessClassification,
  TaskAssistantMessage,
  TokenBudget,
  TriggerStatusUpdates,
} from './port-types';
import type { OperationProjectDataPort } from './project-data-port';
import type { OperationContext } from './types';

export type {
  AttentionMarker,
  IdeaUpdate,
  KnowledgeSearchHit,
  OperationProjectDataPort,
  ProjectEventErrorKind,
  ResourceLinkSnapshot,
} from './project-data-port';

/** Admin settings the operations read (`apps/api/src/services/admin-setting-definitions.ts`). */
export type OperationSettingName =
  | 'operations.agentIdeaContentPageLength'
  | 'operations.agentLinkedListCap'
  | 'operations.agentLinkedUpdatesCap'
  | 'operations.agentLinkedTextMaxLength'
  | 'operations.agentLinkedMaxBytes'
  | 'operations.pullRequestRefreshCap'
  | 'operations.pullRequestRefreshTtlSeconds'
  | 'operations.pullRequestRefreshBudgetPerHour'
  | 'operations.pullRequestRefreshBackoffSeconds'
  | 'operations.pullRequestRefreshTimeoutMs'
  | 'operations.resourceLinkTouchIntervalMs'
  | 'operations.resourceLinkWeakPerTarget'
  | 'operations.resourceLinkWeakCleanupBatchSize'
  | 'operations.resourceLinkProjectCap'
  | 'operations.resourceLinkListCap'
  | 'operations.resourceLinkContextMaxLength'
  | 'operations.resourceLinkBatchTargetLimit'
  | 'operations.resourceLinkBatchPerTargetCap'
  | 'collaboration.ideaUpdateBodyMaxLength'
  | 'collaboration.ideaUpdateQuoteMaxLength'
  | 'collaboration.ideaAgentNoteMinIntervalSeconds'
  | 'collaboration.ideaUpdatePageSize';

export type OperationSettingValue = boolean | number | string | readonly string[] | null;

/** Connector read limits, one number per setting (`services/connector-read-settings.ts`). */
export type ConnectorReadLimits = Record<LimitKey<ConnectorReadSettingName>, number>;

/** A pending agent interaction as the Connector shows it. */
export type ConnectorPendingInteraction = AcpInteractionSafeSummary & {
  untrustedContent: boolean;
  canDecline: boolean;
  answerOptions?: unknown[];
  formSchema?: unknown;
  detail: Record<string, unknown> | null;
};

/** A session the caller may write to; operations read the owner and the session row. */
export interface SessionWriter {
  session: Record<string, unknown>;
  ownerUserId: string;
}

/** A chat send that has passed authorization; `send` delivers with that authorization. */
export interface AuthorizedChatSend {
  send(
    body: { content: string },
    assertEffectAllowed?: () => Promise<void>
  ): Promise<Record<string, unknown>>;
}

/** The recurring-trigger body a cron schedule creates. */
export interface CronTriggerCreateBody {
  name: string;
  sourceType: 'cron';
  cronExpression: string;
  cronTimezone: string;
  promptTemplate: string;
  description?: string;
  agentProfileId?: string;
  skillId?: string;
  taskMode?: 'task' | 'conversation';
}

/** Admin-panel runtime settings. */
export interface OperationSettingsPort {
  resolve(name: OperationSettingName): Promise<OperationSettingValue>;
  resolveDetailsMany(
    names: OperationSettingName[]
  ): Promise<{ value: OperationSettingValue; configured: boolean; source: string }[]>;
  connectorReadLimits(): Promise<ConnectorReadLimits>;
}

/** Project membership, capability and session-writer checks. Each throws the worker's `AppError`. */
export interface OperationAccessPort {
  requireProjectAccess(projectId: string, userId: string): Promise<unknown>;
  requireProjectCapability(
    projectId: string,
    userId: string,
    capability: 'task:write'
  ): Promise<unknown>;
  requireSessionWriter(
    projectId: string,
    sessionId: string,
    actorUserId: string,
    options?: { action?: string }
  ): Promise<SessionWriter>;
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
  pendingInteractions(projectId: string, sessionId: string): Promise<ConnectorPendingInteraction[]>;
  prepareAgentAnswer(
    projectId: string,
    sessionId: string,
    interactionId: string,
    input: ConnectorAnswerChoice
  ): Promise<AcpInteractionBrowserAnswer>;
  /** Deterministic id of a write receipt (shared with the CLI receipt store). */
  receiptId(
    projectId: string,
    userId: string,
    method: string,
    path: string,
    key: string
  ): Promise<string>;
}

/** Live chat-session control and state. */
export interface OperationChatPort {
  /** Authorizes a send now; the returned `send` delivers under that authorization. */
  authorizeSend(userId: string, projectId: string, sessionId: string): Promise<AuthorizedChatSend>;
  /** Validates message content before a receipt is reserved; returns the trimmed content. */
  validateSendContent(body: { content?: string }): string;
  stop(
    userId: string,
    projectId: string,
    sessionId: string,
    assertEffectAllowed?: () => Promise<void>,
    options?: { requireStopAcknowledgement?: boolean }
  ): Promise<{ status: string; workspaceStopped?: boolean; workspaceDeleted?: boolean }>;
  interrupt(
    userId: string,
    projectId: string,
    sessionId: string,
    expectedAgentSessionId?: string,
    expectedPromptStartedAt?: number
  ): Promise<{ status: string; message: string }>;
  answerAttention(
    userId: string,
    projectId: string,
    sessionId: string,
    markerId: string,
    answer: string
  ): Promise<{ resolved: boolean; alreadyResolved: boolean; answer: string; inFlight?: boolean }>;
  answerAgentInteraction(
    userId: string,
    projectId: string,
    sessionId: string,
    interactionId: string,
    body: AcpInteractionBrowserAnswer
  ): Promise<{ accepted: boolean; state: AcpInteractionState }>;
  snapshotInteractions(
    projectId: string,
    chatSessionId: string,
    cursor?: string | null
  ): Promise<{
    pending: AcpInteractionSafeSummary[];
    settled: AcpInteractionSafeSummary[];
    cursor: string | null;
  }>;
  resolveAgentState(input: ResolveChatAgentStateInput): Promise<{
    agentSessionId: string | null;
    agentType: string | null;
    state: SessionStateSnapshot | null;
  }>;
  /**
   * Whether a chat's agent turn has ended, by the same session-sleep policy the sleep sweep uses
   * (`prompt-turn-ended`).
   */
  classifyTurnIdleness(input: {
    state: SessionStateSnapshot | null;
    /** The state when it carries an attributed activity observation, else null. */
    reportedState: SessionStateSnapshot | null;
    taskStatus: string | null;
    taskCompletedAt?: string | null;
    now: Date;
  }): SessionIdlenessClassification;
  attachWakeState(
    state: SessionStateSnapshot | null,
    args: { projectId: string; sessionId: string; sessionStatus: unknown }
  ): Promise<SessionStateSnapshot | null>;
}

/** The fields of a project work request that `sam_chat_start` submits. */
export interface TaskSubmitBody {
  message: string;
  taskMode?: 'conversation' | 'task';
  agentProfileId?: string;
  skillId?: string;
}

/** Task lifecycle and task-derived reads. */
export interface OperationTaskPort {
  submit(
    user: { id: string; name: string | null; email: string },
    projectId: string,
    body: TaskSubmitBody,
    waitUntil: (promise: Promise<unknown>) => void,
    via?: string,
    clientName?: string,
    repositoryAccess?: (project: schema.Project) => Promise<unknown>,
    samReservation?: SamDispatchReservation,
    assertEffectAllowed?: () => Promise<void>
  ): Promise<SubmitTaskResponse | ReconciledSamDispatch>;
  cancel(
    task: schema.Task,
    userId: string,
    options?: { reason?: string; source?: string; requireStopAcknowledgement?: boolean }
  ): Promise<{ status: string }>;
  recentAssistantMessages(
    projectId: string,
    sessionId: string | null,
    count: number
  ): Promise<TaskAssistantMessage[]>;
  listAgentActivity(options: ListAgentActivityTasksOptions): Promise<AgentActivityTask[]>;
  listCredentialLimits(input: {
    projectId: string;
    userId: string;
    credentialReference?: string | null;
  }): Promise<CredentialLimitsResponse>;
  isStatus(value: unknown): value is TaskStatus;
  canTransition(from: TaskStatus, to: TaskStatus): boolean;
  /** Live plus sleeping task statuses: a task that still holds or can reclaim a runtime. */
  wakeableStatuses: ReadonlySet<string>;
}

/** Recurring trigger (cron) persistence and validation. */
export interface OperationTriggerPort {
  create(
    project: Pick<schema.Project, 'id' | 'maxTriggers'>,
    userId: string,
    body: CronTriggerCreateBody
  ): Promise<{ created: schema.TriggerRow }>;
  validateCron(expression: string | undefined, timezone: string | undefined): void;
  clearPageCaches(projectId: string): void;
  rethrowScheduleError(error: unknown): never;
  cronToHumanReadable(expression: string, timezone?: string): string;
  /** The user a recurring trigger runs as. */
  executionUserId(trigger: Pick<schema.TriggerRow, 'executionUserId' | 'userId'>): string;
  statusUpdates(
    trigger: Pick<schema.TriggerRow, 'status' | 'sourceType' | 'cronExpression' | 'cronTimezone'>,
    status: TriggerStatus,
    now?: Date
  ): TriggerStatusUpdates;
}

/** Agent profiles, AI usage budgets, notifications and GitHub App tokens. */
export interface OperationAccountPort {
  listProfiles(projectId: string, userId: string): Promise<AgentProfile[]>;
  tokenUsage(userId: string): Promise<TokenBudget>;
  budgetSettings(userId: string): Promise<UserAiBudgetSettings | null>;
  effectiveBudgetLimits(settings: UserAiBudgetSettings | null): {
    dailyInputTokenLimit: number;
    dailyOutputTokenLimit: number;
  };
  githubInstallationToken(installationId: string): Promise<{ token: string }>;
  /** The user's notification inbox (Notification Durable Object, keyed by user). */
  listNotifications(
    userId: string,
    options?: {
      cursor?: string;
      limit?: number;
      filter?: 'all' | 'unread';
      type?: NotificationType;
      projectId?: string;
      sessionId?: string;
    }
  ): Promise<{
    notifications: NotificationResponse[];
    unreadCount: number;
    nextCursor: string | null;
  }>;
}

/** Environment-derived limits owned by other areas, resolved by the worker. */
export interface OperationConfigPort {
  scheduleLimits(): { promptBytes: number; maxHorizonMs: number };
  projectEventLimits(): { maxReasonBytes: number };
  storageSafety(): { limitBytes: number; warningRatio: number };
  /** Validates and normalizes a channel name against the deployment's channel limits. */
  channelName(value: string): string;
  /** The API origin derived from the deployment's base domain (`https://api.<domain>`). */
  apiOrigin(): string;
}

/** Workspace runtime observations. */
export interface OperationWorkspacePort {
  resourceHistory(input: {
    projectId: string;
    sessionId?: string | null;
    taskId?: string | null;
    workspaceId?: string | null;
    detailChunkId?: string | null;
  }): Promise<object>;
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
