import type { AgentStatusMessage } from './types';
import { isControlMessage } from './types';

/**
 * Callback for receiving agent status control messages from the VM Agent.
 */
export type AgentStatusCallback = (msg: AgentStatusMessage) => void;

/**
 * Callback for receiving ACP JSON-RPC messages from the agent.
 */
export type AcpMessageCallback = (data: unknown) => void;

/**
 * ACP WebSocket transport adapter.
 *
 * Bridges a browser WebSocket connection to the VM Agent's /agent/ws endpoint,
 * separating control messages (agent_status, select_agent) from ACP JSON-RPC
 * messages. ACP messages are forwarded to the onAcpMessage callback; control
 * messages to onAgentStatus.
 */
export interface AcpTransport {
  /** Send a raw ACP JSON-RPC message to the agent via WebSocket. */
  sendAcpMessage(message: unknown): void;
  /** Send a select_agent control message to the VM Agent. */
  sendSelectAgent(agentType: string): void;
  /** Close the WebSocket connection. */
  close(): void;
  /** Whether the WebSocket is currently open. */
  readonly connected: boolean;
}

/**
 * Create an ACP WebSocket transport connected to the VM Agent.
 *
 * @param ws - An open WebSocket connection to /agent/ws
 * @param onAgentStatus - Callback for agent_status control messages
 * @param onAcpMessage - Callback for ACP JSON-RPC messages from the agent
 * @param onClose - Callback when the WebSocket closes
 * @param onError - Callback when a WebSocket error occurs
 */
export function createAcpWebSocketTransport(
  ws: WebSocket,
  onAgentStatus: AgentStatusCallback,
  onAcpMessage: AcpMessageCallback,
  onClose?: () => void,
  onError?: (error: Event) => void
): AcpTransport {
  ws.addEventListener('message', (event) => {
    try {
      const data = JSON.parse(event.data as string);
      if (isControlMessage(data)) {
        if (data.type === 'agent_status') {
          onAgentStatus(data);
        }
      } else {
        onAcpMessage(data);
      }
    } catch {
      // Ignore non-JSON messages
    }
  });

  if (onClose) {
    ws.addEventListener('close', onClose);
  }
  if (onError) {
    ws.addEventListener('error', onError);
  }

  return {
    sendAcpMessage(message: unknown) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
      }
    },

    sendSelectAgent(agentType: string) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'select_agent', agentType }));
      }
    },

    close() {
      ws.close();
    },

    get connected() {
      return ws.readyState === WebSocket.OPEN;
    },
  };
}
