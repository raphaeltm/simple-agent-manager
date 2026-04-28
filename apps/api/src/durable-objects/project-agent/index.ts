/**
 * ProjectAgent Durable Object — per-project AI technical lead.
 *
 * One instance per project (keyed by projectId). Manages conversations and
 * messages in embedded SQLite, runs the agent loop with project-scoped tools,
 * and streams SSE responses.
 *
 * Unlike SamSession (per-user, cross-project), the ProjectAgent is focused
 * entirely on a single project: its tasks, knowledge, codebase, and policies.
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
import { buildFtsQuery, extractSnippet } from '../sam-session';
import { runAgentLoop } from '../sam-session/agent-loop';
import type { ConversationRow, MessageRow, SamSseEvent } from '../sam-session/types';
import { PROJECT_AGENT_SYSTEM_PROMPT } from './system-prompt';
import { executeProjectTool,PROJECT_AGENT_TOOLS } from './tools';

const log = createModuleLogger('project_agent');

/** SQLite migration for the ProjectAgent DO. */
function migrate(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS pa_migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);

  const applied = new Set(
    sql.exec('SELECT name FROM pa_migrations').toArray().map((r) => String(r.name))
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
    sql.exec(`CREATE INDEX idx_pa_conversations_updated ON conversations(updated_at DESC)`);

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
    sql.exec(`CREATE INDEX idx_pa_messages_conv_seq ON messages(conversation_id, sequence ASC)`);

    sql.exec(`
      CREATE TABLE rate_limits (
        id INTEGER PRIMARY KEY,
        window_start INTEGER NOT NULL,
        request_count INTEGER NOT NULL DEFAULT 0
      )
    `);
    sql.exec(`INSERT INTO rate_limits (id, window_start, request_count) VALUES (1, 0, 0)`);

    // FTS5 virtual table for full-text search on message content
    sql.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
      USING fts5(content, content='messages', content_rowid='rowid', tokenize='unicode61')
    `);

    sql.exec(`INSERT INTO pa_migrations (name) VALUES ('001-initial')`);
  }
}

/** Encode an SSE event as unnamed data frame. */
function encodeSseEvent(event: SamSseEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

export class ProjectAgent extends DurableObject<AppEnv> {
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
      if (method === 'POST' && path === '/chat') {
        return await this.handleChat(request);
      }

      if (method === 'GET' && path === '/conversations') {
        return this.handleListConversations();
      }

      if (method === 'GET' && path === '/search') {
        const query = url.searchParams.get('query') || '';
        const limit = parseInt(url.searchParams.get('limit') || '', 10) || undefined;
        return this.handleSearch(query, limit);
      }

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
      log.error('project_agent.request_error', {
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
      projectId: string;
    };

    if (!body.message?.trim()) {
      return new Response(JSON.stringify({ error: 'Message is required' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (!body.projectId) {
      return new Response(JSON.stringify({ error: 'projectId is required' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (!body.userId) {
      return new Response(JSON.stringify({ error: 'userId is required' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }

    const { userId, projectId } = body;
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

    // Load conversation history
    const contextWindow = Number(this.env.SAM_CONVERSATION_CONTEXT_WINDOW) || DEFAULT_SAM_CONVERSATION_CONTEXT_WINDOW;
    const historyRows = this.loadHistory(conversationId, contextWindow);

    // Create SSE stream
    const { readable, writable } = new TransformStream<Uint8Array>();
    const writer = writable.getWriter();

    // Run agent loop in background
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
            {
              systemPrompt: PROJECT_AGENT_SYSTEM_PROMPT,
              tools: PROJECT_AGENT_TOOLS,
              executeTool: executeProjectTool,
              toolContextExtras: { projectId },
            },
          );
        } catch (err) {
          log.error('project_agent.agent_loop_error', {
            conversationId,
            projectId,
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

  /** Handle GET /conversations — list conversations. */
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
    const maxConversations = Number(this.env.SAM_MAX_CONVERSATIONS) || DEFAULT_SAM_MAX_CONVERSATIONS;
    const countResult = this.sql.exec('SELECT COUNT(*) as cnt FROM conversations').toArray();
    const count = Number(countResult[0]?.cnt ?? 0);
    if (count >= maxConversations) {
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

  /** Persist a message to the conversation. */
  private persistMessage(
    conversationId: string,
    role: string,
    content: string,
    toolCallsJson?: string | null,
    toolCallId?: string | null,
  ): void {
    this.ctx.storage.transactionSync(() => {
      const id = crypto.randomUUID();

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
          // FTS5 sync failure is non-fatal
        }
      }

      this.sql.exec(
        "UPDATE conversations SET updated_at = datetime('now') WHERE id = ?",
        conversationId
      );
    });
  }

  /** Check and enforce rate limiting. */
  private checkRateLimit(maxRpm: number, windowSeconds: number): Response | null {
    const nowMs = Date.now();
    const windowMs = windowSeconds * 1000;

    const row = this.sql.exec(
      'SELECT window_start, request_count FROM rate_limits WHERE id = 1'
    ).toArray()[0] as { window_start: number; request_count: number } | undefined;

    if (!row) {
      this.sql.exec(
        'INSERT OR REPLACE INTO rate_limits (id, window_start, request_count) VALUES (1, ?, 1)',
        nowMs
      );
      return null;
    }

    const windowStart = Number(row.window_start);
    const count = Number(row.request_count);

    if (nowMs - windowStart > windowMs) {
      this.sql.exec(
        'UPDATE rate_limits SET window_start = ?, request_count = 1 WHERE id = 1',
        nowMs
      );
      return null;
    }

    if (count >= maxRpm) {
      const retryAfterSeconds = Math.ceil((windowStart + windowMs - nowMs) / 1000);
      log.warn('project_agent.rate_limited', { count, maxRpm, retryAfterSeconds });
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

  /** Search messages using two-tier strategy: FTS5 MATCH first, LIKE fallback. */
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
          log.error('project_agent.fts5_search_failed', { error: String(e) });
        }
      }
    }

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
    const rows = this.sql.exec(
      `SELECT id, conversation_id, role, content, tool_calls_json, tool_call_id, sequence, created_at
       FROM messages WHERE conversation_id = ?
       ORDER BY sequence DESC LIMIT ?`,
      conversationId,
      contextWindow + 1
    ).toArray() as unknown as MessageRow[];

    // Strip the extra row only if we fetched more than contextWindow items
    // (the extra row is to avoid double-counting the just-persisted user message)
    const filtered = rows.length > contextWindow ? rows.slice(1) : rows;
    return filtered.reverse();
  }
}
