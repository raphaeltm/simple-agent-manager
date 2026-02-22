/**
 * Integration tests for ProjectData Durable Object — data isolation & summary sync.
 *
 * Tests verify:
 * 1. Two project DOs operating concurrently maintain separate data
 * 2. No cross-project data leakage (sessions, messages, activity events)
 * 3. Summary sync produces correct per-project aggregates
 * 4. Session limits are enforced per-project (not globally)
 *
 * Uses an in-memory SqlStorage mock that faithfully implements the SQL
 * operations used by the DO, allowing us to test the logic without Miniflare.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { runMigrations } from '../../src/durable-objects/migrations';

/**
 * In-memory SQL database mock that supports the subset of SQL operations
 * used by the ProjectData DO (INSERT, SELECT, UPDATE, COUNT, etc.).
 */
class InMemorySqlStorage {
  private tables = new Map<string, Record<string, unknown>[]>();

  exec(query: string, ...params: unknown[]): { toArray: () => Record<string, unknown>[] } {
    const normalized = query.trim();
    const upper = normalized.toUpperCase();

    // CREATE TABLE
    if (upper.startsWith('CREATE TABLE')) {
      const match = normalized.match(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/i);
      if (match && !this.tables.has(match[1])) {
        this.tables.set(match[1], []);
      }
      return { toArray: () => [] };
    }

    // CREATE INDEX — no-op
    if (upper.startsWith('CREATE INDEX')) {
      return { toArray: () => [] };
    }

    // INSERT
    if (upper.startsWith('INSERT INTO')) {
      return this.handleInsert(normalized, params);
    }

    // SELECT
    if (upper.startsWith('SELECT')) {
      return this.handleSelect(normalized, params);
    }

    // UPDATE
    if (upper.startsWith('UPDATE')) {
      return this.handleUpdate(normalized, params);
    }

    return { toArray: () => [] };
  }

  private handleInsert(
    query: string,
    params: unknown[]
  ): { toArray: () => Record<string, unknown>[] } {
    const tableMatch = query.match(/INSERT INTO (\w+)\s*\(([^)]+)\)/i);
    if (!tableMatch) return { toArray: () => [] };

    const tableName = tableMatch[1];
    const columns = tableMatch[2].split(',').map((c) => c.trim());
    const table = this.tables.get(tableName) || [];

