/**
 * TDF-6: Chat Session Lifecycle — Integration tests.
 *
 * Tests the complete session lifecycle using the in-memory SQL storage mock:
 * 1. Single session per task (no duplicates)
 * 2. Session created with null workspaceId, linked later
 * 3. Messages persist to the correct session
 * 4. Workspace-session linking updates the session
 * 5. Message deduplication works across batches
 * 6. Idle cleanup works with linked sessions
 *
 * Uses the same InMemorySqlStorage approach as project-data.test.ts.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { runMigrations } from '../../src/durable-objects/migrations';

/**
 * Minimal in-memory SQL storage mock for ProjectData DO operations.
 */
class InMemorySqlStorage {
  private tables = new Map<string, Record<string, unknown>[]>();

  exec(query: string, ...params: unknown[]): { toArray: () => Record<string, unknown>[] } {
    const normalized = query.trim();
    const upper = normalized.toUpperCase();

    if (upper.startsWith('CREATE TABLE')) {
      const match = normalized.match(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/i);
      if (match && !this.tables.has(match[1])) {
        this.tables.set(match[1], []);
      }
      return { toArray: () => [] };
    }

    if (upper.startsWith('CREATE INDEX') || upper.startsWith('ALTER TABLE')) {
      // ALTER TABLE ADD COLUMN — add null column to existing rows
      if (upper.startsWith('ALTER TABLE')) {
        const alterMatch = normalized.match(
          /ALTER TABLE (\w+) ADD COLUMN (\w+)/i
        );
        if (alterMatch) {
          const tableName = alterMatch[1];
          const colName = alterMatch[2];
          const rows = this.tables.get(tableName) || [];
          for (const row of rows) {
            if (!(colName in row)) {
              row[colName] = null;
            }
          }
        }
      }
      return { toArray: () => [] };
    }

    if (upper.startsWith('INSERT')) {
      return this.handleInsert(normalized, params);
    }

    if (upper.startsWith('SELECT')) {
      return this.handleSelect(normalized, params);
    }

    if (upper.startsWith('UPDATE')) {
      return this.handleUpdate(normalized, params);
    }

    if (upper.startsWith('DELETE')) {
      return this.handleDelete(normalized, params);
    }

    return { toArray: () => [] };
  }

  private handleInsert(
    query: string,
    params: unknown[]
  ): { toArray: () => Record<string, unknown>[] } {
    const isInsertOrIgnore = query.toUpperCase().includes('INSERT OR IGNORE');
    const isInsertOrReplace = query.toUpperCase().includes('INSERT OR REPLACE');
    const tableMatch = query.match(/INSERT (?:OR (?:IGNORE|REPLACE) )?INTO (\w+)\s*\(([^)]+)\)/i);
    if (!tableMatch) return { toArray: () => [] };

    const tableName = tableMatch[1];
    const columns = tableMatch[2].split(',').map((c) => c.trim());
    const table = this.tables.get(tableName) || [];

    const row: Record<string, unknown> = {};
    let paramIdx = 0;

