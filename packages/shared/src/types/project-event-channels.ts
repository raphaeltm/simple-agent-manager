import type {
  CreateProjectEventSubscriptionInput,
  ProjectEventAdmissionResult,
  ProjectEventAgentVisibility,
  ProjectEventJsonValue,
  ProjectEventRecord,
  ProjectEventSubscriptionMutationResult,
} from './project-events';

/** Reserved provenance. Agent input is always evidence, never wake instructions. */
export const PROJECT_EVENT_CHANNEL_SOURCE = 'sam.agent_channel';
export const PROJECT_EVENT_CHANNEL_TYPE = 'agent.channel.published';

/**
 * Reserved name prefix for SAM-managed agent-to-agent message channels. Only the
 * messaging tools publish here; generic `publish_channel_event` rejects it.
 */
export const AGENT_MESSAGE_CHANNEL_PREFIX = 'agent-dm.';

export type ProjectEventChannelActor = {
  userId: string;
  taskId: string;
  chatSessionId: string;
  workspaceId: string;
  agentSessionId?: string | null;
};

export type ProjectEventChannel = {
  id: string;
  name: string;
  lifetimeCount: number;
  lastPublishedAt: number;
};

export type PublishProjectEventChannelInput = {
  projectId: string;
  channel: string;
  idempotencyKey: string;
  message: string;
  actor: ProjectEventChannelActor;
};

export type PublishProjectEventChannelResult = ProjectEventAdmissionResult & {
  channel: ProjectEventChannel;
  sequence: number;
};

export type ListProjectEventChannelsInput = {
  projectId: string;
  after?: string | null;
  limit?: number | null;
};

export type ProjectEventChannelList = {
  channels: ProjectEventChannel[];
  nextCursor: string | null;
};

export type ProjectEventChannelHistoryInput = {
  projectId: string;
  channel: string;
  cursor?: string | null;
  limit?: number | null;
};

export type ProjectEventChannelHistory = {
  channel: ProjectEventChannel;
  events: Array<{ sequence: number; event: ProjectEventRecord }>;
  /** Pass to follow, or continue history with this cursor when hasMore is true. */
  cursor: string;
  hasMore: boolean;
  watermark: number;
  /** Retention removed at least one sequence covered by this history page. */
  retentionGap: boolean;
};

export type FollowProjectEventChannelInput = Omit<CreateProjectEventSubscriptionInput, 'filter'> & {
  channel: string;
  /** Server-resolved default, used only on first creation when expiresAt is omitted. */
  defaultExpiresAt?: number;
  actor: ProjectEventChannelActor;
  /** Omit to follow only future events. A history cursor resumes after consumed history. */
  cursor?: string | null;
};

export type FollowProjectEventChannelResult = ProjectEventSubscriptionMutationResult & {
  watermark: number;
  caughtUpThrough: number;
  hasMore: boolean;
};

export type CatchUpProjectEventChannelInput = {
  projectId: string;
  subscriptionId: string;
  visibility: ProjectEventAgentVisibility;
  actor: ProjectEventChannelActor;
  limit?: number | null;
};

/** Ordinary message classes carried over agent message channels. Urgent classes keep stop-and-deliver. */
export type AgentChannelMessageClass = 'notify' | 'deliver';

export type AgentChannelMessageParticipant = {
  taskId: string;
  /** Stable source-task authority (recovery_source_task_id ?? id) for the managed subscription. */
  sourceTaskId: string;
  chatSessionId: string;
};

export type SendAgentChannelMessageInput = {
  projectId: string;
  /** Server-derived sender identity; ProjectData re-verifies it before committing. */
  actor: ProjectEventChannelActor;
  senderSourceTaskId: string;
  recipient: AgentChannelMessageParticipant;
  message: string;
  messageClass: AgentChannelMessageClass;
  idempotencyKey: string;
  senderMetadata?: Record<string, ProjectEventJsonValue> | null;
};

export type SendAgentChannelMessageResult = {
  outcome: 'created' | 'duplicate_replay';
  channel: ProjectEventChannel;
  eventId: string;
  sequence: number;
  /** Recipient subscription holding the canonical match (null only for an unmatched replay). */
  recipientSubscriptionId: string | null;
  senderSubscriptionId: string | null;
  /** Managed subscriptions retired because they could no longer wake their session. */
  rotatedSubscriptionIds: string[];
};
