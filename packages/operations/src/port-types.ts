/**
 * Types of the values that cross the operations ports (`./ports.ts`).
 *
 * Each mirrors the worker type named in its comment. The worker's implementation of the ports
 * (`createOperationPorts`) is checked against these structurally, so a drift in the worker
 * shows up as a type error there. Where operations only reads part of a worker value, the type
 * here declares only that part.
 */
import type {
  AgentActivityState,
  LinkKind,
  LinkOrigin,
  LinkRelation,
  MessageCursor,
  MessagePosition,
  TaskFinalAssistantMessage,
  TriggerStatus,
} from '@simple-agent-manager/shared';
import type { NormalizedSearchQuery } from '@simple-agent-manager/worker-core';
import type { SQL } from 'drizzle-orm';

/** Mirrors `ArchivedToolPayloadQuery` (src/durable-objects/project-data/tool-payload-archive.ts). */
export type ArchivedToolPayloadQuery = {
  messageId?: string;
  sessionId?: string;
  startTime?: number;
  endTime?: number;
  limit: number;
};

/** Mirrors `ArchivedToolPayloadListResult` (src/durable-objects/project-data/tool-payload-archive.ts). */
export type ArchivedToolPayloadListResult = {
  projectId: string;
  payloads: ArchivedToolPayloadItem[];
  count: number;
  hasMore: boolean;
};

/** Mirrors `ArchivedToolPayloadItem` (src/durable-objects/project-data/tool-payload-archive.ts). */
export type ArchivedToolPayloadItem = {
  messageId: string;
  sessionId: string;
  messageCreatedAt: number;
  messageSequence: number;
  archivedAt: number;
  contentBytes: number;
  toolMetadataBytes: number;
  archiveVersion: number;
  available: boolean;
  content: unknown[] | null;
  unavailableReason?: string;
};

/** Mirrors `ProjectDataSearchMessagesWithArchiveMetadataResult` (src/services/project-data.ts). */
export type ProjectDataSearchMessagesWithArchiveMetadataResult = {
  results: ProjectDataMessageSearchResult[];
  archiveSearch: ProjectDataArchiveSearchMetadata;
  rootSearch: ProjectDataRootSearchCoverage | null;
  query: NormalizedSearchQuery;
};

/** Mirrors `ProjectDataMessageSearchResult` (src/services/project-data.ts). */
export type ProjectDataMessageSearchResult = SearchResult;

/** Mirrors `ProjectDataArchiveSearchMetadata` (src/services/project-data.ts). */
export type ProjectDataArchiveSearchMetadata = {
  partial: boolean;
  reason:
    | null
    | 'session_scoped_exact_read'
    | 'archive_owner_inventory_unavailable'
    | 'continuation_required'
    | 'archive_search_errors';
  complete: boolean;
  continuation: string | null;
  resultsProvisional: boolean;
  rootQueried: boolean;
  rootError: string | null;
  archiveOwnersAvailable: number;
  archiveOwnersQueried: number;
  archiveOwnersFailed: number;
  archiveOwnersOmitted: number;
  archiveOwnerLimit: number;
  ownerCoverage: {
    attempted: number;
    succeeded: number;
    remaining: number;
    complete: boolean;
  };
  indexCoverage: {
    sessionsAvailable: number;
    sessionsIndexed: number;
    sessionsIncomplete: number;
    complete: boolean;
    errors: Array<{ ownerName: string; sessionId: string; error: string }>;
  };
  executionErrors: Array<{ ownerName: string; error: string }>;
};

/** Mirrors `SearchResult` (src/durable-objects/project-data/message-search-rows.ts). */
export type SearchResult = {
  id: string;
  sessionId: string;
  role: string;
  snippet: string;
  createdAt: number;
  sessionTopic: string | null;
  sessionTaskId: string | null;
};