    const valuesMatch = query.match(/VALUES\s*\(([^)]+)\)/i);
    if (!valuesMatch) return { toArray: () => [] };

    const tokens = this.tokenizeValues(valuesMatch[1]);
    for (let i = 0; i < columns.length; i++) {
      const token = tokens[i]?.trim();
      if (token === '?') {
        row[columns[i]] = params[paramIdx++] ?? null;
      } else if (token?.startsWith("'") && token?.endsWith("'")) {
        row[columns[i]] = token.slice(1, -1);
      } else if (token !== undefined && !isNaN(Number(token))) {
        row[columns[i]] = Number(token);
      } else if (token === 'NULL' || token === 'null') {
        row[columns[i]] = null;
      } else {
        row[columns[i]] = params[paramIdx++] ?? null;
      }
    }

    // Handle INSERT OR IGNORE — skip if primary key exists
    if (isInsertOrIgnore) {
      const pkCol = columns[0]; // Assume first column is PK
      const existing = table.find((r) => r[pkCol] === row[pkCol]);
      if (existing) {
        return { toArray: () => [] };
      }
    }

    // Handle INSERT OR REPLACE — remove existing if PK matches
    if (isInsertOrReplace) {
      const pkCol = columns[0];
      const idx = table.findIndex((r) => r[pkCol] === row[pkCol]);
      if (idx >= 0) {
        table.splice(idx, 1);
      }
    }

    table.push(row);
    this.tables.set(tableName, table);

    return { toArray: () => [] };
  }

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

    if (upper.includes('COUNT(*)')) {
      return this.handleCountSelect(query, params);
    }

    if (upper.includes('MIN(')) {
      return this.handleMinSelect(query, params);
    }

    if (upper.includes('MAX(')) {
      return this.handleMaxSelect(query, params);
    }

    if (upper.includes('SELECT NAME FROM MIGRATIONS')) {
      const rows = this.tables.get('migrations') || [];
      return { toArray: () => rows };
    }

    if (upper.includes('FROM DO_META')) {
      const meta = this.tables.get('do_meta') || [];
      if (upper.includes('WHERE KEY = ?')) {
        const key = params[0] as string;
        return { toArray: () => meta.filter((r) => r.key === key) };
      }
      return { toArray: () => meta };
    }

    if (upper.includes('FROM CHAT_SESSIONS')) {
      return this.handleSessionSelect(query, params);
    }

    if (upper.includes('FROM CHAT_MESSAGES')) {
      return this.handleMessageSelect(query, params);
    }

    if (upper.includes('FROM IDLE_CLEANUP_SCHEDULE')) {
      return this.handleIdleCleanupSelect(query, params);
    }

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
        return { toArray: () => [{ cnt: sessions.filter((s) => s.status === 'active').length }] };
      }
      return { toArray: () => [{ cnt: sessions.length }] };
    }

    return { toArray: () => [{ cnt: 0 }] };
  }

  private handleMinSelect(
    _query: string,
    _params: unknown[]
  ): { toArray: () => Record<string, unknown>[] } {
    const schedule = this.tables.get('idle_cleanup_schedule') || [];
    if (schedule.length === 0) return { toArray: () => [{ earliest: null }] };
    const min = Math.min(...schedule.map((r) => r.cleanup_at as number));
    return { toArray: () => [{ earliest: min }] };
  }

  private handleMaxSelect(
    _query: string,
    _params: unknown[]
  ): { toArray: () => Record<string, unknown>[] } {
    const events = this.tables.get('activity_events') || [];
    if (events.length === 0) return { toArray: () => [{ latest: null }] };
    const max = Math.max(...events.map((e) => e.created_at as number));
    return { toArray: () => [{ latest: max }] };
  }

  private handleSessionSelect(
    query: string,
    params: unknown[]
  ): { toArray: () => Record<string, unknown>[] } {
    const upper = query.toUpperCase();
    const sessions = this.tables.get('chat_sessions') || [];

    if (upper.includes('WHERE ID = ?')) {
      const id = params[0] as string;
      return { toArray: () => sessions.filter((s) => s.id === id) };
    }

    if (upper.includes('WHERE TASK_ID = ?')) {
      const taskId = params[0] as string;
      return { toArray: () => sessions.filter((s) => s.task_id === taskId) };
    }

    if (upper.includes('MESSAGE_COUNT') && !upper.includes('SET')) {
      if (params.length > 0) {
        const id = params[0] as string;
        return { toArray: () => sessions.filter((s) => s.id === id) };
      }
    }

    return { toArray: () => sessions };
  }

  private handleMessageSelect(
    query: string,
    params: unknown[]
  ): { toArray: () => Record<string, unknown>[] } {
    const messages = this.tables.get('chat_messages') || [];
    const upper = query.toUpperCase();

    const sessionId = params[0] as string;
    let filtered = messages.filter((m) => m.session_id === sessionId);

    if (upper.includes('WHERE ID = ?')) {
      // Single message by ID
      const id = params[0] as string;
      return { toArray: () => messages.filter((m) => m.id === id) };
    }

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

    if (upper.includes('LIMIT')) {
      const limit = params[params.length - 1] as number;
      return {
        toArray: () =>
          filtered
            .sort((a, b) => (b.created_at as number) - (a.created_at as number))
            .slice(0, limit),
      };
    }

    return { toArray: () => filtered };
  }

  private handleIdleCleanupSelect(
    query: string,
    params: unknown[]
  ): { toArray: () => Record<string, unknown>[] } {
    const upper = query.toUpperCase();
    const schedule = this.tables.get('idle_cleanup_schedule') || [];

    if (upper.includes('WHERE SESSION_ID = ?')) {
      const sessionId = params[0] as string;
      return { toArray: () => schedule.filter((r) => r.session_id === sessionId) };
    }

    if (upper.includes('WHERE CLEANUP_AT <= ?')) {
      const now = params[0] as number;
      return { toArray: () => schedule.filter((r) => (r.cleanup_at as number) <= now) };
    }

    return { toArray: () => schedule };
  }

  private handleActivitySelect(
    _query: string,
    _params: unknown[]
  ): { toArray: () => Record<string, unknown>[] } {
    const events = this.tables.get('activity_events') || [];
    return { toArray: () => events };
  }

  private handleUpdate(
    query: string,
    params: unknown[]
  ): { toArray: () => Record<string, unknown>[] } {
    const upper = query.toUpperCase();

    if (upper.includes('UPDATE CHAT_SESSIONS')) {
      const sessions = this.tables.get('chat_sessions') || [];

      // SET workspace_id = ? (linkSessionToWorkspace)
      if (upper.includes('SET WORKSPACE_ID = ?') && upper.includes('WHERE ID = ?')) {
        const workspaceId = params[0];
        const updatedAt = params[1];
        const id = params[2] as string;
        for (const s of sessions) {
          if (s.id === id) {
            s.workspace_id = workspaceId;
            s.updated_at = updatedAt;
          }
        }
      }

      // Stop session
      if (upper.includes("STATUS = 'STOPPED'")) {
        const endedAt = params[0];
        const updatedAt = params[1];
        const id = params[2] as string;
        for (const s of sessions) {
          if (s.id === id && s.status === 'active') {
            s.status = 'stopped';
            s.ended_at = endedAt;
            s.updated_at = updatedAt;
          }
        }
      }

      // Update message_count (increment by 1)
      if (upper.includes('MESSAGE_COUNT = MESSAGE_COUNT + 1')) {
        const updatedAt = params[0];
        const id = params[1] as string;
        for (const s of sessions) {
          if (s.id === id) {
            s.message_count = ((s.message_count as number) || 0) + 1;
            s.updated_at = updatedAt;
          }
        }
      }

      // Update message_count (increment by N — batch)
      if (upper.includes('MESSAGE_COUNT = MESSAGE_COUNT + ?')) {
        const increment = params[0] as number;
        const updatedAt = params[1];
        const id = params[2] as string;
        for (const s of sessions) {
          if (s.id === id) {
            s.message_count = ((s.message_count as number) || 0) + increment;
            s.updated_at = updatedAt;
          }
        }
      }

      // Update topic
      if (upper.includes('SET TOPIC = ?') && !upper.includes('MESSAGE_COUNT')) {
        const topic = params[0];
        const updatedAt = params[1];
        const id = params[2] as string;
        for (const s of sessions) {
          if (s.id === id) {
            s.topic = topic;
            s.updated_at = updatedAt;
          }
        }
      }

      // Set agent_completed_at
      if (upper.includes('AGENT_COMPLETED_AT = ?')) {
        const agentCompletedAt = params[0];
        const updatedAt = params[1];
        const id = params[2] as string;
        for (const s of sessions) {
          if (s.id === id && !s.agent_completed_at) {
            s.agent_completed_at = agentCompletedAt;
            s.updated_at = updatedAt;
          }
        }
      }
    }

    if (upper.includes('UPDATE IDLE_CLEANUP_SCHEDULE')) {
      const schedule = this.tables.get('idle_cleanup_schedule') || [];
      if (upper.includes('SET CLEANUP_AT = ?')) {
        const cleanupAt = params[0];
        const retryCount = params[1];
        const sessionId = params[2] as string;
        for (const r of schedule) {
          if (r.session_id === sessionId) {
            r.cleanup_at = cleanupAt;
            r.retry_count = retryCount;
          }
        }
      }
    }

    return { toArray: () => [] };
  }

  private handleDelete(
    query: string,
    params: unknown[]
  ): { toArray: () => Record<string, unknown>[] } {
    const upper = query.toUpperCase();

    if (upper.includes('FROM IDLE_CLEANUP_SCHEDULE')) {
      const schedule = this.tables.get('idle_cleanup_schedule') || [];
      if (upper.includes('WHERE SESSION_ID = ?')) {
        const sessionId = params[0] as string;
        this.tables.set(
          'idle_cleanup_schedule',
          schedule.filter((r) => r.session_id !== sessionId)
        );
      }
    }

    return { toArray: () => [] };
  }

  getTable(name: string): Record<string, unknown>[] {
    return this.tables.get(name) || [];
  }
}

