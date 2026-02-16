// =============================================================================
// VM Agent Control Messages (WebSocket protocol)
// =============================================================================

/** Status values for agent lifecycle updates */
export type AgentSessionStatus = 'starting' | 'installing' | 'ready' | 'error' | 'restarting';

/** Sent by VM Agent to browser: agent lifecycle status update */
export interface AgentStatusMessage {
  type: 'agent_status';
  status: AgentSessionStatus;
  agentType: string;
  error?: string;
}

/** Sent by browser to VM Agent: request to select/switch agent */
export interface SelectAgentMessage {
  type: 'select_agent';
  agentType: string;
}

// --- Multi-viewer session control messages ---

/** Sent by VM Agent on viewer attach: current session state + replay count */
export interface SessionStateMessage {
  type: 'session_state';
  status: string;
  agentType?: string;
  error?: string;
  replayCount: number;
}

/** Sent by VM Agent after all buffered messages have been replayed to a viewer */
export interface SessionReplayCompleteMessage {
  type: 'session_replay_complete';
}

/** Sent by VM Agent when a prompt starts (all viewers can disable input) */
export interface SessionPromptingMessage {
  type: 'session_prompting';
}

/** Sent by VM Agent when a prompt finishes */
export interface SessionPromptDoneMessage {
  type: 'session_prompt_done';
}

/** Union of all control messages (non-ACP) */
export type ControlMessage =
  | AgentStatusMessage
  | SelectAgentMessage
  | SessionStateMessage
  | SessionReplayCompleteMessage
  | SessionPromptingMessage
  | SessionPromptDoneMessage;

/** All known control message type strings */
const CONTROL_MESSAGE_TYPES = new Set([
  'agent_status',
  'select_agent',
  'session_state',
  'session_replay_complete',
  'session_prompting',
  'session_prompt_done',
]);

/** Check if a parsed message is a control message (vs ACP JSON-RPC) */
export function isControlMessage(msg: unknown): msg is ControlMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'type' in msg &&
    CONTROL_MESSAGE_TYPES.has((msg as ControlMessage).type)
  );
}

// =============================================================================
// Lifecycle Logging (Observability)
// =============================================================================

/** Structured lifecycle event for observability logging */
export interface AcpLifecycleEvent {
  source: 'acp-session' | 'acp-transport' | 'acp-chat';
  level: 'info' | 'warn' | 'error';
  message: string;
  context?: Record<string, unknown>;
}

/** Callback for lifecycle event logging (injected by consumer) */
export type LifecycleEventCallback = (event: AcpLifecycleEvent) => void;