/** Mirrors `MessageSearchCoverage` (src/durable-objects/project-data/message-search.ts). */
export interface MessageSearchCoverage {
  ftsCandidateLimit: number;
  /** More full-text matches exist than were ranked; only the newest `ftsCandidateLimit` were. */
  ftsCandidatesTruncated: boolean;
  keywordScanRowLimit: number;
  /** The keyword fallback ran. It only runs when full-text returned fewer than `limit` results. */
  keywordFallbackRan: boolean;
  /** The keyword fallback ran and older raw messages exist beyond the rows it scanned. */
  keywordScanTruncated: boolean;
}

/** Mirrors `ProjectDataRootSearchCoverage` (src/services/project-data-search-coverage.ts). */
export type ProjectDataRootSearchCoverage = MessageSearchCoverage;

/** Mirrors `LogicalTranscriptRequest` (src/durable-objects/project-data/logical-transcript.ts). */
export interface LogicalTranscriptRequest {
  /** Exclusive bound: the page holds messages older than this position. */
  before: MessageCursor | null;
  /** Included messages to return at most. Activity summaries do not count. */
  limit: number;
  /** Roles returned as messages. Tool runs are always summarized as activity. */
  roles: string[];
  /** Stored rows examined at most, across all pages of the scan. */
  maxScanRows: number;
  /** Content characters returned per message; the rest is read by offset. */
  maxMessageChars: number;
  /** Content characters returned per page, across messages. */
  maxPageChars: number;
  /** Report the newest user and assistant messages, scanning past a full page if needed. */
  includeLatest: boolean;
  /** Include bounded tool-call titles in activity summaries (they can contain command text). */
  includeToolTitles: boolean;
}

/** Mirrors `LogicalTranscriptResult` (src/durable-objects/project-data/logical-transcript.ts). */
export interface LogicalTranscriptResult {
  /** Newest first. */
  entries: LogicalEntry[];
  /** Position to pass as `before` for the next (older) page; null at the transcript start. */
  nextCursor: MessagePosition | null;
  hasMore: boolean;
  scannedRows: number;
  /** The row budget ended the page before `limit` messages were found. */
  scanBudgetExhausted: boolean;
  latest: {
    assistant: LogicalMessage | null;
    user: LogicalMessage | null;
    /** The scan budget ended before a user message was found. */
    userSearchExhausted: boolean;
  } | null;
}

/** Mirrors `LogicalMessageRequest` (src/durable-objects/project-data/logical-message.ts). */
export interface LogicalMessageRequest {
  /** Any stored row of the message. */
  messageId: string;
  /** Rows read each side of the named row, at most. */
  maxRows: number;
  /** First character returned; ignored when `focus` finds a match. */
  offset: number;
  /** Characters returned at most. */
  maxChars: number;
  /** Return an excerpt centred on the first occurrence of any term, instead of reading by offset. */
  focus: { terms: string[] } | null;
  includeThinking: boolean;
  includeToolTitles: boolean;
}

/** Mirrors `LogicalMessageResult` (src/durable-objects/project-data/logical-message.ts). */
export interface LogicalMessageResult {
  found: boolean;
  message: LogicalMessage | null;
  activity: LogicalActivity | null;
  /** True when a thought was found but its text was not requested. */
  thinkingWithheld: boolean;
  /** `focus` found a term, so `message.offset` starts an excerpt around it. */
  focusMatched: boolean;
}

/** Mirrors `LogicalEntry` (src/durable-objects/project-data/logical-transcript-model.ts). */
export type LogicalEntry = LogicalMessage | LogicalActivity;

/** Mirrors `LogicalMessage` (src/durable-objects/project-data/logical-transcript-model.ts). */
export interface LogicalMessage {
  kind: 'message';
  /** First stored row of the message: stable while the message is still streaming. */
  messageId: string;
  /** Exact position of that row: `before` for a page that starts just older than this entry. */
  start: MessagePosition | null;
  lastRowId: string;
  role: string;
  /** `system` marks a user-role prompt SAM injected; anything else was typed by a person. */
  origin: string | null;
  /** The returned slice of the message, starting at `offset`. */
  content: string;
  offset: number;
  contentLength: number;
  /** More content exists after the returned slice; read it from `nextOffset`. */
  truncated: boolean;
  nextOffset: number | null;
  rowCount: number;
  createdAt: number;
  updatedAt: number;
  /** False when a row budget ended before the whole message was read. */
  complete: boolean;
  /**
   * True when the message continues into the newer page (a cursor that ends mid-message: legacy
   * cursors, or one from a read that ran out of time); null when that could not be checked in time.
   */
  continuesInNewerPage: boolean | null;
}

