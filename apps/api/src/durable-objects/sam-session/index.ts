/**
 * SamSession Durable Object — per-user SAM chat session manager.
 *
 * One instance per user (keyed by userId). Manages conversations and messages
 * in embedded SQLite, runs the agent loop, and streams SSE responses.
 */
import {
  DEFAULT_SAM_CONVERSATION_CONTEXT_WINDOW,
  DEFAULT_SAM_HISTORY_LOAD_LIMIT,
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

  if (!applied.has('003-fts-and-type')) {
    // Forward-compatible columns for Phase 3 (project agent threads)
    sql.exec(`ALTER TABLE conversations ADD COLUMN type TEXT NOT NULL DEFAULT 'human'`);
    sql.exec(`ALTER TABLE conversations ADD COLUMN linked_session_id TEXT`);
    sql.exec(`ALTER TABLE conversations ADD COLUMN linked_project_id TEXT`);

    // FTS5 virtual table for full-text search on message content
    sql.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
      USING fts5(content, content='messages', content_rowid='rowid', tokenize='unicode61')
    `);

    // Backfill existing messages into FTS5
    sql.exec(`
      INSERT INTO messages_fts(rowid, content)
      SELECT rowid, content FROM messages WHERE content != ''
    `);

    sql.exec(`INSERT INTO sam_migrations (name) VALUES ('003-fts-and-type')`);
  }
}

/** Build an FTS5 query from user input — wraps each word in double quotes. */
export function buildFtsQuery(query: string): string | null {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  return words.map((w) => `"${w.replace(/"/g, '""')}"`).join(' ');
}

