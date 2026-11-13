/**
 * The ProjectData port: the ProjectData Durable Object reads and writes the operations use
 * (workstream W1 boundary), and the value shapes that cross it. Part of `./ports.ts`.
 */
import type {
  AgentMailboxMessage,
  CancelProjectEventSubscriptionInput,
  GetProjectEventSubscriptionInput,
  IdeaUpdateNote,
  LinkKind,
  ListProjectEventChannelsInput,
  ListProjectEventChannelSubscribersInput,
  MessageCursor,
  ProjectEventChannelHistory,
  ProjectEventChannelHistoryInput,
  ProjectEventChannelList,
  ProjectEventChannelSubscriberList,
  ProjectEventSubscriptionMutationResult,
  ProjectEventSubscriptionRecord,
  ProjectSchedule,
  ProjectScheduleList,
  ProjectScheduleMutationResult,
  SchedulePromptAuthor,
} from '@simple-agent-manager/shared';

import type {
  ArchivedToolPayloadListResult,
  ArchivedToolPayloadQuery,
  IdeaWorkLinkCaps,
  IdeaWorkSnapshot,
  LinkLimits,
  LinkRemove,
  LinkWrite,
  LogicalMessageRequest,
  LogicalMessageResult,
  LogicalTranscriptRequest,
  LogicalTranscriptResult,
  ProjectDataArchiveLocation,
  ProjectDataRootSearchCoverage,
  ProjectDataSearchMessagesWithArchiveMetadataResult,
  ResourceLink,
  ScheduleCreator,
} from './port-types';

/** A ProjectData attention marker that is still open. */
export interface AttentionMarker {
  id: string;
  sessionId: string;
  taskId: string | null;
  workspaceId: string | null;
  kind: string;
  source: string;
  sourceEventId: string | null;
  sourceMessageId: string | null;
  sourceNotificationId: string | null;
  reason: string | null;
  metadata: string | null;
  createdAt: number;
  expiresAt: number | null;
  resolvedAt: number | null;
  resolvedByMessageId: string | null;
  resolvedByActorType: string | null;
  resolvedReason: string | null;
  notificationUserId: string | null;
  nextEscalationAt: number | null;
  escalationCount: number;
  maxExpiresAt: number | null;
  resolvedAnswer: string | null;
}

export interface IdeaUpdate {
  id: string;
  ideaId: string;
  authorKind: 'user' | 'agent';
  authorUserId: string | null;
  authorName: string | null;
  sessionId: string | null;
  sessionTopic: string | null;
  body: string;
  quote: string | null;
  createdAt: string;
  editedAt: string | null;
}

export interface KnowledgeSearchHit {
  id: string;
  entityId: string;
  content: string;
  confidence: number;
  sourceType: string;
  sourceSessionId: string | null;
  createdAt: number;
  lastConfirmedAt: number;
  supersededBy: string | null;
  isActive: boolean;
  entityName: string;
  entityType: string;
}

export interface ResourceLinkSnapshot {
  exists: boolean;
  links: ResourceLink[];
  sessions: {
    id: string;
    topic: string | null;
    status: string;
    updatedAt: number;
    taskId: string | null;
  }[];
  totals: { sessions: number; strongSessions: number; ideas: number; files: number; prs: number };
}

