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
  AgentEffort,
  AgentProfile,
  CredentialLimitsResponse,
  InboxItemContext,
  InboxLink,
  InstallationLifecycleLatency,
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
import type { InboxSettingName } from './inbox-settings-definition';
import type { OperationInboxTaskPort } from './inbox-task-ports';
import type { InsightsAgentSettingName } from './insights-agent-settings';
import type { InsightsInstallationSettingName } from './insights-installation-settings-definition';
import type { InsightsPageSettingName } from './insights-page-settings';
import type { InsightsReceiptSettingName } from './insights-receipt-settings-definition';
import type {
  AgentActivityTask,
  LimitKey,
  ListAgentActivityTasksOptions,
  ProfileAccountBinding,
  ReconciledSamDispatch,
  ResolveChatAgentStateInput,
  SamDispatchReservation,
  SessionIdlenessClassification,
  TaskAssistantMessage,
  TokenBudget,
  TriggerStatusUpdates,
} from './port-types';
import type { ProjectBriefSettingName } from './project-brief-settings-definition';
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
  | 'collaboration.ideaUpdatePageSize'
  | InboxSettingName
  | InsightsReceiptSettingName
  | InsightsPageSettingName
  | InsightsInstallationSettingName
  | ProjectBriefSettingName
  | InsightsAgentSettingName;

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
  /** One-chat model override; the profile and its account stay as resolved. */
  model?: string | null;
  /** One-chat effort override, checked against the agent that runs. */
  effort?: AgentEffort | null;
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
  /** The account each profile resolves to for `userId` in `projectId`; metadata only, never secrets. */
  profileAccountBindings(input: {
    projectId: string;
    userId: string;
    profiles: readonly { id: string; agentType: string }[];
  }): Promise<ProfileAccountBinding[]>;
  /**
   * Usage windows recorded for these credential references of `userId`'s own, across every
   * project, newest sample per window. References come from `profileAccountBindings`.
   */
  listOwnCredentialLimitsByReferences(
    userId: string,
    references: readonly string[]
  ): Promise<CredentialLimitsResponse>;
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

/**
 * Lifecycle latency over a time range, for Admin Health & cost
 * (`apps/api/src/services/lifecycle-latency/range-report.ts`). Owned by the lifecycle latency
 * service, which holds the watched states, their budgets and the percentile code.
 */
export interface OperationLifecycleLatencyPort {
  rangeReport(input: { sinceMs: number; untilMs: number }): Promise<InstallationLifecycleLatency>;
}

/** A question or permission held as a ProjectData attention marker, with the reader's access. */
export interface InboxAttentionMarker {
  id: string;
  sessionId: string;
  taskId: string | null;
  source: string | null;
  reason: string | null;
  options: string[];
  category: string | null;
  interactionId: string | null;
  interactionKind: string | null;
  createdAt: number;
  expiresAt: number | null;
  resolvedAt: number | null;
  topic: string | null;
  /** The reader may read the chat (owner or an active grantee). */
  canRead: boolean;
  /** The reader may answer for the agent in the chat. */
  canWrite: boolean;
}

/** An `asks` row as the notice path needs it (`packages/worker-core/src/schema.ts:asks`). */
export interface InboxAskNoticeRow {
  id: string;
  projectId: string;
  kind: string;
  title: string;
  status: string;
  answerJson: string | null;
  sourceSessionId: string | null;
  sourceTaskId: string | null;
  /** The asking agent's workspace (questions); the expiry outcome stops its task run. */
  sourceWorkspaceId: string | null;
  /** Epoch ms the ask was filed. */
  createdAt: number | null;
  resolvedByUserId: string | null;
  assigneeUserId: string | null;
}

export type InboxAskNoticeOutcome = 'answered' | 'done' | 'archived' | 'expired';

/**
 * The inbox's reach into other areas (`apps/api/src/services/inbox/`). Every answer and archive
 * goes through the path that store already answers through; none is re-implemented here.
 */