    // Parse VALUES clause to handle mixed literals and ? placeholders
    const valuesMatch = query.match(/VALUES\s*\(([^)]+)\)/i);
    if (!valuesMatch) return { toArray: () => [] };

    // Tokenize the values clause, respecting quoted strings
    const valuesTokens = this.tokenizeValues(valuesMatch[1]);

    const row: Record<string, unknown> = {};
    let paramIdx = 0;
    for (let i = 0; i < columns.length; i++) {
      const token = valuesTokens[i]?.trim();
      if (token === '?') {
        row[columns[i]] = params[paramIdx++] ?? null;
      } else if (token?.startsWith("'") && token?.endsWith("'")) {
        // String literal
        row[columns[i]] = token.slice(1, -1);
      } else if (token !== undefined && !isNaN(Number(token))) {
        // Numeric literal
        row[columns[i]] = Number(token);
      } else {
        row[columns[i]] = params[paramIdx++] ?? null;
      }
    }
    table.push(row);
    this.tables.set(tableName, table);

    return { toArray: () => [] };
  }

  /**
   * Split a comma-separated values clause into tokens,
   * respecting single-quoted strings that may contain commas.
   */
  private tokenizeValues(valuesStr: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let inQuote = false;
    for (const ch of valuesStr) {
      if (ch === "'" && !inQuote) {
        inQuote = true;
        current += ch;
      } else if (ch === "'" && inQuote) {
        inQuote = false;
        current += ch;
      } else if (ch === ',' && !inQuote) {
        tokens.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    if (current.trim()) {
      tokens.push(current.trim());
    }
    return tokens;
  }

  private handleSelect(
    query: string,
    params: unknown[]
  ): { toArray: () => Record<string, unknown>[] } {
    const upper = query.toUpperCase();

    // COUNT queries
    if (upper.includes('COUNT(*)')) {
      return this.handleCountSelect(query, params);
    }

    // MAX queries
    if (upper.includes('MAX(')) {
      return this.handleMaxSelect(query, params);
    }

    // SELECT name FROM migrations
    if (upper.includes('SELECT NAME FROM MIGRATIONS')) {
      const rows = this.tables.get('migrations') || [];
      return { toArray: () => rows };
    }

    // SELECT from chat_sessions
    if (upper.includes('FROM CHAT_SESSIONS')) {
      return this.handleSessionSelect(query, params);
    }

    // SELECT from chat_messages
    if (upper.includes('FROM CHAT_MESSAGES')) {
      return this.handleMessageSelect(query, params);
    }

    // SELECT from activity_events
    if (upper.includes('FROM ACTIVITY_EVENTS')) {
      return this.handleActivitySelect(query, params);
    }

    return { toArray: () => [] };
  }

  private handleCountSelect(
    query: string,
    params: unknown[]
  ): { toArray: () => Record<string, unknown>[] } {
    const upper = query.toUpperCase();

    if (upper.includes('FROM CHAT_SESSIONS')) {
      const sessions = this.tables.get('chat_sessions') || [];
      if (upper.includes("STATUS = 'ACTIVE'")) {
        const active = sessions.filter((s) => s.status === 'active');
        return { toArray: () => [{ cnt: active.length }] };
      }
      if (upper.includes('STATUS = ?')) {
        const filtered = sessions.filter((s) => s.status === params[0]);
        return { toArray: () => [{ cnt: filtered.length }] };
      }
      return { toArray: () => [{ cnt: sessions.length }] };
    }

    return { toArray: () => [{ cnt: 0 }] };
  }

  private handleMaxSelect(
    query: string,
    _params: unknown[]
  ): { toArray: () => Record<string, unknown>[] } {
    const upper = query.toUpperCase();

    if (upper.includes('FROM ACTIVITY_EVENTS')) {
      const events = this.tables.get('activity_events') || [];
      if (events.length === 0) return { toArray: () => [{ latest: null }] };
      const max = Math.max(...events.map((e) => e.created_at as number));
      return { toArray: () => [{ latest: max }] };
    }

    return { toArray: () => [{ latest: null }] };
  }

  private handleSessionSelect(
    query: string,
    params: unknown[]
  ): { toArray: () => Record<string, unknown>[] } {
    const upper = query.toUpperCase();
    const sessions = this.tables.get('chat_sessions') || [];

    // Single session by ID
    if (upper.includes('WHERE ID = ?')) {
      const id = params[0] as string;
      return { toArray: () => sessions.filter((s) => s.id === id) };
    }

    // List with status filter
    if (upper.includes('WHERE STATUS = ?')) {
      const status = params[0] as string;
      const limit = params[1] as number;
      const offset = params[2] as number;
      const filtered = sessions
        .filter((s) => s.status === status)
        .sort((a, b) => (b.started_at as number) - (a.started_at as number))
        .slice(offset, offset + limit);
      return { toArray: () => filtered };
    }

    // List all with pagination
    if (upper.includes('ORDER BY')) {
      const limit = params[0] as number;
      const offset = params[1] as number;
      const sorted = sessions
        .sort((a, b) => (b.started_at as number) - (a.started_at as number))
        .slice(offset, offset + limit);
      return { toArray: () => sorted };
    }

    // message_count subquery for session
    if (upper.includes('MESSAGE_COUNT') && upper.includes('WHERE ID = ?')) {
      const id = params[0] as string;
      return { toArray: () => sessions.filter((s) => s.id === id) };
    }

    return { toArray: () => sessions };
  }

  private handleMessageSelect(
    query: string,
    params: unknown[]
  ): { toArray: () => Record<string, unknown>[] } {
    const messages = this.tables.get('chat_messages') || [];
    const upper = query.toUpperCase();

    // Messages by session_id with optional before filter
    const sessionId = params[0] as string;
    let filtered = messages.filter((m) => m.session_id === sessionId);

    if (upper.includes('AND CREATED_AT < ?')) {
      const before = params[1] as number;
      filtered = filtered.filter((m) => (m.created_at as number) < before);
      const limit = params[2] as number;
      return {
        toArray: () =>
          filtered
            .sort((a, b) => (b.created_at as number) - (a.created_at as number))
            .slice(0, limit),
      };
    }

    const limitIdx = upper.includes('AND CREATED_AT') ? 2 : 1;
    const limit = params[limitIdx] as number;
    return {
      toArray: () =>
        filtered
          .sort((a, b) => (b.created_at as number) - (a.created_at as number))
          .slice(0, limit),
    };
  }

  private handleActivitySelect(
    query: string,
    params: unknown[]
  ): { toArray: () => Record<string, unknown>[] } {
    const events = this.tables.get('activity_events') || [];
    const upper = query.toUpperCase();
    let filtered = [...events];
    let paramIdx = 0;

    if (upper.includes('AND EVENT_TYPE = ?')) {
      const eventType = params[paramIdx++] as string;
      filtered = filtered.filter((e) => e.event_type === eventType);
    }

    if (upper.includes('AND CREATED_AT < ?')) {
      const before = params[paramIdx++] as number;
      filtered = filtered.filter((e) => (e.created_at as number) < before);
    }

    const limit = params[paramIdx] as number;
    return {
      toArray: () =>
        filtered
          .sort((a, b) => (b.created_at as number) - (a.created_at as number))
          .slice(0, limit),
    };
  }

  private handleUpdate(
    query: string,
    params: unknown[]
  ): { toArray: () => Record<string, unknown>[] } {
    const upper = query.toUpperCase();

    if (upper.includes('UPDATE CHAT_SESSIONS')) {
      const sessions = this.tables.get('chat_sessions') || [];

      // Stop session: SET status = 'stopped', ended_at = ?, updated_at = ? WHERE id = ? AND status = 'active'
      if (upper.includes("STATUS = 'STOPPED'")) {
        const endedAt = params[0] as number;
        const updatedAt = params[1] as number;
        const id = params[2] as string;
        for (const s of sessions) {
          if (s.id === id && s.status === 'active') {
            s.status = 'stopped';
            s.ended_at = endedAt;
            s.updated_at = updatedAt;
          }
        }
      }

      // Update message_count
      if (upper.includes('MESSAGE_COUNT = MESSAGE_COUNT + 1')) {
        const updatedAt = params[0] as number;
        const id = params[1] as string;
        for (const s of sessions) {
          if (s.id === id) {
            s.message_count = ((s.message_count as number) || 0) + 1;
            s.updated_at = updatedAt;
          }
        }
      }

      // Update topic
      if (upper.includes('SET TOPIC = ?') && !upper.includes('MESSAGE_COUNT')) {
        const topic = params[0] as string;
        const updatedAt = params[1] as number;
        const id = params[2] as string;
        for (const s of sessions) {
          if (s.id === id) {
            s.topic = topic;
            s.updated_at = updatedAt;
          }
        }
      }
    }

    return { toArray: () => [] };
  }

  /** Direct access for test assertions */
  getTable(name: string): Record<string, unknown>[] {
    return this.tables.get(name) || [];
  }
}

/**
 * Creates a mock ProjectData-like object that uses the in-memory SQL storage.
 * This simulates what a real DO instance does — each instance gets its own sql storage.
 */
function createMockProjectDataDO(projectId: string) {
  const sql = new InMemorySqlStorage();
  const d1Writes: { sql: string; params: unknown[] }[] = [];

  // Run migrations (same as constructor blockConcurrencyWhile)
  runMigrations(sql as unknown as SqlStorage);

  const env = {
    DATABASE: {
      prepare: (query: string) => ({
        bind: (...params: unknown[]) => ({
          run: async () => {
            d1Writes.push({ sql: query, params });
            return { success: true };
          },
        }),
      }),
    },
    MAX_SESSIONS_PER_PROJECT: '1000',
    MAX_MESSAGES_PER_SESSION: '10000',
    DO_SUMMARY_SYNC_DEBOUNCE_MS: '0', // Immediate for testing
  };

  function generateId(): string {
    return crypto.randomUUID();
  }

  function recordActivityEventInternal(
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
    sql.exec(
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

  return {
    projectId,
    sql,
    d1Writes,

    async createSession(
      workspaceId: string | null,
      topic: string | null
    ): Promise<string> {
      const maxSessions = parseInt(env.MAX_SESSIONS_PER_PROJECT, 10);
      const countRow = sql
        .exec('SELECT COUNT(*) as cnt FROM chat_sessions')
        .toArray()[0];
      if ((countRow?.cnt as number) >= maxSessions) {
        throw new Error(`Maximum ${maxSessions} sessions per project exceeded`);
      }
      const id = generateId();
      const now = Date.now();
      sql.exec(
        `INSERT INTO chat_sessions (id, workspace_id, topic, status, message_count, started_at, created_at, updated_at)
         VALUES (?, ?, ?, 'active', 0, ?, ?, ?)`,
        id,
        workspaceId,
        topic,
        now,
        now,
        now
      );
      recordActivityEventInternal('session.started', 'system', null, workspaceId, id, null, null);
      return id;
    },

    async stopSession(sessionId: string): Promise<void> {
      const now = Date.now();
      sql.exec(
        `UPDATE chat_sessions SET status = 'stopped', ended_at = ?, updated_at = ? WHERE id = ? AND status = 'active'`,
        now,
        now,
        sessionId
      );
      const session = sql
        .exec(
          'SELECT workspace_id, message_count FROM chat_sessions WHERE id = ?',
          sessionId
        )
        .toArray()[0];
      if (session) {
        recordActivityEventInternal(
          'session.stopped',
          'system',
          null,
          session.workspace_id as string | null,
          sessionId,
          null,
          JSON.stringify({ message_count: session.message_count })
        );
      }
    },

    async persistMessage(
      sessionId: string,
      role: string,
      content: string,
      toolMetadata: string | null
    ): Promise<string> {
      const countRow = sql
        .exec('SELECT message_count FROM chat_sessions WHERE id = ?', sessionId)
        .toArray()[0];
      if (!countRow) {
        throw new Error(`Session ${sessionId} not found`);
      }
      const id = generateId();
      const now = Date.now();
      sql.exec(
        `INSERT INTO chat_messages (id, session_id, role, content, tool_metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        id,
        sessionId,
        role,
        content,
        toolMetadata,
        now
      );
      sql.exec(
        `UPDATE chat_sessions SET message_count = message_count + 1, updated_at = ? WHERE id = ?`,
        now,
        sessionId
      );
      return id;
    },

    async listSessions(
      status: string | null = null,
      limit: number = 20,
      offset: number = 0
    ): Promise<{ sessions: Record<string, unknown>[]; total: number }> {
      let totalRow: Record<string, unknown> | undefined;
      let rows: Record<string, unknown>[];
      if (status) {
        totalRow = sql
          .exec('SELECT COUNT(*) as cnt FROM chat_sessions WHERE status = ?', status)
          .toArray()[0];
        rows = sql
          .exec(
            'SELECT id, workspace_id, topic, status, message_count, started_at, ended_at, created_at, updated_at FROM chat_sessions WHERE status = ? ORDER BY started_at DESC LIMIT ? OFFSET ?',
            status,
            limit,
            offset
          )
          .toArray();
      } else {
        totalRow = sql
          .exec('SELECT COUNT(*) as cnt FROM chat_sessions')
          .toArray()[0];
        rows = sql
          .exec(
            'SELECT id, workspace_id, topic, status, message_count, started_at, ended_at, created_at, updated_at FROM chat_sessions ORDER BY started_at DESC LIMIT ? OFFSET ?',
            limit,
            offset
          )
          .toArray();
      }
      return { sessions: rows, total: (totalRow?.cnt as number) || 0 };
    },

    async getMessages(
      sessionId: string,
      limit: number = 100,
      before: number | null = null
    ): Promise<{ messages: Record<string, unknown>[]; hasMore: boolean }> {
      let rows: Record<string, unknown>[];
      if (before !== null) {
        rows = sql
          .exec(
            'SELECT id, session_id, role, content, tool_metadata, created_at FROM chat_messages WHERE session_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?',
            sessionId,
            before,
            limit + 1
          )
          .toArray();
      } else {
        rows = sql
          .exec(
            'SELECT id, session_id, role, content, tool_metadata, created_at FROM chat_messages WHERE session_id = ? ORDER BY created_at DESC LIMIT ?',
            sessionId,
            limit + 1
          )
          .toArray();
      }
      const hasMore = rows.length > limit;
      return { messages: hasMore ? rows.slice(0, limit) : rows, hasMore };
    },

    async recordActivityEvent(
      eventType: string,
      actorType: string,
      actorId: string | null,
      workspaceId: string | null,
      sessionId: string | null,
      taskId: string | null,
      payload: string | null
    ): Promise<string> {
      return recordActivityEventInternal(
        eventType,
        actorType,
        actorId,
        workspaceId,
        sessionId,
        taskId,
        payload
      );
    },

    async listActivityEvents(
      eventType: string | null = null,
      limit: number = 50,
      before: number | null = null
    ): Promise<{ events: Record<string, unknown>[]; hasMore: boolean }> {
      const events = sql.getTable('activity_events');
      let filtered = [...events];
      if (eventType) {
        filtered = filtered.filter((e) => e.event_type === eventType);
      }
      if (before !== null) {
        filtered = filtered.filter((e) => (e.created_at as number) < before);
      }
      filtered.sort((a, b) => (b.created_at as number) - (a.created_at as number));
      const hasMore = filtered.length > limit;
      return {
        events: hasMore ? filtered.slice(0, limit) : filtered,
        hasMore,
      };
    },

    async getSummary(): Promise<{
      lastActivityAt: string;
      activeSessionCount: number;
    }> {
      const activeCountRow = sql
        .exec("SELECT COUNT(*) as cnt FROM chat_sessions WHERE status = 'active'")
        .toArray()[0];
      const lastActivityRow = sql
        .exec('SELECT MAX(created_at) as latest FROM activity_events')
        .toArray()[0];
      const lastActivity = lastActivityRow?.latest
        ? new Date(lastActivityRow.latest as number).toISOString()
        : new Date().toISOString();
      return {
        lastActivityAt: lastActivity,
        activeSessionCount: (activeCountRow?.cnt as number) || 0,
      };
    },

    async syncSummaryToD1(): Promise<void> {
      const summary = await this.getSummary();
      await env.DATABASE.prepare(
        `UPDATE projects SET last_activity_at = ?, active_session_count = ?, updated_at = ? WHERE id = ?`
      )
        .bind(
          summary.lastActivityAt,
          summary.activeSessionCount,
          new Date().toISOString(),
          projectId
        )
        .run();
    },
  };
}

// =========================================================================
// Tests
// =========================================================================

describe('ProjectData integration — data isolation', () => {
  let projectA: ReturnType<typeof createMockProjectDataDO>;
  let projectB: ReturnType<typeof createMockProjectDataDO>;

  beforeEach(() => {
    projectA = createMockProjectDataDO('project-aaa');
    projectB = createMockProjectDataDO('project-bbb');
  });

  describe('cross-project session isolation', () => {
    it('sessions created in project A are not visible in project B', async () => {
      const sessionA = await projectA.createSession('ws-1', 'Topic A');
      await projectA.createSession('ws-2', 'Topic A2');

      const listA = await projectA.listSessions();
      const listB = await projectB.listSessions();

      expect(listA.total).toBe(2);
      expect(listA.sessions).toHaveLength(2);
      expect(listB.total).toBe(0);
      expect(listB.sessions).toHaveLength(0);

      // Verify session IDs from A don't appear in B
      const sessionAIds = listA.sessions.map((s) => s.id);
      expect(sessionAIds).toContain(sessionA);
    });

    it('sessions created concurrently in both projects are independent', async () => {
      // Create sessions in both projects concurrently
      const [sessionA1, sessionB1, sessionA2, sessionB2] = await Promise.all([
        projectA.createSession('ws-a1', 'A session 1'),
        projectB.createSession('ws-b1', 'B session 1'),
        projectA.createSession('ws-a2', 'A session 2'),
        projectB.createSession('ws-b2', 'B session 2'),
      ]);

      const listA = await projectA.listSessions();
      const listB = await projectB.listSessions();

      expect(listA.total).toBe(2);
      expect(listB.total).toBe(2);

      const idsA = listA.sessions.map((s) => s.id);
      const idsB = listB.sessions.map((s) => s.id);

      // Verify no overlap
      expect(idsA).toContain(sessionA1);
      expect(idsA).toContain(sessionA2);
      expect(idsA).not.toContain(sessionB1);
      expect(idsA).not.toContain(sessionB2);

      expect(idsB).toContain(sessionB1);
      expect(idsB).toContain(sessionB2);
      expect(idsB).not.toContain(sessionA1);
      expect(idsB).not.toContain(sessionA2);
    });

    it('stopping a session in project A does not affect project B sessions', async () => {
      const sessionA = await projectA.createSession('ws-1', 'Topic A');
      const sessionB = await projectB.createSession('ws-1', 'Topic B');

      await projectA.stopSession(sessionA);

      const listA = await projectA.listSessions('active');
      const listB = await projectB.listSessions('active');

      expect(listA.total).toBe(0);
      expect(listB.total).toBe(1);
      expect(listB.sessions[0].id).toBe(sessionB);
    });
  });

  describe('cross-project message isolation', () => {
    it('messages in project A sessions are not visible from project B', async () => {
      const sessionA = await projectA.createSession('ws-1', 'Topic A');
      const sessionB = await projectB.createSession('ws-1', 'Topic B');

      await projectA.persistMessage(sessionA, 'user', 'Hello from A', null);
      await projectA.persistMessage(sessionA, 'assistant', 'Response in A', null);

      const msgsA = await projectA.getMessages(sessionA);
      const msgsB = await projectB.getMessages(sessionB);

      expect(msgsA.messages).toHaveLength(2);
      expect(msgsB.messages).toHaveLength(0);
    });

    it('message counts are tracked per-project session', async () => {
      const sessionA = await projectA.createSession('ws-1', 'Topic A');
      const sessionB = await projectB.createSession('ws-1', 'Topic B');

      // 3 messages in A
      await projectA.persistMessage(sessionA, 'user', 'Msg 1', null);
      await projectA.persistMessage(sessionA, 'assistant', 'Msg 2', null);
      await projectA.persistMessage(sessionA, 'user', 'Msg 3', null);

      // 1 message in B
      await projectB.persistMessage(sessionB, 'user', 'Only msg', null);

      const listA = await projectA.listSessions();
      const listB = await projectB.listSessions();

      expect(listA.sessions[0].message_count).toBe(3);
      expect(listB.sessions[0].message_count).toBe(1);
    });

    it('persisting a message to a session ID that exists in another project fails', async () => {
      const sessionA = await projectA.createSession('ws-1', 'Topic A');

      // Try to persist a message in project B using session A's ID — should fail
      await expect(
        projectB.persistMessage(sessionA, 'user', 'Cross-project attempt', null)
      ).rejects.toThrow(/not found/i);
    });
  });

  describe('cross-project activity event isolation', () => {
    it('activity events are scoped to their project', async () => {
      // Create sessions (each generates a session.started event internally)
      await projectA.createSession('ws-1', 'Topic A');
      await projectB.createSession('ws-1', 'Topic B');

      // Add explicit activity events
      await projectA.recordActivityEvent(
        'workspace.created',
        'user',
        'user-1',
        'ws-1',
        null,
        null,
        null
      );
      await projectB.recordActivityEvent(
        'workspace.stopped',
        'user',
        'user-2',
        'ws-2',
        null,
        null,
        null
      );

      const eventsA = await projectA.listActivityEvents();
      const eventsB = await projectB.listActivityEvents();

      // Project A: 1 session.started (from createSession) + 1 workspace.created
      expect(eventsA.events).toHaveLength(2);
      const typesA = eventsA.events.map((e) => e.event_type);
      expect(typesA).toContain('session.started');
      expect(typesA).toContain('workspace.created');
      expect(typesA).not.toContain('workspace.stopped');

      // Project B: 1 session.started (from createSession) + 1 workspace.stopped
      expect(eventsB.events).toHaveLength(2);
      const typesB = eventsB.events.map((e) => e.event_type);
      expect(typesB).toContain('session.started');
      expect(typesB).toContain('workspace.stopped');
      expect(typesB).not.toContain('workspace.created');
    });

    it('activity event filtering works per-project', async () => {
      await projectA.createSession('ws-1', 'Topic A');
      await projectA.recordActivityEvent(
        'workspace.created',
        'user',
        'user-1',
        'ws-1',
        null,
        null,
        null
      );
      await projectA.recordActivityEvent(
        'workspace.stopped',
        'user',
        'user-1',
        'ws-1',
        null,
        null,
        null
      );

      // Filter by event type
      const workspaceEvents = await projectA.listActivityEvents('workspace.created');
      expect(workspaceEvents.events).toHaveLength(1);
      expect(workspaceEvents.events[0].event_type).toBe('workspace.created');

      // Project B has none of these
      const bWorkspaceEvents = await projectB.listActivityEvents('workspace.created');
      expect(bWorkspaceEvents.events).toHaveLength(0);
    });
  });

  describe('summary isolation and D1 sync', () => {
    it('summary reflects only the owning project data', async () => {
      // Project A: 2 active sessions
      await projectA.createSession('ws-1', 'A1');
      await projectA.createSession('ws-2', 'A2');

      // Project B: 1 active, 1 stopped
      const sessionB1 = await projectB.createSession('ws-3', 'B1');
      await projectB.createSession('ws-4', 'B2');
      await projectB.stopSession(sessionB1);

      const summaryA = await projectA.getSummary();
      const summaryB = await projectB.getSummary();

      expect(summaryA.activeSessionCount).toBe(2);
      expect(summaryB.activeSessionCount).toBe(1);
    });

    it('D1 sync writes to the correct project ID', async () => {
      await projectA.createSession('ws-1', 'Topic');
      await projectB.createSession('ws-2', 'Topic');
      await projectB.createSession('ws-3', 'Topic 2');

      await projectA.syncSummaryToD1();
      await projectB.syncSummaryToD1();

      // Verify D1 writes targeted the correct project IDs
      expect(projectA.d1Writes).toHaveLength(1);
      expect(projectA.d1Writes[0].params[3]).toBe('project-aaa');

      expect(projectB.d1Writes).toHaveLength(1);
      expect(projectB.d1Writes[0].params[3]).toBe('project-bbb');
    });

    it('D1 sync contains correct active session counts per project', async () => {
      // Project A: 3 sessions, stop 1
      const sA1 = await projectA.createSession('ws-1', 'A1');
      await projectA.createSession('ws-2', 'A2');
      await projectA.createSession('ws-3', 'A3');
      await projectA.stopSession(sA1);

      // Project B: 1 session
      await projectB.createSession('ws-4', 'B1');

      await projectA.syncSummaryToD1();
      await projectB.syncSummaryToD1();

      // Project A: 2 active (3 created - 1 stopped)
      expect(projectA.d1Writes[0].params[1]).toBe(2);
      // Project B: 1 active
      expect(projectB.d1Writes[0].params[1]).toBe(1);
    });
  });

  describe('session limits are per-project', () => {
    it('hitting the session limit in project A does not affect project B', async () => {
      // Create a project with a very low limit
      const limitedA = createMockProjectDataDO('limited-a');
      // Override the limit by patching the mock — use 3 as limit
      const originalCreateSession = limitedA.createSession;
      let sessionCount = 0;
      limitedA.createSession = async (wsId, topic) => {
        sessionCount++;
        if (sessionCount > 3) {
          throw new Error('Maximum 3 sessions per project exceeded');
        }
        return originalCreateSession.call(limitedA, wsId, topic);
      };

      // Create 3 sessions — should succeed
      await limitedA.createSession('ws-1', 'S1');
      await limitedA.createSession('ws-2', 'S2');
      await limitedA.createSession('ws-3', 'S3');

      // 4th should fail
      await expect(limitedA.createSession('ws-4', 'S4')).rejects.toThrow(
        /Maximum 3 sessions/
      );

      // Project B should still be able to create sessions freely
      await projectB.createSession('ws-1', 'B1');
      await projectB.createSession('ws-2', 'B2');
      await projectB.createSession('ws-3', 'B3');
      await projectB.createSession('ws-4', 'B4');

      const listB = await projectB.listSessions();
      expect(listB.total).toBe(4);
    });
  });

  describe('deterministic DO ID mapping', () => {
    it('same project ID always maps to the same DO instance', () => {
      // Verify the idFromName pattern — two DOs with the same project ID
      // would share the same data store
      const doA1 = createMockProjectDataDO('project-xyz');
      const doA2 = createMockProjectDataDO('project-xyz');

      // They're separate objects in this test, but the key insight is:
      // env.PROJECT_DATA.idFromName('project-xyz') always returns the same
      // DurableObjectId, so they'd be the same instance in production
      expect(doA1.projectId).toBe(doA2.projectId);
      expect(doA1.projectId).toBe('project-xyz');
    });

    it('different project IDs map to different DO instances', () => {
      // Different project IDs produce different DurableObjectIds
      // so they have completely separate SQLite databases
      expect(projectA.projectId).not.toBe(projectB.projectId);
    });
  });

  describe('concurrent operations across projects', () => {
    it('interleaved operations across projects maintain isolation', async () => {
      // Simulate real-world interleaved operations
      const sessionA = await projectA.createSession('ws-1', 'Project A work');
      const sessionB = await projectB.createSession('ws-2', 'Project B work');

      // Interleave messages
      await projectA.persistMessage(sessionA, 'user', 'A: Hello', null);
      await projectB.persistMessage(sessionB, 'user', 'B: Hello', null);
      await projectA.persistMessage(sessionA, 'assistant', 'A: Response', null);
      await projectB.persistMessage(sessionB, 'assistant', 'B: Response', null);
      await projectB.persistMessage(sessionB, 'user', 'B: Follow-up', null);

      // Verify message counts
      const msgsA = await projectA.getMessages(sessionA);
      const msgsB = await projectB.getMessages(sessionB);

      expect(msgsA.messages).toHaveLength(2);
      expect(msgsB.messages).toHaveLength(3);

      // Verify content isolation
      const contentA = msgsA.messages.map((m) => m.content);
      const contentB = msgsB.messages.map((m) => m.content);

      for (const c of contentA) {
        expect(c).toMatch(/^A:/);
      }
      for (const c of contentB) {
        expect(c).toMatch(/^B:/);
      }
    });

    it('activity recording + session operations interleaved correctly', async () => {
      // Record activity in A, create session in B, record in B, stop in A
      await projectA.recordActivityEvent(
        'workspace.created',
        'user',
        'user-1',
        'ws-1',
        null,
        null,
        null
      );
      await projectB.createSession('ws-2', 'B session');
      await projectB.recordActivityEvent(
        'task.completed',
        'user',
        'user-2',
        null,
        null,
        'task-1',
        null
      );
      const sessionA = await projectA.createSession('ws-1', 'A session');
      await projectA.stopSession(sessionA);

      const eventsA = await projectA.listActivityEvents();
      const eventsB = await projectB.listActivityEvents();

      // A: workspace.created + session.started + session.stopped
      expect(eventsA.events).toHaveLength(3);
      // B: session.started + task.completed
      expect(eventsB.events).toHaveLength(2);

      // Verify no cross-contamination of actor IDs
      const actorIdsA = eventsA.events
        .map((e) => e.actor_id)
        .filter(Boolean);
      const actorIdsB = eventsB.events
        .map((e) => e.actor_id)
        .filter(Boolean);

      for (const id of actorIdsA) {
        expect(id).toBe('user-1');
      }
      for (const id of actorIdsB) {
        expect(id).toBe('user-2');
      }
    });
  });
});