/** Mirrors `LogicalActivity` (src/durable-objects/project-data/logical-transcript-model.ts). */
export interface LogicalActivity {
  kind: 'activity';
  /** First stored row of the summarized span. */
  firstRowId: string;
  /** Exact position of that row: `before` for a page that starts just older than this entry. */
  start: MessagePosition | null;
  rowCount: number;
  toolCalls: number;
  toolStatuses: Record<string, number>;
  toolKinds: Record<string, number>;
  toolNames: string[];
  toolTitles?: string[];
  /** Thinking messages hidden from this page. */
  thinkingMessages: number;
  planUpdates: number;
  /** Other messages left out by the role filter, by role. */
  otherMessages: Record<string, number>;
  createdAt: number;
  updatedAt: number;
  /** False when the scan budget ended before the span's oldest row was read. */
  complete: boolean;
  /**
   * True when the span continues into the newer page (a cursor that ends mid-span: legacy cursors,
   * or one from a read that ran out of time); null when that could not be checked in time.
   */
  continuesInNewerPage: boolean | null;
}

/** Mirrors `ProjectDataArchiveLocation` (src/project-data-archive/contract.ts). */
export type ProjectDataArchiveLocation = ProjectDataArchiveOwnerRef & {
  state: ProjectDataArchiveLocationState;
  sessionId: string;
  migrationId: string | null;
  targetAggregateSha256: string | null;
  routingSchemaVersion: number;
};

/** Mirrors `ProjectDataArchiveOwnerRef` (src/project-data-archive/contract.ts). */
export type ProjectDataArchiveOwnerRef = {
  kind: ProjectDataArchiveOwnerKind;
  projectId: string;
  ownerName: string;
  generation: number;
};

/** Mirrors `ProjectDataArchiveLocationState` (src/project-data-archive/contract.ts). */
export type ProjectDataArchiveLocationState = 'root' | 'migrating' | 'archive_shard' | 'frozen';

/** Mirrors `ProjectDataArchiveOwnerKind` (src/project-data-archive/contract.ts). */
export type ProjectDataArchiveOwnerKind = 'root' | 'archive_shard';

/** Mirrors `IdeaWorkLinkCaps` (src/durable-objects/project-data/idea-work.ts). */
export interface IdeaWorkLinkCaps {
  /** Most links returned for one idea, per kind of thing linked. */
  perTargetCap: number;
  /** Most ideas one link query may ask about; longer lists are read in several queries. */
  maxTargets: number;
}

/** Mirrors `IdeaWorkSnapshot` (src/durable-objects/project-data/idea-work.ts). */
export interface IdeaWorkSnapshot {
  ideaId: string;
  sessions: IdeaWorkSessionRow[];
  needsInput: IdeaNeedsInputRow[];
  /** Project files this idea owns, through its own links or its strong chats'. */
  fileIds: string[];
  /** Pull request URLs recorded in the link store for this idea. Not canonicalized here. */
  pullRequestUrls: string[];
  /** Notes on the idea, excluding soft-deleted ones. Exact. */
  updates: number;
  /** The lists a per-idea cap truncated, so the caller can say "50+" instead of "50". */
  truncated: { sessions: boolean; files: boolean; pullRequests: boolean };
}

