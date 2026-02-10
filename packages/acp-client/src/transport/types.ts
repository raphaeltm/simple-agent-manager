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

/** Union of all control messages (non-ACP) */
export type ControlMessage = AgentStatusMessage | SelectAgentMessage;

/** Check if a parsed message is a control message (vs ACP JSON-RPC) */
export function isControlMessage(msg: unknown): msg is ControlMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'type' in msg &&
    ((msg as ControlMessage).type === 'agent_status' ||
      (msg as ControlMessage).type === 'select_agent')
  );
}
