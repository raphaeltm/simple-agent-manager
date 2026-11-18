import type { ChatMessageAppend, TaskExecutionStep } from '@simple-agent-manager/shared';

import type { ChatMessageResponse, ChatSessionResponse, SessionStateSnapshot } from '../lib/api';
import type { MessageCommentRealtimeEvent } from '../lib/api/comments';
import type { PromptDeliveryUpdate } from '../lib/prompt-delivery-update';

export type ChatConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

/** Fields a `session.updated` push may change on the open session. */
export type SessionUpdatedFields = Partial<
  Pick<ChatSessionResponse, 'topic' | 'workspaceId' | 'agentSessionId' | 'status'>
>;

export interface UseChatWebSocketOptions {
  projectId: string;
  sessionId: string;
  /** Only connect when the session is active. */
  enabled: boolean;
  /** Called when a new message arrives via WebSocket (single or from batch). */
  onMessage: (msg: ChatMessageResponse) => void;
  /** False requests recovery of a missing canonical base or revision gap. */
  onMessageAppend?: (append: ChatMessageAppend) => boolean;
  /** Called when the session is stopped server-side. */
  onSessionStopped: () => void;
  /**
   * Called when the socket opens with no earlier connection to catch up from: on a page load,
   * and when a chat that was asleep wakes. The consumer's last REST read can predate this
   * subscription, and a row persisted in between reached no socket, so the consumer reads
   * forward from the newest row it holds and merges what it finds.
   */
  onSubscribed?: () => void;
  /** Called when we catch up with missed messages after reconnect. */
  onCatchUp: (
    messages: ChatMessageResponse[],
    session: ChatSessionResponse,
    state?: SessionStateSnapshot | null,
    toolChanges?: import('../lib/api/session-transcript-types').ToolSnapshotChanges
  ) => void | Promise<void>;
  /** Called when the agent completes on the session. */
  onAgentCompleted?: (agentCompletedAt: number) => void;
  /** A durable delivery changed state (`mailbox.delivery_updated`); names the transcript row. */
  onDeliveryUpdate?: (update: PromptDeliveryUpdate) => void;
  /** Called when a session.activity event arrives (prompting/idle). */
  onAgentActivity?: (
    activity: 'prompting' | 'idle' | 'recovering' | 'error',
    promptStartedAt?: number | null,
    /** Whether the agent's adapter can steer; absent when the server has no report yet. */
    steeringSupported?: boolean
  ) => void;
  /** Called when the session metadata or lifecycle status changes server-side. */
  onSessionUpdated?: (updates: SessionUpdatedFields) => void;
  /**
   * Called when the replacement TaskRunner waking this sleeping session advances a
   * phase. Pushed so the wake banner updates without waiting for the fallback poll.
   */
  onWakeProgress?: (progress: WakeProgressUpdate) => void;
  /** Called for server-authoritative message-comment events carried over the session socket. */
  onCommentEvent?: (event: MessageCommentRealtimeEvent) => void;
  /** Called when someone shares this session or removes access, so the viewer re-checks theirs. */
  onSessionAccessChanged?: () => void;
}

/** Live wake phase delta broadcast by the ProjectData DO (`session.wake_progress`). */
export interface WakeProgressUpdate {
  recoveryStatus: 'waking' | 'restored' | 'failed';
  wakePhase: TaskExecutionStep | null;
  /** The wake claim the push belongs to; null or absent from a server that predates it. */
  wakeAttemptId?: string | null;
}

export interface UseChatWebSocketReturn {
  connectionState: ChatConnectionState;
  wsRef: React.RefObject<WebSocket | null>;
  retry: () => void;
}