/** Mirrors `IdeaWorkSessionRow` (src/durable-objects/project-data/idea-work.ts). */
export interface IdeaWorkSessionRow {
  sessionId: string;
  topic: string | null;
  /** The chat session's own status. */
  sessionStatus: string;
  /** The task driving the chat, when it has one. */
  sessionTaskId: string | null;
  /** Epoch ms of the chat's last update. */
  lastActivityAt: number | null;
  /** Every relation recorded between this chat and the idea. */
  relations: LinkRelation[];
  /** True when at least one of those relations is a strong one. */
  strong: boolean;
  /** Epoch ms the earliest of those relations was first recorded. */
  linkedAt: number;
}

/** Mirrors `IdeaNeedsInputRow` (src/durable-objects/project-data/idea-work.ts). */
export interface IdeaNeedsInputRow {
  sessionId: string;
  question: string | null;
  askedAt: number;
}

/** Mirrors `LinkWrite` (src/durable-objects/project-data/links.ts). */
export interface LinkWrite extends Pick<
  ResourceLink,
  'sourceKind' | 'sourceId' | 'targetKind' | 'targetId' | 'relation' | 'origin' | 'context'
> {
  actorKind?: string | null;
  actorId?: string | null;
}

/** Mirrors `LinkLimits` (src/durable-objects/project-data/links.ts). */
export interface LinkLimits {
  touchIntervalMs: number;
  weakPerTarget: number;
  weakCleanupBatchSize: number;
  projectCap: number;
  storageHighWaterBytes: number;
}

/** Mirrors `LinkRemove` (src/durable-objects/project-data/links.ts). */
export type LinkRemove = Pick<
  LinkWrite,
  'sourceKind' | 'sourceId' | 'targetKind' | 'targetId' | 'relation'
>;

/** Mirrors `ResourceLink` (src/durable-objects/project-data/links.ts). */
export interface ResourceLink {
  sourceKind: LinkKind;
  sourceId: string;
  targetKind: LinkKind;
  targetId: string;
  relation: LinkRelation;
  origin: LinkOrigin;
  context: string | null;
  firstAt: number;
  lastAt: number;
  hitCount: number;
}

/** Mirrors `ResolveChatAgentStateInput` (src/routes/chat-agent-state.ts). */
export interface ResolveChatAgentStateInput {
  projectId: string;
  sessionId: string;
  lookupFailureEvent: string;
  stateFailureEvent?: string;
  /** Operational readers must not synthesize activity from a persisted plan. */
  includePlan?: boolean;
}

/** Mirrors `SessionIdlenessClassification` (src/services/session-idleness.ts). */
export interface SessionIdlenessClassification {
  idle: boolean;
  conclusive: boolean;
  reason: SessionIdlenessReason;
  activity: string | null;
  retryAt?: Date;
}

/** Mirrors `SessionIdlenessReason` (src/services/session-idleness.ts). */
export type SessionIdlenessReason =
  | 'idle'
  | 'runtime_work_lease_active'
  | 'prompt_turn_active'
  | 'prompt_turn_unknown'
  | 'idle_interval_pending'
  | 'completed_prompt_stale'
  | 'prompt_turn_stale';

/** Mirrors `SamDispatchReservation` (src/services/sam-dispatch-reservation.ts). */
export interface SamDispatchReservation {
  taskId: string;
  sessionId: string;
  initialMessageId: string;
  statusEventId: string;
  reconcileOnly?: boolean;
}

/** Mirrors `ReconciledSamDispatch` (src/services/sam-dispatch-reservation.ts). */
export interface ReconciledSamDispatch {
  taskId: string;
  sessionId: string;
  branchName: string;
  status: string;
  executionStep: string | null;
  recovered: true;
  dispatchState: 'confirmed' | 'uncertain';
}

/** Mirrors `TaskAssistantMessage` (src/services/task-final-assistant-message.ts). */
export type TaskAssistantMessage = TaskFinalAssistantMessage & {
  partialBefore?: boolean;
  truncated?: boolean;
};

