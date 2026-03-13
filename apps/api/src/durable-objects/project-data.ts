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

import type {
  AcpSession,
  AcpSessionStatus,
  AcpSessionEventActorType,
} from '@simple-agent-manager/shared';
import {
  ACP_SESSION_VALID_TRANSITIONS,
  ACP_SESSION_TERMINAL_STATUSES,
  ACP_SESSION_DEFAULTS,
} from '@simple-agent-manager/shared';

type Env = {
  DATABASE: D1Database;
  BASE_DOMAIN?: string;
  DO_SUMMARY_SYNC_DEBOUNCE_MS?: string;
  MAX_SESSIONS_PER_PROJECT?: string;
  MAX_MESSAGES_PER_SESSION?: string;
  ACTIVITY_RETENTION_DAYS?: string;
  SESSION_IDLE_TIMEOUT_MINUTES?: string;
  IDLE_CLEANUP_RETRY_DELAY_MS?: string;
  IDLE_CLEANUP_MAX_RETRIES?: string;
  ACP_SESSION_DETECTION_WINDOW_MS?: string;
  ACP_SESSION_MAX_FORK_DEPTH?: string;
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

    // Intentional project-wide broadcast (no sessionId) — all clients need to
    // know about new sessions for sidebar/session-list updates.
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
    this.broadcastEvent('session.stopped', { sessionId }, sessionId);
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
    const sequence = this.nextSequence(sessionId);

    this.sql.exec(
      `INSERT INTO chat_messages (id, session_id, role, content, tool_metadata, created_at, sequence)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      sessionId,
      role,
      content,
      toolMetadata,
      now,
      sequence
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
    this.broadcastEvent('message.new', {
      sessionId,
      messageId: id,
      role,
      content,
      toolMetadata: toolMetadata ? JSON.parse(toolMetadata) : null,
      createdAt: now,
      sequence,
    }, sessionId);
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
      sequence?: number;
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
    // Get next sequence once for the whole batch (not per message) to avoid
    // N queries and ensure monotonic assignment within the batch.
    let nextSeq = this.nextSequence(sessionId);
    const persistedMessages: Array<{
      id: string;
      role: string;
      content: string;
      toolMetadata: unknown;
      createdAt: number;
      sequence: number;
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
      // Use client-provided sequence if available, otherwise auto-assign
      const sequence = msg.sequence ?? nextSeq++;
      this.sql.exec(
        `INSERT INTO chat_messages (id, session_id, role, content, tool_metadata, created_at, sequence)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        msg.messageId,
        sessionId,
        msg.role,
        msg.content,
        msg.toolMetadata,
        createdAt,
        sequence
      );
      persisted++;
      persistedMessages.push({
        id: msg.messageId,
        role: msg.role,
        content: msg.content,
        toolMetadata: msg.toolMetadata ? JSON.parse(msg.toolMetadata) : null,
        createdAt,
        sequence,
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
      }, sessionId);
    }

    return { persisted, duplicates };
  }

  /**
   * Link an existing session to a workspace. Called by TaskRunner DO when
   * a workspace is created for a task that already has a session (TDF-6).
   * This ensures one session per task — the session is created at submit
   * time with workspaceId=null, then linked here when the workspace exists.
   */
  async linkSessionToWorkspace(
    sessionId: string,
    workspaceId: string
  ): Promise<void> {
    const session = this.sql
      .exec('SELECT id, status FROM chat_sessions WHERE id = ?', sessionId)
      .toArray()[0];

    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const now = Date.now();
    this.sql.exec(
      'UPDATE chat_sessions SET workspace_id = ?, updated_at = ? WHERE id = ?',
      workspaceId,
      now,
      sessionId
    );

    this.broadcastEvent('session.updated', { sessionId, workspaceId }, sessionId);
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
        `SELECT id, workspace_id, task_id, topic, status, message_count, started_at, ended_at, created_at, updated_at, agent_completed_at FROM chat_sessions ${whereClause} ORDER BY started_at DESC LIMIT ? OFFSET ?`,
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

  /**
   * Returns session summaries for a batch of task IDs.
   * Used by the dashboard to get last-message timestamps for active tasks.
   */
  async getSessionsByTaskIds(
    taskIds: string[]
  ): Promise<Array<Record<string, unknown>>> {
    if (taskIds.length === 0) return [];

    const placeholders = taskIds.map(() => '?').join(', ');
    const rows = this.sql
      .exec(
        `SELECT id, workspace_id, task_id, topic, status, message_count, started_at, ended_at, created_at, updated_at, agent_completed_at
         FROM chat_sessions
         WHERE task_id IN (${placeholders})
         ORDER BY updated_at DESC`,
        ...taskIds
      )
      .toArray();

    return rows.map((row) => this.mapSessionRow(row));
  }

  async getSession(sessionId: string): Promise<Record<string, unknown> | null> {
    const rows = this.sql
      .exec(
        `SELECT cs.id, cs.workspace_id, cs.task_id, cs.topic, cs.status,
                cs.message_count, cs.started_at, cs.ended_at, cs.created_at,
                cs.updated_at, cs.agent_completed_at,
                ics.cleanup_at
         FROM chat_sessions cs
         LEFT JOIN idle_cleanup_schedule ics ON ics.session_id = cs.id
         WHERE cs.id = ?`,
        sessionId
      )
      .toArray();

    const row = rows[0];
    if (!row) return null;
    return this.mapSessionRow(row);
  }

  async getMessages(
    sessionId: string,
    limit: number = 1000,
    before: number | null = null,
    roles?: string[]
  ): Promise<{ messages: Record<string, unknown>[]; hasMore: boolean }> {
    let query =
      'SELECT id, session_id, role, content, tool_metadata, created_at, sequence FROM chat_messages WHERE session_id = ?';
    const params: (string | number)[] = [sessionId];

    if (before !== null) {
      query += ' AND created_at < ?';
      params.push(before);
    }

    if (roles && roles.length > 0) {
      const placeholders = roles.map(() => '?').join(', ');
      query += ` AND role IN (${placeholders})`;
      params.push(...roles);
    }

    // Order by created_at with sequence as tiebreaker for messages
    // that arrive within the same millisecond (streaming chunks).
    query += ' ORDER BY created_at DESC, sequence DESC LIMIT ?';
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
        sequence: row.sequence as number | null,
      })),
      hasMore,
    };
  }

  /**
   * Get total message count for a session, optionally filtered by roles.
   */
  getMessageCount(sessionId: string, roles?: string[]): number {
    let query = 'SELECT COUNT(*) as count FROM chat_messages WHERE session_id = ?';
    const params: (string | number)[] = [sessionId];

    if (roles && roles.length > 0) {
      const placeholders = roles.map(() => '?').join(', ');
      query += ` AND role IN (${placeholders})`;
      params.push(...roles);
    }

    const rows = this.sql.exec(query, ...params).toArray();
    return (rows[0]?.count as number) ?? 0;
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
    // Intentional project-wide broadcast — activity events are cross-session.
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

  /**
   * Mark the agent as completed on a session. Sets agent_completed_at timestamp.
   */
  async markAgentCompleted(sessionId: string): Promise<void> {
    const now = Date.now();
    this.sql.exec(
      `UPDATE chat_sessions SET agent_completed_at = ?, updated_at = ? WHERE id = ? AND agent_completed_at IS NULL`,
      now,
      now,
      sessionId
    );
    this.broadcastEvent('session.agent_completed', { sessionId, agentCompletedAt: now }, sessionId);
  }

  // =========================================================================
  // Idle Cleanup Schedule (T031-T033)
  // =========================================================================

  /**
   * Schedule idle cleanup for a session after agent completion.
   * Inserts/replaces a row in idle_cleanup_schedule and sets the DO alarm
   * to fire at the earliest scheduled cleanup time.
   */
  async scheduleIdleCleanup(
    sessionId: string,
    workspaceId: string,
    taskId: string | null
  ): Promise<{ cleanupAt: number }> {
    const timeoutMinutes = parseInt(this.env.SESSION_IDLE_TIMEOUT_MINUTES || '15', 10);
    const cleanupAt = Date.now() + timeoutMinutes * 60 * 1000;

    this.sql.exec(
      `INSERT OR REPLACE INTO idle_cleanup_schedule (session_id, workspace_id, task_id, cleanup_at, created_at, retry_count)
       VALUES (?, ?, ?, ?, ?, 0)`,
      sessionId,
      workspaceId,
      taskId,
      cleanupAt,
      Date.now()
    );

    await this.recalculateAlarm();
    return { cleanupAt };
  }

  /**
   * Cancel idle cleanup for a session (e.g., when manually stopped).
   */
  async cancelIdleCleanup(sessionId: string): Promise<void> {
    this.sql.exec('DELETE FROM idle_cleanup_schedule WHERE session_id = ?', sessionId);
    await this.recalculateAlarm();
  }

  /**
   * Reset idle cleanup timer for a session (e.g., user sent a follow-up).
   * Returns the new cleanup timestamp.
   */
  async resetIdleCleanup(sessionId: string): Promise<{ cleanupAt: number }> {
    const timeoutMinutes = parseInt(this.env.SESSION_IDLE_TIMEOUT_MINUTES || '15', 10);
    const cleanupAt = Date.now() + timeoutMinutes * 60 * 1000;

    const existing = this.sql
      .exec('SELECT session_id FROM idle_cleanup_schedule WHERE session_id = ?', sessionId)
      .toArray();

    if (existing.length === 0) {
      return { cleanupAt: 0 };
    }

    this.sql.exec(
      'UPDATE idle_cleanup_schedule SET cleanup_at = ?, retry_count = 0 WHERE session_id = ?',
      cleanupAt,
      sessionId
    );

    await this.recalculateAlarm();
    return { cleanupAt };
  }

  /**
   * Get the scheduled cleanup time for a session, if any.
   */
  async getCleanupAt(sessionId: string): Promise<number | null> {
    const row = this.sql
      .exec('SELECT cleanup_at FROM idle_cleanup_schedule WHERE session_id = ?', sessionId)
      .toArray()[0];
    return row ? (row.cleanup_at as number) : null;
  }

  /**
   * DO alarm handler — fires when the earliest idle cleanup is due.
   * Processes all expired rows: completes tasks, stops sessions, marks
   * workspaces for cron cleanup in D1. Retries on failure.
   */
  async alarm(): Promise<void> {
    // Check for ACP session heartbeat timeouts first
    await this.checkHeartbeatTimeouts();

    const now = Date.now();
    const maxRetries = parseInt(this.env.IDLE_CLEANUP_MAX_RETRIES || '1', 10);
    const retryDelay = parseInt(this.env.IDLE_CLEANUP_RETRY_DELAY_MS || '300000', 10);

    const expired = this.sql
      .exec(
        'SELECT session_id, workspace_id, task_id, retry_count FROM idle_cleanup_schedule WHERE cleanup_at <= ?',
        now
      )
      .toArray();

    for (const row of expired) {
      const sessionId = row.session_id as string;
      const workspaceId = row.workspace_id as string;
      const taskId = row.task_id as string | null;
      const retryCount = (row.retry_count as number) || 0;

      try {
        // Stop the session in DO SQLite
        this.stopSessionInternal(sessionId);

        // Update D1: task → completed, workspace → stopped
        if (taskId) {
          await this.completeTaskInD1(taskId);
        }
        await this.stopWorkspaceInD1(workspaceId);

        // Remove from schedule
        this.sql.exec('DELETE FROM idle_cleanup_schedule WHERE session_id = ?', sessionId);

        // Record activity
        this.recordActivityEventInternal(
          'session.idle_cleanup',
          'system',
          null,
          workspaceId,
          sessionId,
          taskId,
          JSON.stringify({ retryCount })
        );
        this.broadcastEvent('session.idle_cleanup', { sessionId, workspaceId, taskId }, sessionId);
        this.scheduleSummarySync();
      } catch (err) {
        console.error('Idle cleanup failed for session', sessionId, err);

        if (retryCount >= maxRetries) {
          // Exhausted retries — remove from schedule, let cron sweep handle it
          this.sql.exec('DELETE FROM idle_cleanup_schedule WHERE session_id = ?', sessionId);
          this.recordActivityEventInternal(
            'session.idle_cleanup_failed',
            'system',
            null,
            workspaceId,
            sessionId,
            taskId,
            JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
              retryCount,
            })
          );
          // Insert a system message into the session to notify the user
          this.persistSystemMessage(
            sessionId,
            'Idle cleanup failed after retries. Your work has been preserved — please check the workspace manually.'
          );
        } else {
          // Schedule retry
          this.sql.exec(
            'UPDATE idle_cleanup_schedule SET cleanup_at = ?, retry_count = ? WHERE session_id = ?',
            now + retryDelay,
            retryCount + 1,
            sessionId
          );
        }
      }
    }

    // Recalculate alarm for remaining/rescheduled rows
    await this.recalculateAlarm();
  }

  /**
   * Recalculate the DO alarm based on the earliest scheduled cleanup
   * AND the earliest active ACP session heartbeat expiry.
   */
  private async recalculateAlarm(): Promise<void> {
    const idleRow = this.sql
      .exec('SELECT MIN(cleanup_at) as earliest FROM idle_cleanup_schedule')
      .toArray()[0];
    const idleEarliest = idleRow?.earliest as number | null;

    // Compute heartbeat alarm from earliest last_heartbeat_at among active sessions
    const earliestHbRow = this.sql
      .exec(
        `SELECT MIN(last_heartbeat_at) as earliest FROM acp_sessions
         WHERE status IN ('assigned', 'running') AND last_heartbeat_at IS NOT NULL`
      )
      .toArray()[0];

    let heartbeatTime: number | null = null;
    const earliestHb = earliestHbRow?.earliest as number | null;
    if (earliestHb !== null) {
      const detectionWindow = parseInt(
        this.env.ACP_SESSION_DETECTION_WINDOW_MS || String(ACP_SESSION_DEFAULTS.DETECTION_WINDOW_MS),
        10
      );
      heartbeatTime = earliestHb + detectionWindow;
    }

    const candidates = [idleEarliest, heartbeatTime].filter((t): t is number => t !== null);
    if (candidates.length > 0) {
      await this.ctx.storage.setAlarm(Math.min(...candidates));
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }

  /**
   * Stop a session directly in DO SQLite (internal, no broadcast).
   */
  private stopSessionInternal(sessionId: string): void {
    const now = Date.now();
    this.sql.exec(
      `UPDATE chat_sessions SET status = 'stopped', ended_at = ?, updated_at = ? WHERE id = ? AND status = 'active'`,
      now,
      now,
      sessionId
    );
  }

  /**
   * Transition a task to 'completed' in D1. Best-effort — the cron
   * sweep will catch anything missed.
   */
  private async completeTaskInD1(taskId: string): Promise<void> {
    const now = new Date().toISOString();
    try {
      await this.env.DATABASE.prepare(
        `UPDATE tasks SET status = 'completed', execution_step = NULL, completed_at = ?, updated_at = ? WHERE id = ? AND status IN ('in_progress', 'delegated')`
      )
        .bind(now, now, taskId)
        .run();
    } catch (err) {
      console.error('D1 task completion failed for', taskId, err);
      throw err;
    }
  }

  /**
   * Mark a workspace as 'stopped' in D1. The cron sweep handles actual
   * node cleanup (same pattern as NodeLifecycle DO).
   */
  private async stopWorkspaceInD1(workspaceId: string): Promise<void> {
    const now = new Date().toISOString();
    try {
      await this.env.DATABASE.prepare(
        `UPDATE workspaces SET status = 'stopped', updated_at = ? WHERE id = ? AND status IN ('running', 'recovery')`
      )
        .bind(now, workspaceId)
        .run();
    } catch (err) {
      console.error('D1 workspace stop failed for', workspaceId, err);
      throw err;
    }
  }

  /**
   * Persist a system message into a session (for user notification).
   */
  private persistSystemMessage(sessionId: string, content: string): void {
    try {
      const id = generateId();
      const now = Date.now();
      const sequence = this.nextSequence(sessionId);
      this.sql.exec(
        `INSERT INTO chat_messages (id, session_id, role, content, tool_metadata, created_at, sequence)
         VALUES (?, ?, 'system', ?, NULL, ?, ?)`,
        id,
        sessionId,
        content,
        now,
        sequence
      );
      this.sql.exec(
        `UPDATE chat_sessions SET message_count = message_count + 1, updated_at = ? WHERE id = ?`,
        now,
        sessionId
      );
      this.broadcastEvent('message.new', {
        sessionId,
        messageId: id,
        role: 'system',
        content,
        toolMetadata: null,
        createdAt: now,
        sequence,
      }, sessionId);
    } catch (e) {
      console.warn(JSON.stringify({ event: 'project_data.system_message_insert_failed', sessionId, error: String(e) }));
    }
  }

  // =========================================================================
  // ACP Session Lifecycle (Spec 027 — DO-Owned Sessions)
  // =========================================================================

  /**
   * Create a new ACP session in "pending" state.
   * The session tracks the execution of an agent within a chat session.
   */
  async createAcpSession(opts: {
    chatSessionId: string;
    initialPrompt: string | null;
    agentType: string | null;
    parentSessionId?: string | null;
    forkDepth?: number;
  }): Promise<AcpSession> {
    // Validate chat session exists
    const chatSession = this.sql
      .exec('SELECT id FROM chat_sessions WHERE id = ?', opts.chatSessionId)
      .toArray()[0];
    if (!chatSession) {
      throw new Error(`Chat session ${opts.chatSessionId} not found`);
    }

    const id = generateId();
    const now = Date.now();

    this.sql.exec(
      `INSERT INTO acp_sessions (id, chat_session_id, parent_session_id, status, agent_type, initial_prompt, fork_depth, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      id,
      opts.chatSessionId,
      opts.parentSessionId ?? null,
      opts.agentType ?? null,
      opts.initialPrompt ?? null,
      opts.forkDepth ?? 0,
      now,
      now
    );

    this.recordAcpSessionEvent(id, null, 'pending', 'system', null, 'Session created');

    const projectId = this.getProjectId();
    console.log(JSON.stringify({
      event: 'acp_session.created',
      sessionId: id,
      chatSessionId: opts.chatSessionId,
      projectId,
      parentSessionId: opts.parentSessionId ?? null,
      forkDepth: opts.forkDepth ?? 0,
    }));

    return this.getAcpSessionOrThrow(id);
  }

  /**
   * Get a single ACP session by ID.
   */
  async getAcpSession(sessionId: string): Promise<AcpSession | null> {
    const row = this.sql
      .exec('SELECT * FROM acp_sessions WHERE id = ?', sessionId)
      .toArray()[0];
    return row ? this.mapAcpSessionRow(row) : null;
  }

  /**
   * List ACP sessions for this project, optionally filtered by chat session or status.
   */
  async listAcpSessions(opts?: {
    chatSessionId?: string;
    status?: AcpSessionStatus;
    nodeId?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ sessions: AcpSession[]; total: number }> {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (opts?.chatSessionId) {
      conditions.push('chat_session_id = ?');
      params.push(opts.chatSessionId);
    }
    if (opts?.status) {
      conditions.push('status = ?');
      params.push(opts.status);
    }
    if (opts?.nodeId) {
      conditions.push('node_id = ?');
      params.push(opts.nodeId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts?.limit ?? 50;
    const offset = opts?.offset ?? 0;

    const totalRow = this.sql
      .exec(`SELECT COUNT(*) as cnt FROM acp_sessions ${where}`, ...params)
      .toArray()[0];

    const rows = this.sql
      .exec(
        `SELECT * FROM acp_sessions ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        ...params,
        limit,
        offset
      )
      .toArray();

    return {
      sessions: rows.map((row) => this.mapAcpSessionRow(row)),
      total: (totalRow?.cnt as number) || 0,
    };
  }

  /**
   * Transition an ACP session to a new state with validation.
   * Enforces the state machine — invalid transitions return an error.
   */
  async transitionAcpSession(
    sessionId: string,
    toStatus: AcpSessionStatus,
    opts: {
      actorType: AcpSessionEventActorType;
      actorId?: string | null;
      reason?: string | null;
      metadata?: Record<string, unknown> | null;
      workspaceId?: string;
      nodeId?: string;
      acpSdkSessionId?: string;
      errorMessage?: string;
    }
  ): Promise<AcpSession> {
    const session = this.sql
      .exec('SELECT * FROM acp_sessions WHERE id = ?', sessionId)
      .toArray()[0];

    if (!session) {
      throw new Error(`ACP session ${sessionId} not found`);
    }

    const fromStatus = session.status as AcpSessionStatus;
    const validTargets = ACP_SESSION_VALID_TRANSITIONS[fromStatus];

    if (!validTargets.includes(toStatus)) {
      const projectId = this.getProjectId();
      console.error(JSON.stringify({
        event: 'acp_session.invalid_transition',
        sessionId,
        chatSessionId: session.chat_session_id,
        projectId,
        fromStatus,
        toStatus,
        action: 'rejected',
      }));
      throw new Error(
        `Invalid ACP session transition: ${fromStatus} → ${toStatus} (session ${sessionId})`
      );
    }

    const now = Date.now();

    // Atomic single-UPDATE per transition type — never split status + fields across statements.
    // All values are parameterized to prevent SQL injection.
    if (toStatus === 'assigned') {
      this.sql.exec(
        `UPDATE acp_sessions SET status = ?, workspace_id = ?, node_id = ?, assigned_at = ?, last_heartbeat_at = ?, updated_at = ? WHERE id = ?`,
        toStatus, opts.workspaceId ?? null, opts.nodeId ?? null, now, now, now, sessionId
      );
    } else if (toStatus === 'running') {
      this.sql.exec(
        `UPDATE acp_sessions SET status = ?, acp_sdk_session_id = ?, started_at = ?, updated_at = ? WHERE id = ?`,
        toStatus, opts.acpSdkSessionId ?? null, now, now, sessionId
      );
    } else if (toStatus === 'completed' || toStatus === 'failed') {
      this.sql.exec(
        `UPDATE acp_sessions SET status = ?, completed_at = ?, error_message = ?, updated_at = ? WHERE id = ?`,
        toStatus, now, opts.errorMessage ?? null, now, sessionId
      );
    } else if (toStatus === 'interrupted') {
      this.sql.exec(
        `UPDATE acp_sessions SET status = ?, interrupted_at = ?, error_message = ?, updated_at = ? WHERE id = ?`,
        toStatus, now, opts.errorMessage ?? null, now, sessionId
      );
    } else {
      this.sql.exec(
        `UPDATE acp_sessions SET status = ?, updated_at = ? WHERE id = ?`,
        toStatus, now, sessionId
      );
    }

    this.recordAcpSessionEvent(
      sessionId,
      fromStatus,
      toStatus,
      opts.actorType,
      opts.actorId ?? null,
      opts.reason ?? null,
      opts.metadata ?? null
    );

    const projectId = this.getProjectId();
    console.log(JSON.stringify({
      event: 'acp_session.transitioned',
      sessionId,
      chatSessionId: session.chat_session_id,
      workspaceId: opts.workspaceId ?? session.workspace_id,
      nodeId: opts.nodeId ?? session.node_id,
      projectId,
      fromStatus,
      toStatus,
    }));

    // Schedule heartbeat detection alarm when session becomes active
    if (toStatus === 'assigned' || toStatus === 'running') {
      await this.scheduleHeartbeatAlarm();
    }

    return this.getAcpSessionOrThrow(sessionId);
  }

  /**
   * Update heartbeat timestamp for a session. Resets the detection alarm.
   */
  async updateHeartbeat(sessionId: string, nodeId: string): Promise<void> {
    const session = this.sql
      .exec('SELECT id, node_id, status FROM acp_sessions WHERE id = ?', sessionId)
      .toArray()[0];

    if (!session) {
      throw new Error(`ACP session ${sessionId} not found`);
    }

    if (session.node_id !== nodeId) {
      const projectId = this.getProjectId();
      console.error(JSON.stringify({
        event: 'acp_session.heartbeat_node_mismatch',
        sessionId,
        expectedNodeId: session.node_id,
        receivedNodeId: nodeId,
        projectId,
        action: 'rejected',
      }));
      throw new Error(`Node mismatch: session assigned to ${session.node_id}, heartbeat from ${nodeId}`);
    }

    const status = session.status as string;
    if (!['assigned', 'running'].includes(status)) {
      const projectId = this.getProjectId();
      console.warn(JSON.stringify({
        event: 'acp_session.heartbeat_for_inactive_session',
        sessionId,
        nodeId,
        projectId,
        sessionStatus: status,
        action: 'rejected',
      }));
      throw new Error(
        `Heartbeat rejected: session ${sessionId} is in "${status}" state, not assigned or running`
      );
    }

    const now = Date.now();
    this.sql.exec(
      'UPDATE acp_sessions SET last_heartbeat_at = ?, updated_at = ? WHERE id = ?',
      now,
      now,
      sessionId
    );

    await this.scheduleHeartbeatAlarm();
  }

  /**
   * Fork a completed/interrupted session, creating a new session with context.
   */
  async forkAcpSession(
    sessionId: string,
    contextSummary: string
  ): Promise<AcpSession> {
    const parent = this.sql
      .exec('SELECT * FROM acp_sessions WHERE id = ?', sessionId)
      .toArray()[0];

    if (!parent) {
      throw new Error(`ACP session ${sessionId} not found`);
    }

    const parentStatus = parent.status as AcpSessionStatus;
    if (!ACP_SESSION_TERMINAL_STATUSES.includes(parentStatus)) {
      const projectId = this.getProjectId();
      console.warn(JSON.stringify({
        event: 'acp_session.fork_invalid_state',
        sessionId,
        projectId,
        parentStatus,
        action: 'rejected',
      }));
      throw new Error(
        `Cannot fork session in "${parentStatus}" state — must be completed, failed, or interrupted`
      );
    }

    const parentDepth = parent.fork_depth as number;
    const maxDepth = parseInt(
      this.env.ACP_SESSION_MAX_FORK_DEPTH || String(ACP_SESSION_DEFAULTS.MAX_FORK_DEPTH),
      10
    );
    if (parentDepth >= maxDepth) {
      const projectId = this.getProjectId();
      console.warn(JSON.stringify({
        event: 'acp_session.fork_depth_exceeded',
        sessionId,
        projectId,
        parentDepth,
        maxDepth,
        action: 'rejected',
      }));
      throw new Error(
        `Fork depth ${parentDepth + 1} exceeds maximum ${maxDepth}`
      );
    }

    return this.createAcpSession({
      chatSessionId: parent.chat_session_id as string,
      initialPrompt: contextSummary,
      agentType: parent.agent_type as string | null,
      parentSessionId: sessionId,
      forkDepth: parentDepth + 1,
    });
  }

  /**
   * Get the fork lineage for a session — walks up to root and collects all descendants.
   */
  async getAcpSessionLineage(sessionId: string): Promise<AcpSession[]> {
    // Find the root session first, with cycle guard
    let rootId = sessionId;
    const visited = new Set<string>([rootId]);
    let current = this.sql
      .exec('SELECT id, parent_session_id FROM acp_sessions WHERE id = ?', rootId)
      .toArray()[0];

    while (current?.parent_session_id) {
      const parentId = current.parent_session_id as string;
      if (visited.has(parentId)) break; // cycle guard
      visited.add(parentId);
      rootId = parentId;
      current = this.sql
        .exec('SELECT id, parent_session_id FROM acp_sessions WHERE id = ?', rootId)
        .toArray()[0];
    }

    // Get all sessions in the lineage tree using recursive CTE
    const rows = this.sql
      .exec(
        `WITH RECURSIVE lineage AS (
          SELECT * FROM acp_sessions WHERE id = ?
          UNION ALL
          SELECT s.* FROM acp_sessions s
          INNER JOIN lineage l ON s.parent_session_id = l.id
        )
        SELECT * FROM lineage ORDER BY fork_depth, created_at`,
        rootId
      )
      .toArray();

    return rows.map((row) => this.mapAcpSessionRow(row));
  }

  /**
   * List ACP sessions by node ID across all statuses matching the filter.
   * Used for VM agent reconciliation on startup.
   */
  async listAcpSessionsByNode(
    nodeId: string,
    statuses: AcpSessionStatus[]
  ): Promise<AcpSession[]> {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => '?').join(', ');
    const rows = this.sql
      .exec(
        `SELECT * FROM acp_sessions WHERE node_id = ? AND status IN (${placeholders})`,
        nodeId,
        ...statuses
      )
      .toArray();
    return rows.map((row) => this.mapAcpSessionRow(row));
  }

  /**
   * Check for ACP sessions that have missed their heartbeat window.
   * Called from the DO alarm handler.
   */
  private async checkHeartbeatTimeouts(): Promise<void> {
    const detectionWindow = parseInt(
      this.env.ACP_SESSION_DETECTION_WINDOW_MS || String(ACP_SESSION_DEFAULTS.DETECTION_WINDOW_MS),
      10
    );
    const cutoff = Date.now() - detectionWindow;

    const staleSessions = this.sql
      .exec(
        `SELECT id, chat_session_id, workspace_id, node_id, last_heartbeat_at FROM acp_sessions
         WHERE status IN ('assigned', 'running')
         AND last_heartbeat_at IS NOT NULL
         AND last_heartbeat_at < ?`,
        cutoff
      )
      .toArray();

    const failures: Array<{ sessionId: string; error: string }> = [];
    for (const session of staleSessions) {
      const sessionId = session.id as string;
      try {
        await this.transitionAcpSession(sessionId, 'interrupted', {
          actorType: 'alarm',
          reason: 'Heartbeat timeout exceeded detection window',
          errorMessage: `Heartbeat timeout: last heartbeat at ${session.last_heartbeat_at}, cutoff was ${cutoff}`,
          metadata: {
            detectionWindowMs: detectionWindow,
            lastHeartbeatAt: session.last_heartbeat_at,
            cutoff,
          },
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(JSON.stringify({
          event: 'acp_session.heartbeat_timeout_transition_failed',
          sessionId,
          error: errorMsg,
        }));
        failures.push({ sessionId, error: errorMsg });
      }
    }

    if (failures.length > 0) {
      console.error(JSON.stringify({
        event: 'acp_session.heartbeat_timeout_batch_failures',
        failureCount: failures.length,
        totalStale: staleSessions.length,
        failures,
      }));
    }

    // Reschedule alarm if there are still active sessions
    const activeCount = this.sql
      .exec("SELECT COUNT(*) as cnt FROM acp_sessions WHERE status IN ('assigned', 'running')")
      .toArray()[0];
    if ((activeCount?.cnt as number) > 0) {
      await this.scheduleHeartbeatAlarm();
    }
  }

  /**
   * Record an ACP session state transition event.
   */
  private recordAcpSessionEvent(
    acpSessionId: string,
    fromStatus: AcpSessionStatus | null,
    toStatus: AcpSessionStatus,
    actorType: AcpSessionEventActorType,
    actorId: string | null,
    reason: string | null,
    metadata: Record<string, unknown> | null = null
  ): void {
    const id = generateId();
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO acp_session_events (id, acp_session_id, from_status, to_status, actor_type, actor_id, reason, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      acpSessionId,
      fromStatus,
      toStatus,
      actorType,
      actorId,
      reason,
      metadata ? JSON.stringify(metadata) : null,
      now
    );
  }

  /**
   * Get an ACP session or throw if not found.
   */
  private getAcpSessionOrThrow(sessionId: string): AcpSession {
    const row = this.sql
      .exec('SELECT * FROM acp_sessions WHERE id = ?', sessionId)
      .toArray()[0];
    if (!row) {
      throw new Error(`ACP session ${sessionId} not found`);
    }
    return this.mapAcpSessionRow(row);
  }

  /**
   * Map a raw SQLite row to an AcpSession interface.
   */
  private mapAcpSessionRow(row: Record<string, unknown>): AcpSession {
    return {
      id: row.id as string,
      chatSessionId: row.chat_session_id as string,
      workspaceId: (row.workspace_id as string) ?? null,
      nodeId: (row.node_id as string) ?? null,
      acpSdkSessionId: (row.acp_sdk_session_id as string) ?? null,
      parentSessionId: (row.parent_session_id as string) ?? null,
      status: row.status as AcpSessionStatus,
      agentType: (row.agent_type as string) ?? null,
      initialPrompt: (row.initial_prompt as string) ?? null,
      errorMessage: (row.error_message as string) ?? null,
      lastHeartbeatAt: (row.last_heartbeat_at as number) ?? null,
      forkDepth: (row.fork_depth as number) ?? 0,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      assignedAt: (row.assigned_at as number) ?? null,
      startedAt: (row.started_at as number) ?? null,
      completedAt: (row.completed_at as number) ?? null,
      interruptedAt: (row.interrupted_at as number) ?? null,
    };
  }

  /**
   * Schedule a DO alarm for heartbeat detection.
   * Computes alarm time from the EARLIEST last_heartbeat_at among active sessions,
   * so stale sessions are detected promptly even when other sessions heartbeat actively.
   */
  private async scheduleHeartbeatAlarm(): Promise<void> {
    const detectionWindow = parseInt(
      this.env.ACP_SESSION_DETECTION_WINDOW_MS || String(ACP_SESSION_DEFAULTS.DETECTION_WINDOW_MS),
      10
    );

    // Find the earliest heartbeat among active sessions — that one will expire first
    const earliestRow = this.sql
      .exec(
        `SELECT MIN(last_heartbeat_at) as earliest FROM acp_sessions
         WHERE status IN ('assigned', 'running') AND last_heartbeat_at IS NOT NULL`
      )
      .toArray()[0];

    const earliestHeartbeat = earliestRow?.earliest as number | null;
    if (earliestHeartbeat === null) {
      // No active sessions with heartbeats — just recalculate (handles idle cleanup alarm)
      await this.recalculateAlarm();
      return;
    }

    const heartbeatAlarmTime = earliestHeartbeat + detectionWindow;

    // We share the alarm with idle cleanup — pick the earliest time
    const idleRow = this.sql
      .exec('SELECT MIN(cleanup_at) as earliest FROM idle_cleanup_schedule')
      .toArray()[0];
    const idleEarliest = idleRow?.earliest as number | null;

    const earliest = idleEarliest ? Math.min(heartbeatAlarmTime, idleEarliest) : heartbeatAlarmTime;
    await this.ctx.storage.setAlarm(earliest);
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
      // Tag the WebSocket with the subscribed sessionId for server-side filtering.
      // Clients that pass ?sessionId=X only receive events for that session
      // (plus project-wide events). Clients without a sessionId get all events.
      const sessionId = url.searchParams.get('sessionId');
      const tags: string[] = [];
      if (sessionId) {
        // Validate sessionId format — UUIDs are 36 chars of hex + hyphens.
        // Reject malformed values to prevent invalid WebSocket tags.
        if (!/^[0-9a-f-]{36}$/i.test(sessionId)) {
          return new Response('Invalid sessionId format', { status: 400 });
        }
        tags.push(`session:${sessionId}`);
      }
      this.ctx.acceptWebSocket(pair[1], tags);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    return new Response('Not found', { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;

    try {
      const parsed = JSON.parse(message);

      if (parsed.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      if (parsed.type === 'message.send') {
        const { sessionId, content, role } = parsed;
        if (!sessionId || !content || typeof content !== 'string') {
          ws.send(JSON.stringify({ type: 'error', message: 'Missing sessionId or content' }));
          return;
        }
        const sanitizedRole = role === 'user' ? 'user' : 'user'; // Only allow user role from clients
        const trimmed = content.trim();
        if (!trimmed || trimmed.length > 2000) {
          ws.send(JSON.stringify({ type: 'error', message: 'Message must be 1-2000 characters' }));
          return;
        }

        try {
          const messageId = await this.persistMessage(sessionId, sanitizedRole, trimmed, null);
          ws.send(JSON.stringify({ type: 'message.ack', messageId, sessionId }));
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : 'Failed to persist message';
          ws.send(JSON.stringify({ type: 'error', message: errMsg }));
        }
        return;
      }
    } catch {
      // Ignore non-JSON messages
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
    const status = row.status as string;
    const agentCompletedAt = (row.agent_completed_at as number) ?? null;
    const workspaceId = row.workspace_id as string | null;
    const baseDomain = this.env.BASE_DOMAIN;

    return {
      id: row.id,
      workspaceId,
      taskId: row.task_id ?? null,
      topic: row.topic,
      status,
      messageCount: row.message_count,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      createdAt: row.created_at,
      agentCompletedAt,
      lastMessageAt: (row.updated_at as number) ?? null,
      isIdle: status === 'active' && agentCompletedAt != null,
      isTerminated: status === 'stopped',
      workspaceUrl: workspaceId && baseDomain ? `https://ws-${workspaceId}.${baseDomain}` : null,
      cleanupAt: (row.cleanup_at as number) ?? null,
    };
  }

  /**
   * Returns the next monotonic sequence number for a session's messages.
   * Uses MAX(sequence) + 1 so ordering is deterministic even when
   * multiple messages share the same created_at millisecond.
   */
  private nextSequence(sessionId: string): number {
    const row = this.sql
      .exec(
        'SELECT COALESCE(MAX(sequence), 0) AS max_seq FROM chat_messages WHERE session_id = ?',
        sessionId
      )
      .toArray()[0];
    return ((row?.max_seq as number) ?? 0) + 1;
  }

  /**
   * Broadcast an event to connected WebSocket clients.
   * When sessionId is provided, only sends to sockets subscribed to that session
   * (tagged with `session:{id}`) plus untagged sockets (project-wide listeners).
   * When sessionId is omitted, sends to all connected sockets.
   */
  private broadcastEvent(
    type: string,
    payload: Record<string, unknown>,
    sessionId?: string
  ): void {
    const message = JSON.stringify({ type, payload });

    if (sessionId) {
      // Send to session-subscribed sockets
      const sessionSockets = this.ctx.getWebSockets(`session:${sessionId}`);
      const allSockets = this.ctx.getWebSockets();
      const sent = new Set<WebSocket>();
      for (const ws of sessionSockets) {
        try {
          ws.send(message);
          sent.add(ws);
        } catch {
          // Socket may be closed; ignore
        }
      }
      // Send to any untagged sockets (those listening to all events)
      for (const ws of allSockets) {
        if (sent.has(ws)) continue;
        // Check if this socket has a session tag — if so, skip (it's subscribed to a different session)
        const tags = this.ctx.getTags(ws);
        const hasSessionTag = tags.some((t) => t.startsWith('session:'));
        if (hasSessionTag) continue;
        try {
          ws.send(message);
        } catch {
          // Socket may be closed; ignore
        }
      }
    } else {
      // Project-wide event: send to all sockets
      const sockets = this.ctx.getWebSockets();
      for (const ws of sockets) {
        try {
          ws.send(message);
        } catch {
          // Socket may be closed; ignore
        }
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
