/**
 * AdminLogs Durable Object — singleton for real-time admin log streaming.
 *
 * Accepts WebSocket connections from superadmin clients and broadcasts
 * log events forwarded by the Tail Worker. Supports per-client filtering
 * (by severity level), pause/resume, and ping/pong keep-alive.
 *
 * Uses Hibernatable WebSocket API for efficient connection management.
 *
 * See: specs/023-admin-observability/research.md (R2)
 * See: specs/023-admin-observability/data-model.md
 */
import { DurableObject } from 'cloudflare:workers';

type Env = {
  OBSERVABILITY_STREAM_BUFFER_SIZE?: string;
};

/** Per-client filter/state stored via serializeAttachment. */
interface ClientState {
  levels: Set<string>;
  search: string;
  paused: boolean;
}

const DEFAULT_BUFFER_SIZE = 1000;
const ALL_LEVELS = new Set(['error', 'warn', 'info']);

export class AdminLogs extends DurableObject<Env> {
  /** In-memory ring buffer of recent log entries for replay on connect. */
  private buffer: LogBufferEntry[] = [];
  private bufferMaxSize: number;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.bufferMaxSize = parseInt(env.OBSERVABILITY_STREAM_BUFFER_SIZE || '', 10) || DEFAULT_BUFFER_SIZE;
  }

  // =========================================================================
  // HTTP fetch handler — WebSocket upgrade + log ingestion
  // =========================================================================

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade for admin clients
    if (url.pathname === '/ws') {
      return this.handleWebSocketUpgrade(request);
    }

    // Log ingestion from Tail Worker
    if (url.pathname === '/ingest' && request.method === 'POST') {
      return this.handleLogIngestion(request);
    }

    return new Response('Not found', { status: 404 });
  }

  // =========================================================================
  // WebSocket lifecycle (Hibernatable WebSocket API)
  // =========================================================================

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;

    let parsed: { type?: string; levels?: string[]; search?: string };
    try {
      parsed = JSON.parse(message);
    } catch {
      return; // Ignore non-JSON
    }

    const state = this.getClientState(ws);

    switch (parsed.type) {
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;

      case 'filter':
        if (Array.isArray(parsed.levels)) {
          state.levels = new Set(parsed.levels.filter((l) => ALL_LEVELS.has(l)));
        }
        if (typeof parsed.search === 'string') {
          state.search = parsed.search;
        }
        this.setClientState(ws, state);
        break;

      case 'pause':
        state.paused = true;
        this.setClientState(ws, state);
        break;

      case 'resume':
        state.paused = false;
        this.setClientState(ws, state);
        break;
    }
  }

  async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    ws.close();
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    ws.close();
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  private handleWebSocketUpgrade(request: Request): Response {
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const pair = new WebSocketPair();
    const serverWs = pair[1];

    // Initialize client state
    this.ctx.acceptWebSocket(serverWs);
    this.setClientState(serverWs, {
      levels: new Set(ALL_LEVELS),
      search: '',
      paused: false,
    });

    // Send connection status
    serverWs.send(JSON.stringify({
      type: 'status',
      connected: true,
      clientCount: this.ctx.getWebSockets().length,
    }));

    // Replay recent buffer entries to the new client
    for (const entry of this.buffer) {
      try {
        serverWs.send(JSON.stringify(entry));
      } catch {
        break; // Socket closed during replay
      }
    }

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private async handleLogIngestion(request: Request): Promise<Response> {
    let body: { logs?: LogBufferEntry[] };
    try {
      body = await request.json() as { logs?: LogBufferEntry[] };
    } catch {
      return new Response('Invalid JSON', { status: 400 });
    }

    const logs = body.logs;
    if (!Array.isArray(logs) || logs.length === 0) {
      return new Response('No logs', { status: 200 });
    }

    // Add to ring buffer
    for (const log of logs) {
      this.buffer.push(log);
    }

    // Trim buffer to max size (FIFO eviction)
    if (this.buffer.length > this.bufferMaxSize) {
      this.buffer = this.buffer.slice(this.buffer.length - this.bufferMaxSize);
    }

    // Broadcast to connected clients
    this.broadcastLogs(logs);

    return new Response('OK', { status: 200 });
  }

  private broadcastLogs(logs: LogBufferEntry[]): void {
    const sockets = this.ctx.getWebSockets();

    for (const ws of sockets) {
      const state = this.getClientState(ws);
      if (state.paused) continue;

      for (const log of logs) {
        // Apply per-client level filter
        const logLevel = log.entry?.level;
        if (logLevel && state.levels.size > 0 && !state.levels.has(logLevel)) {
          continue;
        }

        // Apply per-client search filter
        if (state.search) {
          const searchLower = state.search.toLowerCase();
          const message = log.entry?.message?.toLowerCase() ?? '';
          const event = log.entry?.event?.toLowerCase() ?? '';
          if (!message.includes(searchLower) && !event.includes(searchLower)) {
            continue;
          }
        }

        try {
          ws.send(JSON.stringify(log));
        } catch {
          // Socket may be closed; ignore
        }
      }
    }
  }

  private getClientState(ws: WebSocket): ClientState {
    try {
      const raw = ws.deserializeAttachment() as SerializedClientState | null;
      if (raw) {
        return {
          levels: new Set(raw.levels ?? [...ALL_LEVELS]),
          search: raw.search ?? '',
          paused: raw.paused ?? false,
        };
      }
    } catch {
      // Ignore deserialization errors
    }
    return { levels: new Set(ALL_LEVELS), search: '', paused: false };
  }

  private setClientState(ws: WebSocket, state: ClientState): void {
    const serialized: SerializedClientState = {
      levels: [...state.levels],
      search: state.search,
      paused: state.paused,
    };
    ws.serializeAttachment(serialized);
  }
}

/** Serializable form of ClientState (Sets are not JSON-serializable). */
interface SerializedClientState {
  levels: string[];
  search: string;
  paused: boolean;
}

/** Log entry shape from Tail Worker. */
interface LogBufferEntry {
  type: 'log';
  entry: {
    timestamp: string;
    level: string;
    event: string;
    message: string;
    details: Record<string, unknown>;
    scriptName: string;
  };
}