/** Mirrors `ListAgentActivityTasksOptions` (src/services/agent-activity.ts). */
export interface ListAgentActivityTasksOptions {
  userId?: string;
  projectId?: string;
  activeOnly?: boolean;
  excludeTaskId?: string | null;
  /** Restrict the list to tasks that own this pull request. */
  ownsPullRequest?: PullRequestOwnerFilter;
  /** Restrict the list to these tasks (a team view classifies a known set of tasks). */
  taskIds?: readonly string[];
  limit?: number;
  nowMs?: number;
}

/** Mirrors `AgentActivityTask` (src/services/agent-activity.ts). */
export interface AgentActivityTask {
  triggeredBy?: string | null;
  connectorClientName?: string | null;
  id: string;
  title: string;
  status: string;
  executionStep: string | null;
  providerLimitReason?: string | null;
  /** Opaque wait generation; changes when a new blocked wait replaces an accepted resume. */
  providerLimitVersion?: string | null;
  projectId: string;
  projectName: string;
  userId: string;
  workspaceId: string | null;
  chatSessionId: string | null;
  supersededByTaskId: string | null;
  outputBranch: string | null;
  outputPrUrl: string | null;
  /** Branch the task's current workspace checked out; null before one exists. */
  workspaceBranch: string | null;
  priority: number;
  createdAt: string;
  startedAt: string | null;
  agentActivityState: AgentActivityState;
}

/** Mirrors `PullRequestOwnerFilter` (src/services/agent-activity.ts). */
export interface PullRequestOwnerFilter {
  /** The PR's head branch, matched against output and workspace branches. */
  headBranch?: string;
  /** The PR URL, matched against output, description, and explicit associations. */
  url?: string;
}

/** Mirrors `TriggerStatusUpdates` (src/services/trigger-status.ts). */
export interface TriggerStatusUpdates {
  status: TriggerStatus;
  nextFireAt?: string | null;
  autoPauseResetSequence?: SQL;
}

/** Mirrors `TokenBudget` (src/services/ai-token-budget.ts). */
export interface TokenBudget {
  inputTokens: number;
  outputTokens: number;
}

/** Mirrors `LimitKey` (src/services/connector-read-settings.ts). */
export type LimitKey<N extends string> = N extends `connector.${infer K}` ? K : never;

/** Mirrors `ConnectorSettings` (src/services/connector-settings-definition.ts). */
export interface ConnectorSettings {
  enabled: boolean;
  writeEnabled: boolean;
  clientRegistration: 'open' | 'allowlist';
  allowedRedirectHosts: string[];
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  readRateLimitPerMinute: number;
  writeRateLimitPerMinute: number;
  maxStartsPerUserPerHour: number;
  maxStartsPerUserPerDay: number;
}

/** Mirrors `ScheduleCreator` (src/durable-objects/project-data/project-event-schedules-authority.ts). */
export type ScheduleCreator = 'person' | 'agent' | 'system';

/**
 * Which stored account one agent profile resolves to for the caller in one project
 * (`apps/api/src/services/profile-account-bindings.ts`). Carries no secret material.
 */
export interface ProfileAccountBinding {
  profileId: string;
  agentType: string;
  /**
   * `account`: one of the caller's own stored credentials. `platform`: SAM's platform credential or
   * AI proxy for this agent. `paused`: a pinned account is switched off, so runs refuse to start
   * rather than fall back. `none`: no credential would be found.
   */
  state: 'account' | 'platform' | 'paused' | 'none';
  /** The resolution tier that decided: a profile pin, a project pin, the user default, the platform. */
  tier: 'profile' | 'project' | 'user' | 'platform' | null;
  /** Why a paused binding stopped, from the shared resolver's step reasons. */
  reason: string | null;
  /**
   * Opaque quota-pool key. Profiles with the same poolId draw on one provider quota; never treat
   * them as independent. Null when no account resolves.
   */
  poolId: string | null;
  /** The caller's own account. `name` is the Settings name; legacy rows have none. */
  account: { name: string | null; storage: 'account' | 'legacy' } | null;
  /** Usage-sample references belonging to this pool (internal; never returned to callers). */
  usageReferences: string[];
}
