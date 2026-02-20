import type {
  AgentStatusMessage,
  SessionStateMessage,
  LifecycleEventCallback,
} from './types';
import { isControlMessage } from './types';

/** Default interval between application-level pings (ms). Override via AcpTransportOptions. */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
/** Default pong response deadline (ms). If no pong arrives within this time, the connection is considered dead. */
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 10_000;

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
  /** Application-level heartbeat ping interval in ms (default: 30000). Set to 0 to disable. */
  heartbeatIntervalMs?: number;
  /** Pong response deadline in ms (default: 10000). Connection closed if exceeded. */
  heartbeatTimeoutMs?: number;
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
  // Normalize to options object.
  // Duck-type check: if wsOrOptions has addEventListener it's a WebSocket
  // (positional args form), otherwise it's an options object.
  let opts: AcpTransportOptions;
  if ('addEventListener' in wsOrOptions && typeof (wsOrOptions as WebSocket).addEventListener === 'function') {
    opts = {
      ws: wsOrOptions as WebSocket,
      onAgentStatus: onAgentStatus!,
      onAcpMessage: onAcpMessage!,
      onClose,
      onError,
      onLifecycleEvent,
    };
  } else {
    opts = wsOrOptions as AcpTransportOptions;
  }

  const { ws } = opts;

  // --- Application-level heartbeat ---
  // Sends JSON {"type":"ping"} and expects {"type":"pong"} back.
  // Works through any proxy (Cloudflare, etc.) because these are regular
  // data frames, not WebSocket protocol-level control frames.
  const heartbeatInterval = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const heartbeatTimeout = opts.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let pongTimer: ReturnType<typeof setTimeout> | null = null;
  let waitingForPong = false;

  function startHeartbeat() {
    if (heartbeatInterval <= 0) return;
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      waitingForPong = true;
      ws.send(JSON.stringify({ type: 'ping' }));
      // Start pong deadline timer
      pongTimer = setTimeout(() => {
        if (!waitingForPong) return;
        opts.onLifecycleEvent?.({
          source: 'acp-transport',
          level: 'warn',
          message: 'Heartbeat pong timeout — closing connection to trigger reconnect',
          context: { heartbeatTimeoutMs: heartbeatTimeout },
        });
        // Force-close to trigger the onClose → reconnect path
        ws.close(4000, 'heartbeat_timeout');
      }, heartbeatTimeout);
    }, heartbeatInterval);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
    waitingForPong = false;
  }

  function handlePong() {
    waitingForPong = false;
    if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
  }

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
          case 'pong':
            handlePong();
            break;
          case 'ping':
            // Server shouldn't send pings to client, but respond if it does
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'pong' }));
            }
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

  // Start heartbeat once connection is open
  ws.addEventListener('open', () => {
    startHeartbeat();
  });

  // If already open (e.g. passed after open event), start immediately
  if (ws.readyState === WebSocket.OPEN) {
    startHeartbeat();
  }

  const wrappedOnClose = () => {
    stopHeartbeat();
    opts.onClose?.();
  };

  ws.addEventListener('close', wrappedOnClose);

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
      stopHeartbeat();
      ws.close();
    },

    get connected() {
      return ws.readyState === WebSocket.OPEN;
    },
  };
}
