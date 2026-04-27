/**
 * SamSession Durable Object — per-user SAM chat session manager.
 *
 * One instance per user (keyed by userId). Manages conversations and messages
 * in embedded SQLite, runs the agent loop, and streams SSE responses.
 */
import {
  DEFAULT_SAM_CONVERSATION_CONTEXT_WINDOW,
  DEFAULT_SAM_MAX_CONVERSATIONS,
  DEFAULT_SAM_MAX_MESSAGES_PER_CONVERSATION,
  resolveSamConfig,
} from '@simple-agent-manager/shared';
import { DurableObject } from 'cloudflare:workers';

import type { Env as AppEnv } from '../../env';
import { createModuleLogger } from '../../lib/logger';
import { runAgentLoop } from './agent-loop';
import type { ConversationRow, MessageRow, SamSseEvent } from './types';

const log = createModuleLogger('sam_session');

/** SQLite migration for the SamSession DO. */
function migrate(sql: SqlStorage): void {
  // Create migrations tracking table
  sql.exec(`
    CREATE TABLE IF NOT EXISTS sam_migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);

  const applied = new Set(
    sql.exec('SELECT name FROM sam_migrations').toArray().map((r) => String(r.name))
  );

  if (!applied.has('001-initial')) {
    sql.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        title TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    sql.exec(`CREATE INDEX idx_conversations_updated ON conversations(updated_at DESC)`);

    sql.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        tool_calls_json TEXT,
        tool_call_id TEXT,
        sequence INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    sql.exec(`CREATE INDEX idx_messages_conv_seq ON messages(conversation_id, sequence ASC)`);

    sql.exec(`INSERT INTO sam_migrations (name) VALUES ('001-initial')`);
  }

  if (!applied.has('002-rate-limits')) {
    sql.exec(`
      CREATE TABLE rate_limits (
        id INTEGER PRIMARY KEY,
        window_start INTEGER NOT NULL,
        request_count INTEGER NOT NULL DEFAULT 0
      )
    `);
    sql.exec(`INSERT INTO rate_limits (id, window_start, request_count) VALUES (1, 0, 0)`);
    sql.exec(`INSERT INTO sam_migrations (name) VALUES ('002-rate-limits')`);
  }
}

/** Encode an SSE event as unnamed data frame. */
function encodeSseEvent(event: SamSseEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

export class SamSession extends DurableObject<AppEnv> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      migrate(this.sql);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      // POST /chat — start or continue a conversation
      if (method === 'POST' && path === '/chat') {
        return await this.handleChat(request);
      }

      // GET /ping — diagnostic SSE test
      if (method === 'GET' && path === '/ping') {
        const { readable, writable } = new TransformStream<Uint8Array>();
        const w = writable.getWriter();
        this.ctx.waitUntil((async () => {
          await w.write(new TextEncoder().encode(`data: {"type":"pong","time":"${new Date().toISOString()}"}\n\n`));
          await w.close();
        })());
        return new Response(readable, {
          headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        });
      }

      // GET /conversations — list conversations
      if (method === 'GET' && path === '/conversations') {
        return this.handleListConversations();
      }

      // GET /conversations/:id/messages — get messages for a conversation
      const messagesMatch = path.match(/^\/conversations\/([^/]+)\/messages$/);
      if (method === 'GET' && messagesMatch) {
        return this.handleGetMessages(messagesMatch[1]!);
      }

      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    } catch (err) {
      log.error('sam_session.request_error', {
        path,
        method,
        error: err instanceof Error ? err.message : String(err),
      });
      return new Response(JSON.stringify({ error: 'Internal error' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }
  }

  /** Handle POST /chat — run the agent loop and stream SSE. */
  private async handleChat(request: Request): Promise<Response> {
    log.info('sam_session.chat_start', { phase: 'parsing_body' });

    // Temporary diagnostic: check if env vars are present
    const hasApiToken = !!(this.env as unknown as Record<string, unknown>).CF_API_TOKEN;
    const hasAccountId = !!(this.env as unknown as Record<string, unknown>).CF_ACCOUNT_ID;
    const hasGatewayId = !!(this.env as unknown as Record<string, unknown>).AI_GATEWAY_ID;
    log.info('sam_session.env_check', { hasApiToken, hasAccountId, hasGatewayId });

    const body = (await request.json()) as {
      conversationId?: string;
      message: string;
      userId: string;
    };

    if (!body.message?.trim()) {
      return new Response(JSON.stringify({ error: 'Message is required' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }

    const userId = body.userId;
    log.info('sam_session.chat_start', { phase: 'resolving_config', userId });
    const config = resolveSamConfig(this.env as unknown as Record<string, string | undefined>);
    log.info('sam_session.chat_config', { model: config.model, maxTurns: config.maxTurns });

    // Rate limit check
    const rateLimitResponse = this.checkRateLimit(config.rateLimitRpm, config.rateLimitWindowSeconds);
    if (rateLimitResponse) {
      return rateLimitResponse;
    }

    // Get or create conversation
    let conversationId = body.conversationId;
    if (!conversationId) {
      conversationId = crypto.randomUUID();
      this.createConversation(conversationId, body.message.slice(0, 100));
    } else {
      // Verify conversation exists
      const conv = this.sql.exec(
        'SELECT id FROM conversations WHERE id = ?',
        conversationId
      ).toArray();
      if (conv.length === 0) {
        return new Response(JSON.stringify({ error: 'Conversation not found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
    }

    // Persist user message
    this.persistMessage(conversationId, 'user', body.message);

    // Load conversation history (limited to context window)
    const contextWindow = Number(this.env.SAM_CONVERSATION_CONTEXT_WINDOW) || DEFAULT_SAM_CONVERSATION_CONTEXT_WINDOW;
    const historyRows = this.loadHistory(conversationId, contextWindow);

    // Create SSE stream
    const { readable, writable } = new TransformStream<Uint8Array>();
    const writer = writable.getWriter();

    // Send conversationId as first event
    await writer.write(encodeSseEvent({ type: 'conversation_started', conversationId }));

    // Run agent loop in background
    this.ctx.waitUntil(
      (async () => {
        try {
          log.info('sam_session.agent_loop_start', { conversationId, model: config.model });
          await runAgentLoop(
            conversationId!,
            historyRows,
            body.message,
            config,
            this.env,
            userId,
            writer,
            (convId, role, content, toolCallsJson, toolCallId) => {
              this.persistMessage(convId, role, content, toolCallsJson, toolCallId);
            },
          );
          log.info('sam_session.agent_loop_done', { conversationId });
        } catch (err) {
          log.error('sam_session.agent_loop_error', {
            conversationId,
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          });
          try {
            await writer.write(encodeSseEvent({
              type: 'error',
              message: 'An unexpected error occurred. Please try again.',
            }));
            await writer.write(encodeSseEvent({ type: 'done' }));
          } catch { /* writer may be closed */ }
        } finally {
          try { await writer.close(); } catch { /* already closed */ }
        }
      })()
    );

    return new Response(readable, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      },
    });
  }

  /** Handle GET /conversations — list all conversations. */
  private handleListConversations(): Response {
    const maxConversations = Number(this.env.SAM_MAX_CONVERSATIONS) || DEFAULT_SAM_MAX_CONVERSATIONS;
    const rows = this.sql.exec(
      'SELECT id, title, created_at, updated_at FROM conversations ORDER BY updated_at DESC LIMIT ?',
      maxConversations
    ).toArray() as unknown as ConversationRow[];

    return new Response(JSON.stringify({ conversations: rows }), {
      headers: { 'content-type': 'application/json' },
    });
  }

  /** Handle GET /conversations/:id/messages — get messages for a conversation. */
  private handleGetMessages(conversationId: string): Response {
    const maxMessages = Number(this.env.SAM_MAX_MESSAGES_PER_CONVERSATION) || DEFAULT_SAM_MAX_MESSAGES_PER_CONVERSATION;
    const rows = this.sql.exec(
      `SELECT id, conversation_id, role, content, tool_calls_json, tool_call_id, sequence, created_at
       FROM messages WHERE conversation_id = ? ORDER BY sequence ASC LIMIT ?`,
      conversationId,
      maxMessages
    ).toArray() as unknown as MessageRow[];

    return new Response(JSON.stringify({ messages: rows }), {
      headers: { 'content-type': 'application/json' },
    });
  }

  /** Create a new conversation. */
  private createConversation(id: string, title: string): void {
    // Enforce max conversations limit
    const maxConversations = Number(this.env.SAM_MAX_CONVERSATIONS) || DEFAULT_SAM_MAX_CONVERSATIONS;
    const countResult = this.sql.exec('SELECT COUNT(*) as cnt FROM conversations').toArray();
    const count = Number(countResult[0]?.cnt ?? 0);
    if (count >= maxConversations) {
      // Delete the oldest conversation
      this.sql.exec(
        'DELETE FROM conversations WHERE id = (SELECT id FROM conversations ORDER BY updated_at ASC LIMIT 1)'
      );
    }

    this.sql.exec(
      'INSERT INTO conversations (id, title) VALUES (?, ?)',
      id,
      title
    );
  }

  /** Persist a message to the conversation (atomic via transactionSync). */
  private persistMessage(
    conversationId: string,
    role: string,
    content: string,
    toolCallsJson?: string | null,
    toolCallId?: string | null,
  ): void {
    this.ctx.storage.transactionSync(() => {
      const id = crypto.randomUUID();

      // Get next sequence number
      const seqResult = this.sql.exec(
        'SELECT COALESCE(MAX(sequence), 0) as max_seq FROM messages WHERE conversation_id = ?',
        conversationId
      ).toArray();
      const nextSeq = Number(seqResult[0]?.max_seq ?? 0) + 1;

      this.sql.exec(
        `INSERT INTO messages (id, conversation_id, role, content, tool_calls_json, tool_call_id, sequence)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id,
        conversationId,
        role,
        content,
        toolCallsJson ?? null,
        toolCallId ?? null,
        nextSeq
      );

      // Update conversation timestamp
      this.sql.exec(
        "UPDATE conversations SET updated_at = datetime('now') WHERE id = ?",
        conversationId
      );
    });
  }

  /**
   * Check and enforce per-user rate limiting using DO SQLite.
   * Returns a 429 Response if rate limit exceeded, or null if OK.
   * Uses a single-row tumbling window: count resets when the window expires.
   */
  private checkRateLimit(maxRpm: number, windowSeconds: number): Response | null {
    const nowMs = Date.now();
    const windowMs = windowSeconds * 1000;

    const row = this.sql.exec(
      'SELECT window_start, request_count FROM rate_limits WHERE id = 1'
    ).toArray()[0] as { window_start: number; request_count: number } | undefined;

    if (!row) {
      // Seed row if missing (shouldn't happen after migration)
      this.sql.exec(
        'INSERT OR REPLACE INTO rate_limits (id, window_start, request_count) VALUES (1, ?, 1)',
        nowMs
      );
      return null;
    }

    const windowStart = Number(row.window_start);
    const count = Number(row.request_count);

    if (nowMs - windowStart > windowMs) {
      // Window expired — reset
      this.sql.exec(
        'UPDATE rate_limits SET window_start = ?, request_count = 1 WHERE id = 1',
        nowMs
      );
      return null;
    }

    if (count >= maxRpm) {
      const retryAfterSeconds = Math.ceil((windowStart + windowMs - nowMs) / 1000);
      log.warn('sam_session.rate_limited', { count, maxRpm, retryAfterSeconds });
      return new Response(
        JSON.stringify({
          error: 'Rate limit exceeded',
          retryAfter: retryAfterSeconds,
        }),
        {
          status: 429,
          headers: {
            'content-type': 'application/json',
            'retry-after': String(retryAfterSeconds),
          },
        }
      );
    }

    // Increment counter
    this.sql.exec(
      'UPDATE rate_limits SET request_count = request_count + 1 WHERE id = 1'
    );
    return null;
  }

  /** Load conversation history for the agent loop. */
  private loadHistory(conversationId: string, contextWindow: number): MessageRow[] {
    // Rows are ordered DESC (most recent first). rows[0] is the user message we just
    // persisted — skip it because runAgentLoop adds it separately. Then reverse the
    // rest into chronological order for the LLM context.
    const rows = this.sql.exec(
      `SELECT id, conversation_id, role, content, tool_calls_json, tool_call_id, sequence, created_at
       FROM messages WHERE conversation_id = ?
       ORDER BY sequence DESC LIMIT ?`,
      conversationId,
      contextWindow + 1 // +1 because we skip the most recent (just-added user message)
    ).toArray() as unknown as MessageRow[];

    const filtered = rows.length > 0 ? rows.slice(1) : [];
    return filtered.reverse();
  }
}
