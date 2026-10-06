export const CHECKPOINT_EPISODE_STATES = [
  'planned',
  'preempt_requested',
  'waiting_ready',
  'resume_queued',
  'resume_delivering',
  'resumed',
  'completed',
  'ambiguous_delivery',
  'failed_recoverable',
  'failed_terminal',
  'superseded',
  'cancelled',
] as const;

export type CheckpointEpisodeState = (typeof CHECKPOINT_EPISODE_STATES)[number];

export const CHECKPOINT_EPISODE_TRANSITIONS: Readonly<
  Record<CheckpointEpisodeState, readonly CheckpointEpisodeState[]>
> = {
  planned: ['preempt_requested', 'cancelled', 'superseded', 'failed_terminal'],
  preempt_requested: ['waiting_ready', 'failed_recoverable', 'failed_terminal', 'cancelled'],
  waiting_ready: ['resume_queued', 'failed_recoverable', 'failed_terminal', 'cancelled'],
  resume_queued: ['resume_delivering', 'cancelled', 'superseded', 'failed_terminal'],
  resume_delivering: [
    'resumed',
    'ambiguous_delivery',
    'failed_recoverable',
    'failed_terminal',
    'cancelled',
  ],
  resumed: ['completed', 'failed_recoverable', 'failed_terminal', 'cancelled'],
  completed: [],
  ambiguous_delivery: [],
  failed_recoverable: ['resume_queued', 'cancelled', 'failed_terminal'],
  failed_terminal: [],
  superseded: [],
  cancelled: [],
};

export interface CheckpointProgressEnvelope {
  messageSequence: number | null;
  progressAt: number | null;
  gitHead: string | null;
  gitFingerprint: string | null;
  taskStatus: string | null;
  taskExecutionStep: string | null;
  childStatuses: Readonly<Record<string, string>>;
  metadata: Readonly<Record<string, string | number | boolean | null>>;
}

export interface CheckpointEpisode {
  id: string;
  sessionId: string;
  taskId: string | null;
  workspaceId: string | null;
  acpSessionId: string;
  promptEpoch: number;
  reason: string;
  state: CheckpointEpisodeState;
  progressEnvelope: CheckpointProgressEnvelope | null;
  mailboxMessageId: string | null;
  promptDeliveryId: string | null;
  preemptRequestedAt: number | null;
  preemptAcceptedAt: number | null;
  readyObservedAt: number | null;
  resumeAcceptedAt: number | null;
  completedAt: number | null;
  failedAt: number | null;
  attemptCount: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateCheckpointEpisodeInput {
  sessionId: string;
  taskId?: string | null;
  workspaceId?: string | null;
  acpSessionId: string;
  promptEpoch: number;
  reason: string;
  progressEnvelope?: CheckpointProgressEnvelope | null;
}

export interface CheckpointEpisodeTransitionInput {
  toState: CheckpointEpisodeState;
  expectedState?: CheckpointEpisodeState;
  lastError?: string | null;
  incrementAttempt?: boolean;
  mailboxMessageId?: string | null;
  promptDeliveryId?: string | null;
}
