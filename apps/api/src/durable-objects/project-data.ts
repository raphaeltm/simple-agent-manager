/**
 * ProjectData Durable Object — per-project isolated data store.
 *
 * Manages chat sessions, chat messages, task status events, and activity events
 * with embedded SQLite. Supports Hibernatable WebSockets for real-time streaming.
 *
 * See: specs/018-project-first-architecture/research.md
 * See: specs/018-project-first-architecture/data-model.md
 */
import { DurableObject } from 'cloudflare:workers';
import { runMigrations } from './migrations';

type Env = {
  DATABASE: D1Database;
  DO_SUMMARY_SYNC_DEBOUNCE_MS?: string;
  MAX_SESSIONS_PER_PROJECT?: string;
  MAX_MESSAGES_PER_SESSION?: string;
  ACTIVITY_RETENTION_DAYS?: string;
  SESSION_IDLE_TIMEOUT_MINUTES?: string;
};

interface SummaryData {
  lastActivityAt: string;
  activeSessionCount: number;
}

function generateId(): string {
  return crypto.randomUUID();
}

export class ProjectData extends DurableObject<Env> {
  private sql: SqlStorage;
  private summarySyncTimer: ReturnType<typeof setTimeout> | null = null;
  private cachedProjectId: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.transactionSync(() => {
        runMigrations(this.sql);
      });
    });
  }

  /**
   * Lazily resolve the project ID from DO meta storage.
   * `idFromName(projectId)` is one-way — the DO cannot recover the original
   * name from `this.ctx.id`. So we persist the projectId on first RPC call
   * via `ensureProjectId` and read it back here.
   */
  private getProjectId(): string | null {
    if (this.cachedProjectId) return this.cachedProjectId;
    const row = this.sql.exec('SELECT value FROM do_meta WHERE key = ?', 'projectId').toArray()[0];
    if (row) {
      this.cachedProjectId = row.value as string;
    }
    return this.cachedProjectId;
  }

  /**
   * Store the project ID in DO meta if not already set.
   * Called from the service layer on every RPC call.
   */
  ensureProjectId(projectId: string): void {
    if (this.cachedProjectId === projectId) return;
    const existing = this.getProjectId();
    if (existing) {
      this.cachedProjectId = existing;
      return;
    }
    this.sql.exec(
      'INSERT OR IGNORE INTO do_meta (key, value) VALUES (?, ?)',
      'projectId',
      projectId
    );
    this.cachedProjectId = projectId;
  }

  // =========================================================================
  // Chat Session CRUD
  // =========================================================================

  async createSession(
    workspaceId: string | null,
    topic: string | null,
    taskId: string | null = null
  ): Promise<string> {
    const maxSessions = parseInt(this.env.MAX_SESSIONS_PER_PROJECT || '1000', 10);
    const countRow = this.sql
      .exec('SELECT COUNT(*) as cnt FROM chat_sessions')
      .toArray()[0];
    if ((countRow?.cnt as number) >= maxSessions) {
      throw new Error(`Maximum ${maxSessions} sessions per project exceeded`);
    }

    const id = generateId();
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO chat_sessions (id, workspace_id, task_id, topic, status, message_count, started_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', 0, ?, ?, ?)`,
      id,
      workspaceId,
      taskId,
      topic,
      now,
      now,
      now
    );

    this.recordActivityEventInternal('session.started', 'system', null, workspaceId, id, taskId, null);
    this.scheduleSummarySync();

    // Broadcast session.created event to connected WebSocket clients
    this.broadcastEvent('session.created', {
      id,
      workspaceId,
      taskId,
      topic,
      status: 'active',
      messageCount: 0,
      createdAt: now,
    });

    return id;
  }

  async stopSession(sessionId: string): Promise<void> {
    const now = Date.now();
    this.sql.exec(
      `UPDATE chat_sessions SET status = 'stopped', ended_at = ?, updated_at = ? WHERE id = ? AND status = 'active'`,
      now,
      now,
      sessionId
    );

    const session = this.sql
      .exec('SELECT workspace_id, message_count FROM chat_sessions WHERE id = ?', sessionId)
      .toArray()[0];

    if (session) {
      this.recordActivityEventInternal(
        'session.stopped',
        'system',
        null,
        session.workspace_id as string | null,
        sessionId,
        null,
        JSON.stringify({
          message_count: session.message_count,
        })
      );
    }

    this.scheduleSummarySync();
    this.broadcastEvent('session.stopped', { sessionId });
  }

  async persistMessage(
    sessionId: string,
    role: string,
    content: string,
    toolMetadata: string | null
  ): Promise<string> {
    const maxMessages = parseInt(this.env.MAX_MESSAGES_PER_SESSION || '10000', 10);
    const countRow = this.sql
      .exec('SELECT message_count FROM chat_sessions WHERE id = ?', sessionId)
      .toArray()[0];

    if (!countRow) {
      throw new Error(`Session ${sessionId} not found`);
    }
    if ((countRow.message_count as number) >= maxMessages) {
      throw new Error(`Maximum ${maxMessages} messages per session exceeded`);
    }

    const id = generateId();
    const now = Date.now();

    this.sql.exec(
      `INSERT INTO chat_messages (id, session_id, role, content, tool_metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      sessionId,
      role,
      content,
      toolMetadata,
      now
    );

    this.sql.exec(
      `UPDATE chat_sessions SET message_count = message_count + 1, updated_at = ? WHERE id = ?`,
      now,
      sessionId
    );

    // Auto-capture topic from first user message
    if (role === 'user') {
      const session = this.sql
        .exec('SELECT topic FROM chat_sessions WHERE id = ?', sessionId)
        .toArray()[0];
      if (session && !session.topic) {
        const truncatedTopic = content.length > 100 ? content.substring(0, 97) + '...' : content;
        this.sql.exec(
          'UPDATE chat_sessions SET topic = ?, updated_at = ? WHERE id = ?',
          truncatedTopic,
          now,
          sessionId
        );
      }
    }

    this.scheduleSummarySync();
    this.broadcastEvent('message.new', { sessionId, messageId: id, role });
    return id;
  }

  /**
   * Batch persist messages with messageId-based deduplication.
   * Returns count of newly persisted and duplicate messages.
   */
  async persistMessageBatch(
    sessionId: string,
    messages: Array<{
      messageId: string;
      role: string;
      content: string;
      toolMetadata: string | null;
      timestamp: string;
    }>
  ): Promise<{ persisted: number; duplicates: number }> {
    const session = this.sql
      .exec('SELECT id, message_count, topic, status FROM chat_sessions WHERE id = ?', sessionId)
      .toArray()[0];

    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const maxMessages = parseInt(this.env.MAX_MESSAGES_PER_SESSION || '10000', 10);
    let persisted = 0;
    let duplicates = 0;
    const now = Date.now();
    const persistedMessages: Array<{
      id: string;
      role: string;
      content: string;
      toolMetadata: unknown;
      createdAt: number;
    }> = [];

    for (const msg of messages) {
      // Check for duplicate messageId
      const existing = this.sql
        .exec('SELECT id FROM chat_messages WHERE id = ?', msg.messageId)
        .toArray()[0];

      if (existing) {
        duplicates++;
        continue;
      }

      // Check message count limit
      const currentCount = (session.message_count as number) + persisted;
      if (currentCount >= maxMessages) {
        break;
      }

      const createdAt = new Date(msg.timestamp).getTime() || now;
      this.sql.exec(
        `INSERT INTO chat_messages (id, session_id, role, content, tool_metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        msg.messageId,
        sessionId,
        msg.role,
        msg.content,
        msg.toolMetadata,
        createdAt
      );
      persisted++;
      persistedMessages.push({
        id: msg.messageId,
        role: msg.role,
        content: msg.content,
        toolMetadata: msg.toolMetadata ? JSON.parse(msg.toolMetadata) : null,
        createdAt,
      });
    }

    if (persisted > 0) {
      // Update session message count and updated_at
      this.sql.exec(
        `UPDATE chat_sessions SET message_count = message_count + ?, updated_at = ? WHERE id = ?`,
        persisted,
        now,
        sessionId
      );

      // Auto-capture topic from first user message if not set
      if (!session.topic) {
        const firstUserMsg = messages.find((m) => m.role === 'user');
        if (firstUserMsg) {
          const truncatedTopic =
            firstUserMsg.content.length > 100
              ? firstUserMsg.content.substring(0, 97) + '...'
              : firstUserMsg.content;
          this.sql.exec(
            'UPDATE chat_sessions SET topic = ?, updated_at = ? WHERE id = ?',
            truncatedTopic,
            now,
            sessionId
          );
        }
      }

      this.scheduleSummarySync();

      // Single batched broadcast instead of per-message to reduce WebSocket traffic
      this.broadcastEvent('messages.batch', {
        sessionId,
        messages: persistedMessages,
        count: persisted,
      });
    }

    return { persisted, duplicates };
  }

  async listSessions(
    status: string | null,
    limit: number = 20,
    offset: number = 0,
    taskId: string | null = null
  ): Promise<{ sessions: Record<string, unknown>[]; total: number }> {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (status) {
      conditions.push('status = ?');
      params.push(status);
    }
    if (taskId) {
      conditions.push('task_id = ?');
      params.push(taskId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const totalRow = this.sql
      .exec(`SELECT COUNT(*) as cnt FROM chat_sessions ${whereClause}`, ...params)
      .toArray()[0];

    const rows = this.sql
      .exec(
        `SELECT id, workspace_id, task_id, topic, status, message_count, started_at, ended_at, created_at, updated_at FROM chat_sessions ${whereClause} ORDER BY started_at DESC LIMIT ? OFFSET ?`,
        ...params,
        limit,
        offset
      )
      .toArray();

    return {
      sessions: rows.map((row) => this.mapSessionRow(row)),
      total: (totalRow?.cnt as number) || 0,
    };
  }

  async getSession(sessionId: string): Promise<Record<string, unknown> | null> {
    const rows = this.sql
      .exec(
        'SELECT id, workspace_id, task_id, topic, status, message_count, started_at, ended_at, created_at, updated_at FROM chat_sessions WHERE id = ?',
        sessionId
      )
      .toArray();

    const row = rows[0];
    if (!row) return null;
    return this.mapSessionRow(row);
  }

  async getMessages(
    sessionId: string,
    limit: number = 100,
    before: number | null = null
  ): Promise<{ messages: Record<string, unknown>[]; hasMore: boolean }> {
    let query =
      'SELECT id, session_id, role, content, tool_metadata, created_at FROM chat_messages WHERE session_id = ?';
    const params: (string | number)[] = [sessionId];

    if (before !== null) {
      query += ' AND created_at < ?';
      params.push(before);
    }

    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit + 1);

    const rows = this.sql.exec(query, ...params).toArray();
    const hasMore = rows.length > limit;
    const messageRows = hasMore ? rows.slice(0, limit) : rows;

    return {
      messages: messageRows.reverse().map((row) => ({
        id: row.id as string,
        sessionId: row.session_id as string,
        role: row.role as string,
        content: row.content as string,
        toolMetadata: row.tool_metadata ? JSON.parse(row.tool_metadata as string) : null,
        createdAt: row.created_at as number,
      })),
      hasMore,
    };
  }

  // =========================================================================
  // Activity Events
  // =========================================================================

  async recordActivityEvent(
    eventType: string,
    actorType: string,
    actorId: string | null,
    workspaceId: string | null,
    sessionId: string | null,
    taskId: string | null,
    payload: string | null
  ): Promise<string> {
    const id = this.recordActivityEventInternal(
      eventType,
      actorType,
      actorId,
      workspaceId,
      sessionId,
      taskId,
      payload
    );
    this.scheduleSummarySync();
    this.broadcastEvent('activity.new', { eventType, id });
    return id;
  }

  async listActivityEvents(
    eventType: string | null,
    limit: number = 50,
    before: number | null = null
  ): Promise<{ events: Record<string, unknown>[]; hasMore: boolean }> {
    let query =
      'SELECT id, event_type, actor_type, actor_id, workspace_id, session_id, task_id, payload, created_at FROM activity_events WHERE 1=1';
    const params: (string | number)[] = [];

    if (eventType) {
      query += ' AND event_type = ?';
      params.push(eventType);
    }
    if (before !== null) {
      query += ' AND created_at < ?';
      params.push(before);
    }

    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit + 1);

    const rows = this.sql.exec(query, ...params).toArray();
    const hasMore = rows.length > limit;
    const events = hasMore ? rows.slice(0, limit) : rows;

    return {
      events: events.map((row) => ({
        id: row.id,
        eventType: row.event_type,
        actorType: row.actor_type,
        actorId: row.actor_id,
        workspaceId: row.workspace_id,
        sessionId: row.session_id,
        taskId: row.task_id,
        payload: row.payload ? JSON.parse(row.payload as string) : null,
        createdAt: row.created_at,
      })),
      hasMore,
    };
  }

  // =========================================================================
  // Summary (for D1 sync and dashboard display)
  // =========================================================================

  async getSummary(): Promise<SummaryData> {
    const activeCountRow = this.sql
      .exec("SELECT COUNT(*) as cnt FROM chat_sessions WHERE status = 'active'")
      .toArray()[0];

    const lastActivityRow = this.sql
      .exec(
        'SELECT MAX(created_at) as latest FROM activity_events'
      )
      .toArray()[0];

    const lastActivity = lastActivityRow?.latest
      ? new Date(lastActivityRow.latest as number).toISOString()
      : new Date().toISOString();

    return {
      lastActivityAt: lastActivity,
      activeSessionCount: (activeCountRow?.cnt as number) || 0,
    };
  }

  // =========================================================================
  // Hibernatable WebSocket Support
  // =========================================================================

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      const upgradeHeader = request.headers.get('Upgrade');
      if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }

      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    return new Response('Not found', { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // Handle ping/pong for Hibernatable WebSocket keep-alive
    if (typeof message === 'string') {
      try {
        const parsed = JSON.parse(message);
        if (parsed.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch {
        // Ignore non-JSON messages
      }
    }
  }

  async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean
  ): Promise<void> {
    // WebSocket cleanup handled automatically by the runtime
    ws.close();
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    ws.close();
  }

  // =========================================================================
  // Internal Helpers
  // =========================================================================

  private recordActivityEventInternal(
    eventType: string,
    actorType: string,
    actorId: string | null,
    workspaceId: string | null,
    sessionId: string | null,
    taskId: string | null,
    payload: string | null
  ): string {
    const id = generateId();
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO activity_events (id, event_type, actor_type, actor_id, workspace_id, session_id, task_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      eventType,
      actorType,
      actorId,
      workspaceId,
      sessionId,
      taskId,
      payload,
      now
    );
    return id;
  }

  private mapSessionRow(row: Record<string, unknown>): Record<string, unknown> {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      taskId: row.task_id ?? null,
      topic: row.topic,
      status: row.status,
      messageCount: row.message_count,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      createdAt: row.created_at,
    };
  }

  private broadcastEvent(type: string, payload: Record<string, unknown>): void {
    const sockets = this.ctx.getWebSockets();
    const message = JSON.stringify({ type, payload });
    for (const ws of sockets) {
      try {
        ws.send(message);
      } catch {
        // Socket may be closed; ignore
      }
    }
  }

  private scheduleSummarySync(): void {
    const debounceMs = parseInt(this.env.DO_SUMMARY_SYNC_DEBOUNCE_MS || '5000', 10);

    if (this.summarySyncTimer !== null) {
      clearTimeout(this.summarySyncTimer);
    }

    this.summarySyncTimer = setTimeout(async () => {
      this.summarySyncTimer = null;
      try {
        await this.syncSummaryToD1();
      } catch (err) {
        console.error('Summary sync to D1 failed:', err);
      }
    }, debounceMs);
  }

  private async syncSummaryToD1(): Promise<void> {
    const projectId = this.getProjectId();
    if (!projectId) {
      console.warn('syncSummaryToD1: projectId not yet stored in DO meta, skipping');
      return;
    }

    const summary = await this.getSummary();

    try {
      await this.env.DATABASE.prepare(
        `UPDATE projects SET last_activity_at = ?, active_session_count = ?, updated_at = ? WHERE id = ?`
      ).bind(summary.lastActivityAt, summary.activeSessionCount, new Date().toISOString(), projectId).run();
    } catch (err) {
      // D1 sync is best-effort; log but don't throw
      console.error('D1 summary sync failed for project', projectId, err);
    }
  }
}