export interface OperationInboxPort {
  /** Project roles that hold a capability (the role table lives in the worker). */
  rolesWithCapability(capability: 'task:write' | 'secret:read' | 'secret:write'): readonly string[];
  /** One marker with the reader's access, or null when it does not exist in that chat. */
  attentionMarker(
    projectId: string,
    sessionId: string,
    markerId: string,
    userId: string
  ): Promise<InboxAttentionMarker | null>;
  /** Transcript around an ask; null when the reader cannot read the chat. */
  context(input: {
    projectId: string;
    sessionId: string;
    askedAt: number;
    userId: string;
  }): Promise<InboxItemContext | null>;
  /** Resolve a question with reason `archived` and tell the agent the person will not act. */
  archiveAttention(
    userId: string,
    projectId: string,
    sessionId: string,
    markerId: string
  ): Promise<{ agentNotified: boolean }>;
  fulfilSecret(
    userId: string,
    projectId: string,
    requestId: string,
    secret: { value: string; replaceExisting: boolean; expectedExistingVersion: string | null }
  ): Promise<{ agentNotified: boolean }>;
  declineSecret(
    userId: string,
    projectId: string,
    requestId: string
  ): Promise<{ agentNotified: boolean }>;
  decideApproval(
    userId: string,
    approvalId: string,
    decision: 'approve' | 'deny',
    note: string | null
  ): Promise<{ outcome: string; agentNotified: boolean }>;
  /** Authorizes waking the agent in a chat for this actor (`authorizeAgentWake`); throws when refused. */
  authorizeAnswerWake(projectId: string, sessionId: string, userId: string): Promise<void>;
  /**
   * Queues the filing agent's notice that an ask closed; true when queued. Never throws. The
   * caller records `notified_at`; a sweep retries a notice that was not queued.
   */
  notifyAsk(row: InboxAskNoticeRow, outcome: InboxAskNoticeOutcome): Promise<boolean>;
  /**
   * A system error item's Retry: the existing task retry (`retrySubtask`), with the person's
   * authority. Throws an `OperationError` when it is refused.
   */
  retryTask(userId: string, projectId: string, taskId: string): Promise<{ newTaskId: string }>;
  /**
   * A system error item's Wake: the existing chat wake (`authorizeAgentWake`, then
   * `ensureSessionRecovery`). Throws an `OperationError` when it is refused.
   */
  wakeChat(userId: string, projectId: string, sessionId: string): Promise<void>;
  /**
   * A system error item's Resume: a paused automation back to active, the same status change
   * the trigger PATCH route makes (`triggerStatusUpdates`, resetting the failure window). Needs
   * `task:write`; throws an `OperationError` when it is refused or the trigger is not paused.
   */
  resumeTrigger(userId: string, projectId: string, triggerId: string): Promise<void>;
  /**
   * An agent filed an ask (`fileAgentAsk`): a blocking question pauses its chat live and pushes
   * to the person, as `request_human_input` always did; other items reach the person's inbox.
   * Never throws; false when no notification was scheduled.
   */
  announceAsk(input: InboxAskAnnouncement): Promise<{ notificationScheduled: boolean }>;
  /** The agent cancelled a blocking question: its chat stops showing it as paused. Never throws. */
  withdrawQuestion(input: { projectId: string; sessionId: string; askId: string }): Promise<void>;
  /**
   * Whether each link names a thing of this project, in input order: null when it does, else
   * a short reason the agent can act on. Read with the platform's access; nothing is copied.
   */
  checkLinkTargets(projectId: string, links: readonly InboxLink[]): Promise<Array<string | null>>;
}

/** What `announceAsk` needs about an ask an agent just filed. */
export interface InboxAskAnnouncement {
  projectId: string;
  sessionId: string;
  taskId: string;
  askId: string;
  kind: 'question' | 'review' | 'result';
  blocking: boolean;
  title: string;
  /** The agent's full text: the question, the reason for a review, or a result's details. */
  body: string;
  options: string[];
  category: string | null;
  createdAt: number;
  expiresAt: number | null;
  /** The person the agent works for (the assignee). */
  userId: string;
}

export interface OperationPorts {
  config: OperationConfigPort;
  inbox: OperationInboxPort;
  /** Human tasks (inbox slice H1). */
  inboxTasks: OperationInboxTaskPort;
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
  lifecycleLatency: OperationLifecycleLatencyPort;
}