/** ProjectData reads and writes the operations use (workstream W1 boundary). */
export interface OperationProjectDataPort {
  getSession(projectId: string, sessionId: string): Promise<Record<string, unknown> | null>;
  getSessionsByTaskIds(projectId: string, taskIds: string[]): Promise<Record<string, unknown>[]>;
  listSessions(
    projectId: string,
    status?: string | null,
    limit?: number,
    offset?: number,
    taskId?: string | null
  ): Promise<{ sessions: Record<string, unknown>[]; total: number }>;
  getArchivedToolPayloads(
    projectId: string,
    input: ArchivedToolPayloadQuery
  ): Promise<ArchivedToolPayloadListResult>;
  getMessages(
    projectId: string,
    sessionId: string,
    limit?: number,
    before?: MessageCursor | null,
    after?: MessageCursor | null,
    roles?: string[],
    compact?: boolean,
    order?: 'asc' | 'desc'
  ): Promise<{ messages: Record<string, unknown>[]; hasMore: boolean }>;
  searchMessagesWithArchiveMetadata(
    projectId: string,
    inputQuery: string,
    sessionId?: string | null,
    roles?: string[] | null,
    limit?: number,
    continuation?: string | null
  ): Promise<ProjectDataSearchMessagesWithArchiveMetadataResult>;
  getLogicalTranscriptPage(
    projectId: string,
    sessionId: string,
    request: LogicalTranscriptRequest
  ): Promise<LogicalTranscriptResult>;
  getLogicalMessage(
    projectId: string,
    sessionId: string,
    request: LogicalMessageRequest,
    owner?: ProjectDataArchiveLocation
  ): Promise<LogicalMessageResult>;
  resolveTranscriptOwner(projectId: string, sessionId: string): Promise<ProjectDataArchiveLocation>;
  getMailboxMessage(projectId: string, messageId: string): Promise<AgentMailboxMessage | null>;
  listActiveAttentionMarkers(projectId: string, sessionId: string): Promise<AttentionMarker[]>;
  searchKnowledgeObservations(
    projectId: string,
    query: string,
    entityType: string | null,
    minConfidence: number | null,
    limit: number
  ): Promise<KnowledgeSearchHit[]>;
  getIdeaWorkSnapshots(
    projectId: string,
    ideaIds: readonly string[],
    caps: IdeaWorkLinkCaps
  ): Promise<Record<string, IdeaWorkSnapshot>>;
  addIdeaUpdate(
    projectId: string,
    input: IdeaUpdateNote,
    minAgentIntervalMs: number
  ): Promise<IdeaUpdate>;
  listIdeaUpdates(
    projectId: string,
    ideaId: string,
    cursor: { createdAt: string; id: string } | null,
    limit: number
  ): Promise<{
    total: number;
    updates: IdeaUpdate[];
    nextCursor: { createdAt: string; id: string } | null;
  }>;
  deleteIdeaUpdate(
    projectId: string,
    ideaId: string,
    updateId: string,
    actorUserId: string,
    canModerate: boolean,
    now: string
  ): Promise<boolean>;
  recordResourceLink(
    projectId: string,
    input: LinkWrite,
    limits: LinkLimits
  ): Promise<'written' | 'skipped_cap' | 'skipped_storage'>;
  removeResourceLink(projectId: string, input: LinkRemove): Promise<void>;
  listResourceLinks(
    projectId: string,
    kind: LinkKind,
    id: string,
    cap: number
  ): Promise<ResourceLink[]>;
  listLinksForTargets(
    projectId: string,
    kind: LinkKind,
    ids: string[],
    perTargetCap: number,
    maxTargets: number
  ): Promise<ResourceLink[]>;
  getResourceLinkSnapshot(
    projectId: string,
    kind: LinkKind,
    id: string,
    cap: number
  ): Promise<ResourceLinkSnapshot>;
  listProjectEventChannels(
    projectId: string,
    input?: Omit<ListProjectEventChannelsInput, 'projectId'>
  ): Promise<ProjectEventChannelList>;
  getProjectEventChannelHistory(
    projectId: string,
    input: Omit<ProjectEventChannelHistoryInput, 'projectId'>
  ): Promise<ProjectEventChannelHistory>;
  listProjectEventChannelSubscribers(
    projectId: string,
    input: Omit<ListProjectEventChannelSubscribersInput, 'projectId'>
  ): Promise<ProjectEventChannelSubscriberList>;
  getProjectEventSubscription(
    projectId: string,
    input: Omit<GetProjectEventSubscriptionInput, 'projectId'>
  ): Promise<ProjectEventSubscriptionRecord | null>;
  cancelProjectEventSubscription(
    projectId: string,
    input: Omit<CancelProjectEventSubscriptionInput, 'projectId'>
  ): Promise<ProjectEventSubscriptionMutationResult>;
  getProjectSchedule(
    projectId: string,
    input: { userId: string; id: string }
  ): Promise<ProjectSchedule | null>;
  listProjectSchedules(
    projectId: string,
    input: { userId: string; cursor?: string; sessionId?: string; limit?: number }
  ): Promise<ProjectScheduleList>;
  createProjectSchedule(
    projectId: string,
    input: {
      userId: string;
      creatorChatSessionId: string | null;
      creator: ScheduleCreator;
      promptAuthor: SchedulePromptAuthor;
      request: unknown;
    }
  ): Promise<ProjectScheduleMutationResult>;
  mutateProjectSchedule(
    projectId: string,
    input: { userId: string; id: string; operation: 'reschedule' | 'cancel'; request: unknown }
  ): Promise<ProjectScheduleMutationResult>;
  /** True for `agent-dm.*` pair channels, which are private agent-to-agent threads. */
  isAgentMessageChannelName(name: string): boolean;
  normalizeNullableText(value: unknown, field: string, maxBytes: number): string | null;
  /** Classifies a ProjectData event/channel error; null for anything that is not one. */
  classifyEventError(error: unknown): ProjectEventErrorKind | null;
  describeRootSearchCoverage(coverage: ProjectDataRootSearchCoverage | null): string[];
}

export type ProjectEventErrorKind =
  'not_found' | 'cursor' | 'validation' | 'limit_exceeded' | 'idempotency_conflict';
