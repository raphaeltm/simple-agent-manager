import type {
  CreateProjectEventSubscriptionInput,
  ProjectEventAdmissionResult,
  ProjectEventRecord,
  ProjectEventAgentVisibility,
  ProjectEventSubscriptionMutationResult,
} from './project-events';

/** Reserved provenance. Agent input is always evidence, never wake instructions. */
export const PROJECT_EVENT_CHANNEL_SOURCE = 'sam.agent_channel';
export const PROJECT_EVENT_CHANNEL_TYPE = 'agent.channel.published';

export type ProjectEventChannelActor = {
  userId: string;
  taskId: string;
  chatSessionId: string;
  workspaceId: string;
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
  limit?: number | null;
};
