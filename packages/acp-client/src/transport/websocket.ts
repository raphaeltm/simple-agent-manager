import type {
  AgentStatusMessage,
  SessionStateMessage,
  LifecycleEventCallback,
} from './types';
import { isControlMessage } from './types';

/**
 * Callback for receiving agent status control messages from the VM Agent.
 */
export type AgentStatusCallback = (msg: AgentStatusMessage) => void;

/**
 * Callback for receiving session state on viewer attach.
 */
export type SessionStateCallback = (msg: SessionStateMessage) => void;

/**
 * Callback for session replay completion.
 */
export type SessionReplayCompleteCallback = () => void;

/**
 * Callback for session prompting state changes.
 */
export type SessionPromptingCallback = (prompting: boolean) => void;

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

/** Options for creating the ACP WebSocket transport. */
export interface AcpTransportOptions {
  /** An open WebSocket connection to /agent/ws */
  ws: WebSocket;
  /** Callback for agent_status control messages */
  onAgentStatus: AgentStatusCallback;
  /** Callback for ACP JSON-RPC messages from the agent */
  onAcpMessage: AcpMessageCallback;
  /** Callback when the WebSocket closes */
  onClose?: () => void;
  /** Callback when a WebSocket error occurs */
  onError?: (error: Event) => void;
  /** Optional callback for lifecycle observability logging */
  onLifecycleEvent?: LifecycleEventCallback;
  /** Callback for session_state control messages (multi-viewer) */
  onSessionState?: SessionStateCallback;
  /** Callback for session_replay_complete control messages */
  onSessionReplayComplete?: SessionReplayCompleteCallback;
  /** Callback for session_prompting / session_prompt_done */
  onSessionPrompting?: SessionPromptingCallback;
}

/**
 * Create an ACP WebSocket transport connected to the VM Agent.
 *
 * Supports both the positional argument signature (backward compat) and
 * the options object signature. Prefer the options object for new code.
 */
export function createAcpWebSocketTransport(
  wsOrOptions: WebSocket | AcpTransportOptions,
  onAgentStatus?: AgentStatusCallback,
  onAcpMessage?: AcpMessageCallback,
  onClose?: () => void,
  onError?: (error: Event) => void,
  onLifecycleEvent?: LifecycleEventCallback
): AcpTransport {
  // Normalize to options object
  let opts: AcpTransportOptions;
  if (wsOrOptions instanceof WebSocket) {
    opts = {
      ws: wsOrOptions,
      onAgentStatus: onAgentStatus!,
      onAcpMessage: onAcpMessage!,
      onClose,
      onError,
      onLifecycleEvent,
    };
  } else {
    opts = wsOrOptions;
  }

  const { ws } = opts;

  ws.addEventListener('message', (event) => {
    try {
      const data = JSON.parse(event.data as string);
      if (isControlMessage(data)) {
        switch (data.type) {
          case 'agent_status':
            opts.onAgentStatus(data);
            break;
          case 'session_state':
            opts.onSessionState?.(data);
            break;
          case 'session_replay_complete':
            opts.onSessionReplayComplete?.();
            break;
          case 'session_prompting':
            opts.onSessionPrompting?.(true);
            break;
          case 'session_prompt_done':
            opts.onSessionPrompting?.(false);
            break;
          default:
            break;
        }
      } else {
        opts.onAcpMessage(data);
      }
    } catch {
      opts.onLifecycleEvent?.({
        source: 'acp-transport',
        level: 'warn',
        message: 'Failed to parse WebSocket message as JSON',
        context: {
          dataLength: typeof event.data === 'string' ? event.data.length : 0,
          preview: typeof event.data === 'string' ? event.data.slice(0, 200) : 'non-string',
        },
      });
    }
  });

  if (opts.onClose) {
    ws.addEventListener('close', opts.onClose);
  }
  if (opts.onError) {
    ws.addEventListener('error', opts.onError);
  }

  return {
    sendAcpMessage(message: unknown) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
      } else {
        opts.onLifecycleEvent?.({
          source: 'acp-transport',
          level: 'warn',
          message: 'Send failed: WebSocket not open',
          context: { readyState: ws.readyState, messageType: 'acp' },
        });
      }
    },

    sendSelectAgent(agentType: string) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'select_agent', agentType }));
      } else {
        opts.onLifecycleEvent?.({
          source: 'acp-transport',
          level: 'warn',
          message: 'Send failed: WebSocket not open',
          context: { readyState: ws.readyState, messageType: 'select_agent', agentType },
        });
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