/**
 * Creates a mock that simulates the ProjectData DO methods relevant to TDF-6.
 */
function createMockProjectDataDO(projectId: string) {
  const sql = new InMemorySqlStorage();
  const broadcastedEvents: { type: string; payload: Record<string, unknown> }[] = [];

  // Run migrations
  runMigrations(sql as unknown as SqlStorage);

  function generateId(): string {
    return crypto.randomUUID();
  }

  function broadcastEvent(type: string, payload: Record<string, unknown>): void {
    broadcastedEvents.push({ type, payload });
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
      id, eventType, actorType, actorId, workspaceId, sessionId, taskId, payload, now
    );
    return id;
  }

  return {
    projectId,
    sql,
    broadcastedEvents,

    async createSession(
      workspaceId: string | null,
      topic: string | null,
      taskId: string | null = null
    ): Promise<string> {
      const maxSessions = 1000;
      const countRow = sql
        .exec('SELECT COUNT(*) as cnt FROM chat_sessions')
        .toArray()[0];
      if ((countRow?.cnt as number) >= maxSessions) {
        throw new Error(`Maximum ${maxSessions} sessions per project exceeded`);
      }
      const id = generateId();
      const now = Date.now();
      sql.exec(
        `INSERT INTO chat_sessions (id, workspace_id, task_id, topic, status, message_count, started_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', 0, ?, ?, ?)`,
        id, workspaceId, taskId, topic, now, now, now
      );
      recordActivityEventInternal('session.started', 'system', null, workspaceId, id, taskId, null);
      broadcastEvent('session.created', { id, workspaceId, taskId, topic, status: 'active' });
      return id;
    },

    async linkSessionToWorkspace(
      sessionId: string,
      workspaceId: string
    ): Promise<void> {
      const session = sql
        .exec('SELECT id, status FROM chat_sessions WHERE id = ?', sessionId)
        .toArray()[0];
      if (!session) {
        throw new Error(`Session ${sessionId} not found`);
      }
      const now = Date.now();
      sql.exec(
        'UPDATE chat_sessions SET workspace_id = ?, updated_at = ? WHERE id = ?',
        workspaceId, now, sessionId
      );
      broadcastEvent('session.updated', { sessionId, workspaceId });
    },

    async stopSession(sessionId: string): Promise<void> {
      const now = Date.now();
      sql.exec(
        `UPDATE chat_sessions SET status = 'stopped', ended_at = ?, updated_at = ? WHERE id = ? AND status = 'active'`,
        now, now, sessionId
      );
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
        id, sessionId, role, content, toolMetadata, now
      );
      sql.exec(
        `UPDATE chat_sessions SET message_count = message_count + 1, updated_at = ? WHERE id = ?`,
        now, sessionId
      );
      broadcastEvent('message.new', { sessionId, messageId: id, role });
      return id;
    },

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
      const session = sql
        .exec('SELECT id, message_count, topic, status FROM chat_sessions WHERE id = ?', sessionId)
        .toArray()[0];
      if (!session) {
        throw new Error(`Session ${sessionId} not found`);
      }

      let persisted = 0;
      let duplicates = 0;
      const now = Date.now();

      for (const msg of messages) {
        const existing = sql
          .exec('SELECT id FROM chat_messages WHERE id = ?', msg.messageId)
          .toArray()[0];
        if (existing) {
          duplicates++;
          continue;
        }
        const createdAt = new Date(msg.timestamp).getTime() || now;
        sql.exec(
          `INSERT INTO chat_messages (id, session_id, role, content, tool_metadata, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          msg.messageId, sessionId, msg.role, msg.content, msg.toolMetadata, createdAt
        );
        persisted++;
      }

      if (persisted > 0) {
        sql.exec(
          `UPDATE chat_sessions SET message_count = message_count + ?, updated_at = ? WHERE id = ?`,
          persisted, now, sessionId
        );
      }

      return { persisted, duplicates };
    },

    getSession(sessionId: string): Record<string, unknown> | null {
      const rows = sql
        .exec('SELECT id, workspace_id, task_id, topic, status, message_count, started_at, created_at, updated_at FROM chat_sessions WHERE id = ?', sessionId)
        .toArray();
      return rows[0] || null;
    },

    getSessionsByTaskId(taskId: string): Record<string, unknown>[] {
      return sql
        .exec('SELECT id, workspace_id, task_id, topic, status, message_count FROM chat_sessions WHERE task_id = ?', taskId)
        .toArray();
    },

    getMessages(sessionId: string): Record<string, unknown>[] {
      return sql.getTable('chat_messages').filter((m) => m.session_id === sessionId);
    },
  };
}

// =========================================================================
// Tests
// =========================================================================

describe('TDF-6: Chat session lifecycle', () => {
  let projectDO: ReturnType<typeof createMockProjectDataDO>;

  beforeEach(() => {
    projectDO = createMockProjectDataDO('project-test');
  });

  describe('single session per task', () => {
    it('creates exactly one session for a task', async () => {
      const taskId = 'task-001';
      const sessionId = await projectDO.createSession(null, 'Test task', taskId);

      const sessions = projectDO.getSessionsByTaskId(taskId);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe(sessionId);
    });

    it('session is created with workspaceId=null before workspace exists', async () => {
      const sessionId = await projectDO.createSession(null, 'Test task', 'task-001');
      const session = projectDO.getSession(sessionId);

      expect(session).not.toBeNull();
      expect(session!.workspace_id).toBeNull();
      expect(session!.task_id).toBe('task-001');
      expect(session!.status).toBe('active');
    });

    it('creating multiple sessions for different tasks is allowed', async () => {
      const s1 = await projectDO.createSession(null, 'Task 1', 'task-001');
      const s2 = await projectDO.createSession(null, 'Task 2', 'task-002');

      expect(s1).not.toBe(s2);

      const sessions1 = projectDO.getSessionsByTaskId('task-001');
      const sessions2 = projectDO.getSessionsByTaskId('task-002');
      expect(sessions1).toHaveLength(1);
      expect(sessions2).toHaveLength(1);
    });
  });

  describe('workspace-session linking', () => {
    it('links workspace to existing session', async () => {
      const sessionId = await projectDO.createSession(null, 'Test task', 'task-001');
      const workspaceId = 'ws-abc123';

      await projectDO.linkSessionToWorkspace(sessionId, workspaceId);

      const session = projectDO.getSession(sessionId);
      expect(session!.workspace_id).toBe(workspaceId);
    });

    it('broadcasts session.updated event on link', async () => {
      const sessionId = await projectDO.createSession(null, 'Test task', 'task-001');
      const beforeCount = projectDO.broadcastedEvents.length;

      await projectDO.linkSessionToWorkspace(sessionId, 'ws-abc123');

      const newEvents = projectDO.broadcastedEvents.slice(beforeCount);
      expect(newEvents).toHaveLength(1);
      expect(newEvents[0].type).toBe('session.updated');
      expect(newEvents[0].payload.sessionId).toBe(sessionId);
      expect(newEvents[0].payload.workspaceId).toBe('ws-abc123');
    });

    it('throws if session does not exist', async () => {
      await expect(
        projectDO.linkSessionToWorkspace('nonexistent-session', 'ws-abc123')
      ).rejects.toThrow(/not found/i);
    });

    it('preserves existing messages after linking', async () => {
      const sessionId = await projectDO.createSession(null, 'Test task', 'task-001');

      // Persist a message BEFORE linking
      await projectDO.persistMessage(sessionId, 'user', 'Initial message', null);

      // Link workspace
      await projectDO.linkSessionToWorkspace(sessionId, 'ws-abc123');

      // Messages should still be there
      const messages = projectDO.getMessages(sessionId);
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Initial message');
    });

    it('messages persist correctly after linking', async () => {
      const sessionId = await projectDO.createSession(null, 'Test task', 'task-001');
      await projectDO.persistMessage(sessionId, 'user', 'Before link', null);
      await projectDO.linkSessionToWorkspace(sessionId, 'ws-abc123');
      await projectDO.persistMessage(sessionId, 'assistant', 'After link', null);

      const messages = projectDO.getMessages(sessionId);
      expect(messages).toHaveLength(2);
      const roles = messages.map((m) => m.role);
      expect(roles).toContain('user');
      expect(roles).toContain('assistant');
    });
  });

  describe('message persistence', () => {
    it('persists initial user message to session', async () => {
      const sessionId = await projectDO.createSession(null, 'Test task', 'task-001');
      await projectDO.persistMessage(sessionId, 'user', 'Hello, agent!', null);

      const messages = projectDO.getMessages(sessionId);
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe('user');
      expect(messages[0].content).toBe('Hello, agent!');
    });

    it('increments message_count on session', async () => {
      const sessionId = await projectDO.createSession(null, 'Test task', 'task-001');

      await projectDO.persistMessage(sessionId, 'user', 'Msg 1', null);
      let session = projectDO.getSession(sessionId);
      expect(session!.message_count).toBe(1);

      await projectDO.persistMessage(sessionId, 'assistant', 'Msg 2', null);
      session = projectDO.getSession(sessionId);
      expect(session!.message_count).toBe(2);
    });

    it('throws when persisting to nonexistent session', async () => {
      await expect(
        projectDO.persistMessage('nonexistent', 'user', 'Hello', null)
      ).rejects.toThrow(/not found/i);
    });

    it('broadcasts message.new event for each message', async () => {
      const sessionId = await projectDO.createSession(null, 'Test task', 'task-001');
      const beforeCount = projectDO.broadcastedEvents.length;

      await projectDO.persistMessage(sessionId, 'user', 'Hello', null);

      const newEvents = projectDO.broadcastedEvents.slice(beforeCount);
      const messageEvents = newEvents.filter((e) => e.type === 'message.new');
      expect(messageEvents).toHaveLength(1);
      expect(messageEvents[0].payload.sessionId).toBe(sessionId);
      expect(messageEvents[0].payload.role).toBe('user');
    });
  });

  describe('message batch deduplication', () => {
    it('deduplicates messages by messageId', async () => {
      const sessionId = await projectDO.createSession(null, 'Test task', 'task-001');

      const batch1 = [
        { messageId: 'msg-1', role: 'assistant', content: 'Response 1', toolMetadata: null, timestamp: new Date().toISOString() },
        { messageId: 'msg-2', role: 'assistant', content: 'Response 2', toolMetadata: null, timestamp: new Date().toISOString() },
      ];

      const result1 = await projectDO.persistMessageBatch(sessionId, batch1);
      expect(result1.persisted).toBe(2);
      expect(result1.duplicates).toBe(0);

      // Send same batch again — should all be duplicates
      const result2 = await projectDO.persistMessageBatch(sessionId, batch1);
      expect(result2.persisted).toBe(0);
      expect(result2.duplicates).toBe(2);

      // Total messages should be 2, not 4
      const messages = projectDO.getMessages(sessionId);
      expect(messages).toHaveLength(2);
    });

    it('handles partial overlap in batches', async () => {
      const sessionId = await projectDO.createSession(null, 'Test task', 'task-001');

      await projectDO.persistMessageBatch(sessionId, [
        { messageId: 'msg-1', role: 'assistant', content: 'R1', toolMetadata: null, timestamp: new Date().toISOString() },
      ]);

      // Second batch with one existing and one new
      const result = await projectDO.persistMessageBatch(sessionId, [
        { messageId: 'msg-1', role: 'assistant', content: 'R1', toolMetadata: null, timestamp: new Date().toISOString() },
        { messageId: 'msg-2', role: 'assistant', content: 'R2', toolMetadata: null, timestamp: new Date().toISOString() },
      ]);

      expect(result.persisted).toBe(1);
      expect(result.duplicates).toBe(1);

      const messages = projectDO.getMessages(sessionId);
      expect(messages).toHaveLength(2);
    });

    it('throws when batch targets nonexistent session', async () => {
      await expect(
        projectDO.persistMessageBatch('nonexistent', [
          { messageId: 'msg-1', role: 'user', content: 'Hello', toolMetadata: null, timestamp: new Date().toISOString() },
        ])
      ).rejects.toThrow(/not found/i);
    });
  });

  describe('full lifecycle: create → link → messages → stop', () => {
    it('completes full session lifecycle correctly', async () => {
      const taskId = 'task-lifecycle';
      const workspaceId = 'ws-lifecycle';

      // 1. Create session at task submit time (workspaceId unknown)
      const sessionId = await projectDO.createSession(null, 'Lifecycle test', taskId);
      let session = projectDO.getSession(sessionId);
      expect(session!.workspace_id).toBeNull();
      expect(session!.status).toBe('active');

      // 2. Persist initial user message
      await projectDO.persistMessage(sessionId, 'user', 'Please fix the bug', null);

      // 3. Link workspace when TaskRunner DO creates it
      await projectDO.linkSessionToWorkspace(sessionId, workspaceId);
      session = projectDO.getSession(sessionId);
      expect(session!.workspace_id).toBe(workspaceId);

      // 4. Agent sends messages (via VM agent → message batch endpoint)
      await projectDO.persistMessageBatch(sessionId, [
        { messageId: 'agent-msg-1', role: 'assistant', content: 'I found the issue', toolMetadata: null, timestamp: new Date().toISOString() },
        { messageId: 'agent-msg-2', role: 'assistant', content: 'Fixed!', toolMetadata: null, timestamp: new Date().toISOString() },
      ]);

      // 5. Verify all messages are in one session
      const messages = projectDO.getMessages(sessionId);
      expect(messages).toHaveLength(3); // 1 user + 2 assistant
      session = projectDO.getSession(sessionId);
      expect(session!.message_count).toBe(3);

      // 6. Stop session (idle cleanup)
      await projectDO.stopSession(sessionId);
      session = projectDO.getSession(sessionId);
      expect(session!.status).toBe('stopped');
      expect(session!.ended_at).not.toBeNull();

      // 7. Verify only one session exists for this task
      const taskSessions = projectDO.getSessionsByTaskId(taskId);
      expect(taskSessions).toHaveLength(1);
    });

    it('session without workspace link still accepts messages (graceful degradation)', async () => {
      // Simulates the case where linkSessionToWorkspace fails
      const sessionId = await projectDO.createSession(null, 'Test task', 'task-no-link');

      // Messages should work even without workspace link
      await projectDO.persistMessage(sessionId, 'user', 'Initial message', null);
      await projectDO.persistMessageBatch(sessionId, [
        { messageId: 'batch-1', role: 'assistant', content: 'Working on it', toolMetadata: null, timestamp: new Date().toISOString() },
      ]);

      const messages = projectDO.getMessages(sessionId);
      expect(messages).toHaveLength(2);

      const session = projectDO.getSession(sessionId);
      expect(session!.workspace_id).toBeNull(); // Still null — that's OK
      expect(session!.message_count).toBe(2);
    });
  });
});