/** Extract a context-windowed snippet around the first match. */
export function extractSnippet(content: string, query: string): string {
  const lowerContent = content.toLowerCase();
  const matchIdx = lowerContent.indexOf(query.toLowerCase());
  if (matchIdx === -1) {
    return content.slice(0, 200) + (content.length > 200 ? '...' : '');
  }
  const start = Math.max(0, matchIdx - 80);
  const end = Math.min(content.length, matchIdx + query.length + 120);
  return (start > 0 ? '...' : '') + content.slice(start, end) + (end < content.length ? '...' : '');
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

      // GET /conversations — list conversations
      if (method === 'GET' && path === '/conversations') {
        const typeFilter = url.searchParams.get('type');
        return this.handleListConversations(typeFilter);
      }

      // GET /search — full-text search messages
      if (method === 'GET' && path === '/search') {
        const query = url.searchParams.get('query') || '';
        const limit = parseInt(url.searchParams.get('limit') || '', 10) || undefined;
        return this.handleSearch(query, limit);
      }

      // GET /conversations/:id/messages — get messages for a conversation
      const messagesMatch = path.match(/^\/conversations\/([^/]+)\/messages$/);
      if (method === 'GET' && messagesMatch) {
        const limit = parseInt(url.searchParams.get('limit') || '', 10) || undefined;
        return this.handleGetMessages(messagesMatch[1]!, limit);
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
    const config = resolveSamConfig(this.env as unknown as Record<string, string | undefined>);

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

    // Run agent loop in background (conversation_started is written here,
    // AFTER the Response is returned, to avoid a TransformStream deadlock —
    // await writer.write() blocks if no consumer is reading the readable side yet).
    this.ctx.waitUntil(
      (async () => {
        try {
          await writer.write(encodeSseEvent({ type: 'conversation_started', conversationId }));
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
            (query, limit) => this.searchMessages(query, limit, config.ftsEnabled),
          );
        } catch (err) {
          log.error('sam_session.agent_loop_error', {
            conversationId,
            error: err instanceof Error ? err.message : String(err),
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

  /** Handle GET /conversations — list conversations, optionally filtered by type. */
  private handleListConversations(typeFilter: string | null): Response {
    const maxConversations = Number(this.env.SAM_MAX_CONVERSATIONS) || DEFAULT_SAM_MAX_CONVERSATIONS;
    let rows: ConversationRow[];
    if (typeFilter) {
      rows = this.sql.exec(
        'SELECT id, title, type, created_at, updated_at FROM conversations WHERE type = ? ORDER BY updated_at DESC LIMIT ?',
        typeFilter,
        maxConversations
      ).toArray() as unknown as ConversationRow[];
    } else {
      rows = this.sql.exec(
        'SELECT id, title, type, created_at, updated_at FROM conversations ORDER BY updated_at DESC LIMIT ?',
        maxConversations
      ).toArray() as unknown as ConversationRow[];
    }

    return new Response(JSON.stringify({ conversations: rows }), {
      headers: { 'content-type': 'application/json' },
    });
  }

  /** Handle GET /conversations/:id/messages — get messages for a conversation. */
  private handleGetMessages(conversationId: string, requestedLimit?: number): Response {
    const historyLimit = Number(this.env.SAM_HISTORY_LOAD_LIMIT) || DEFAULT_SAM_HISTORY_LOAD_LIMIT;
    const maxMessages = requestedLimit
      ? Math.min(requestedLimit, Number(this.env.SAM_MAX_MESSAGES_PER_CONVERSATION) || DEFAULT_SAM_MAX_MESSAGES_PER_CONVERSATION)
      : historyLimit;
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
      // Clean FTS5 entries before CASCADE deletes messages (FTS5 external-content
      // tables don't auto-sync on DELETE — we must remove entries manually)
      const oldestId = this.sql.exec(
        'SELECT id FROM conversations ORDER BY updated_at ASC LIMIT 1'
      ).toArray()[0]?.id;
      if (oldestId) {
        try {
          this.sql.exec(
            `DELETE FROM messages_fts WHERE rowid IN (
              SELECT rowid FROM messages WHERE conversation_id = ?
            )`,
            String(oldestId)
          );
        } catch {
          // FTS5 cleanup failure is non-fatal
        }
        this.sql.exec('DELETE FROM conversations WHERE id = ?', String(oldestId));
      }
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

      // Sync content to FTS5 index
      if (content) {
        try {
          const rowid = this.sql.exec(
            'SELECT rowid FROM messages WHERE id = ?', id
          ).toArray()[0]?.rowid;
          if (rowid != null) {
            this.sql.exec(
              'INSERT INTO messages_fts(rowid, content) VALUES (?, ?)',
              rowid as number,
              content
            );
          }
        } catch {
          // FTS5 sync failure is non-fatal — search may miss this message
        }
      }

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

  /** Handle GET /search — full-text search across messages. */
  private handleSearch(query: string, requestedLimit?: number): Response {
    if (!query.trim()) {
      return new Response(JSON.stringify({ error: 'Query is required' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }

    const config = resolveSamConfig(this.env as unknown as Record<string, string | undefined>);
    const limit = Math.min(
      requestedLimit || config.searchLimit,
      config.searchMaxLimit
    );

    const results = this.searchMessages(query, limit, config.ftsEnabled);
    return new Response(JSON.stringify({ results }), {
      headers: { 'content-type': 'application/json' },
    });
  }

  /**
   * Search messages using two-tier strategy: FTS5 MATCH first, LIKE fallback.
   * Public so the search_conversation_history tool can call it directly.
   */
  searchMessages(
    query: string,
    limit: number,
    ftsEnabled: boolean = true,
  ): Array<{ snippet: string; role: string; sequence: number; createdAt: string }> {
    const results: Array<{ snippet: string; role: string; sequence: number; createdAt: string }> = [];

    if (ftsEnabled) {
      const ftsQuery = buildFtsQuery(query);
      if (ftsQuery) {
        try {
          const rows = this.sql.exec(
            `SELECT m.role, m.content, m.sequence, m.created_at
             FROM messages_fts f
             JOIN messages m ON m.rowid = f.rowid
             WHERE f.messages_fts MATCH ?
             ORDER BY rank
             LIMIT ?`,
            ftsQuery,
            limit
          ).toArray();
          for (const row of rows) {
            results.push({
              snippet: extractSnippet(String(row.content), query),
              role: String(row.role),
              sequence: Number(row.sequence),
              createdAt: String(row.created_at),
            });
          }
        } catch (e) {
          log.error('sam_session.fts5_search_failed', { error: String(e) });
        }
      }
    }

    // LIKE fallback if FTS5 returned fewer results than requested
    if (results.length < limit) {
      const remaining = limit - results.length;
      const escapedQuery = query.replace(/[%_\\]/g, '\\$&');
      const rows = this.sql.exec(
        `SELECT role, content, sequence, created_at
         FROM messages
         WHERE content LIKE ? ESCAPE '\\'
         ORDER BY created_at DESC
         LIMIT ?`,
        `%${escapedQuery}%`,
        remaining
      ).toArray();

      // De-duplicate: skip rows already found by FTS5 (compare by sequence)
      const seenSequences = new Set(results.map((r) => r.sequence));
      for (const row of rows) {
        const seq = Number(row.sequence);
        if (seenSequences.has(seq)) continue;
        seenSequences.add(seq);
        results.push({
          snippet: extractSnippet(String(row.content), query),
          role: String(row.role),
          sequence: seq,
          createdAt: String(row.created_at),
        });
      }
    }

    return results;
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
