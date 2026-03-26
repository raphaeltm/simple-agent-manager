/**
 * Unit tests for the suppression logic added to NotificationService in Phase 2:
 *   - progress batching: second progress for same task within the batch window
 *     updates the existing notification instead of creating a new one
 *   - task_complete deduplication: a second task_complete for the same task
 *     within the dedup window is silently suppressed (returns stub)
 *
 * Because NotificationService is a Durable Object that uses SqlStorage
 * (DurableObjectState.storage.sql), we exercise the logic directly against
 * the real DO class through a minimal mock that mirrors the SqlStorage API.
 * For full end-to-end DO behaviour see tests/workers/ (requires workerd runtime).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// MockSqlStorage — mirrors SqlStorage exec() semantics used by the DO
// ---------------------------------------------------------------------------

type SqlRow = Record<string, unknown>;

class MockSqlStorage {
  private rows: SqlRow[] = [];
  private execLog: string[] = [];

  /**
   * Simulate exec() with minimal SQL parsing sufficient for the suppression
   * queries issued by the DO. Note that the DO embeds the type value as a
   * literal string in the SQL (e.g. "type = 'progress'"), not as a parameter,
   * so we parse it from the query string rather than the params array.
   *
   *   SELECT id FROM notifications WHERE user_id = ? AND type = 'progress'
   *     AND task_id = ? AND created_at > ? AND dismissed_at IS NULL ...
   *     Params: [userId, taskId, cutoff]
   *
   *   SELECT id FROM notifications WHERE user_id = ? AND type = 'task_complete'
   *     AND task_id = ? AND created_at > ?
   *     Params: [userId, taskId, cutoff]
   *
   *   SELECT * FROM notifications WHERE id = ?
   *     Params: [id]
   *
   *   UPDATE notifications SET body = ?, title = ?, read_at = NULL WHERE id = ?
   *     Params: [body, title, id]
   *
   *   INSERT INTO notifications (...) VALUES (?, ...)
   *     Params: [id, userId, projectId, taskId, sessionId, type, urgency,
   *              title, body, actionUrl, metadata, createdAt]
   */
  exec(query: string, ...params: unknown[]): { toArray: () => SqlRow[] } {
    this.execLog.push(query.trim());
    const q = query.trim().toUpperCase();

    // INSERT
    if (q.startsWith('INSERT INTO NOTIFICATIONS')) {
      const row: SqlRow = {
        id: params[0] as string,
        user_id: params[1] as string,
        project_id: params[2] as string | null,
        task_id: params[3] as string | null,
        session_id: params[4] as string | null,
        type: params[5] as string,
        urgency: params[6] as string,
        title: params[7] as string,
        body: params[8] as string | null,
        action_url: params[9] as string | null,
        metadata: params[10] as string | null,
        created_at: params[11] as number,
        read_at: null,
        dismissed_at: null,
      };
      this.rows.push(row);
      return { toArray: () => [] };
    }

    // SELECT id FROM notifications WHERE user_id = ? AND type = '<literal>' AND task_id = ? AND created_at > ? [AND dismissed_at IS NULL]
    // Params: [userId, taskId, cutoff]
    if (q.startsWith('SELECT ID FROM NOTIFICATIONS WHERE')) {
      const typeMatch = query.match(/type\s*=\s*'([^']+)'/i);
      const embeddedType = typeMatch ? typeMatch[1] : null;
      const [userIdParam, taskIdParam, cutoffParam] = params as [string, string, number];
      const requireNotDismissed = q.includes('DISMISSED_AT IS NULL');

      const matched = this.rows.filter((r) => {
        const typeOk = embeddedType ? r.type === embeddedType : true;
        const taskOk = taskIdParam ? r.task_id === taskIdParam : true;
        const cutoffOk = (r.created_at as number) > (cutoffParam as number);
        const dismissedOk = requireNotDismissed ? r.dismissed_at === null : true;
        return r.user_id === userIdParam && typeOk && taskOk && cutoffOk && dismissedOk;
      });
      return { toArray: () => matched.map((r) => ({ id: r.id })) };
    }

    // SELECT * FROM notifications WHERE id = ?
    if (q.startsWith('SELECT * FROM NOTIFICATIONS WHERE ID')) {
      const matched = this.rows.filter((r) => r.id === params[0]);
      return { toArray: () => matched };
    }

    // UPDATE notifications SET body = ?, title = ?, metadata = ?, read_at = NULL WHERE id = ?
    // Also handles: UPDATE notifications SET body = ?, title = ?, read_at = NULL WHERE id = ?
    if (q.startsWith('UPDATE NOTIFICATIONS SET')) {
      const hasMetadata = q.includes('METADATA');
      if (hasMetadata) {
        const [bodyParam, titleParam, metadataParam, idParam] = params as [string, string, string | null, string];
        for (const r of this.rows) {
          if (r.id === idParam) {
            r.body = bodyParam;
            r.title = titleParam;
            r.metadata = metadataParam;
            r.read_at = null;
          }
        }
      } else {
        const [bodyParam, titleParam, idParam] = params as [string, string, string];
        for (const r of this.rows) {
          if (r.id === idParam) {
            r.body = bodyParam;
            r.title = titleParam;
            r.read_at = null;
          }
        }
      }
      return { toArray: () => [] };
    }

    // DELETE / SELECT COUNT / other: no-op
    return { toArray: () => [] };
  }

  getExecLog(): string[] {
    return this.execLog;
  }

  getAllRows(): SqlRow[] {
    return this.rows;
  }
}

// ---------------------------------------------------------------------------
// Minimal DO harness — enough to instantiate NotificationService in unit tests
// ---------------------------------------------------------------------------

function createFakeDOState(sql: MockSqlStorage, _env: Record<string, string> = {}) {
  return {
    storage: { sql },
    blockConcurrencyWhile: (fn: () => Promise<void>) => fn(),
    id: { toString: () => 'fake-do-id' },
    waitUntil: vi.fn(),
    acceptWebSocket: vi.fn(),
    getWebSockets: vi.fn().mockReturnValue([]),
  };
}

// We import the class under test. The DO module imports from 'cloudflare:workers',
// so we need to mock that module first.
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      protected ctx: ReturnType<typeof createFakeDOState>,
      protected env: Record<string, string>,
    ) {}
  },
  WebSocketPair: vi.fn(),
}));

// Also mock the migrations runner so the constructor side-effect is a no-op
vi.mock('../../../src/durable-objects/notification-migrations', () => ({
  runNotificationMigrations: vi.fn(),
}));

// Import AFTER mocks are set up
const { NotificationService } = await import('../../../src/durable-objects/notification');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNotificationService(sql: MockSqlStorage, env: Record<string, string> = {}) {
  const state = createFakeDOState(sql, env);
  return new NotificationService(state as any, env);
}

const BASE_REQUEST = {
  type: 'progress' as const,
  urgency: 'low' as const,
  title: 'Progress: Implement feature',
  body: 'Step 1 done',
  projectId: 'proj-1',
  taskId: 'task-1',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NotificationService suppression logic', () => {
  let sql: MockSqlStorage;
  let service: InstanceType<typeof NotificationService>;

  beforeEach(() => {
    sql = new MockSqlStorage();
    service = makeNotificationService(sql);
  });

  // ── progress batching ───────────────────────────────────────────────────

  describe('progress batching', () => {
    it('creates a new progress notification when none exists for the task', async () => {
      await service.createNotification('user-1', BASE_REQUEST);

      const rows = sql.getAllRows().filter((r) => r.type === 'progress');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.body).toBe('Step 1 done');
    });

    it('updates (not creates) when a recent undismissed progress notification exists for the same task', async () => {
      // Seed an existing progress notification inside the batch window
      sql.exec(
        `INSERT INTO notifications (id, user_id, project_id, task_id, session_id, type, urgency, title, body, action_url, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        'existing-id',
        'user-1',
        'proj-1',
        'task-1',
        null,
        'progress',
        'low',
        'Progress: Old',
        'Old body',
        null,
        null,
        Date.now() - 10_000, // 10 seconds ago — within 5-min default window
      );

      const result = await service.createNotification('user-1', {
        ...BASE_REQUEST,
        title: 'Progress: Updated',
        body: 'Step 2 done',
      });

      // The existing row should be updated, not a new one created
      const allRows = sql.getAllRows().filter((r) => r.type === 'progress');
      expect(allRows).toHaveLength(1);
      expect(allRows[0]!.id).toBe('existing-id');
      expect(allRows[0]!.body).toBe('Step 2 done');
      expect(allRows[0]!.title).toBe('Progress: Updated');

      // The returned object must correspond to the updated notification
      expect(result.id).toBe('existing-id');
    });

    it('creates a new notification when an existing one is beyond the batch window', async () => {
      const batchWindowMs = 5 * 60 * 1000;
      // Seed a progress notification OUTSIDE the batch window
      sql.exec(
        `INSERT INTO notifications (id, user_id, project_id, task_id, session_id, type, urgency, title, body, action_url, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        'old-id',
        'user-1',
        'proj-1',
        'task-1',
        null,
        'progress',
        'low',
        'Progress: Old',
        'Old body',
        null,
        null,
        Date.now() - batchWindowMs - 1000, // beyond default window
      );

      await service.createNotification('user-1', BASE_REQUEST);

      const allRows = sql.getAllRows().filter((r) => r.type === 'progress');
      expect(allRows).toHaveLength(2);
    });

    it('creates a new notification when the existing one is dismissed (user dismissed = fresh entry)', async () => {
      // Seed a dismissed progress notification inside the window
      const seededRow: Record<string, unknown> = {
        id: 'dismissed-id',
        user_id: 'user-1',
        project_id: 'proj-1',
        task_id: 'task-1',
        session_id: null,
        type: 'progress',
        urgency: 'low',
        title: 'Progress: Old',
        body: 'Step 1 done',
        action_url: null,
        metadata: null,
        created_at: Date.now() - 10_000,
        read_at: null,
        dismissed_at: Date.now() - 5_000, // dismissed
      };
      (sql as any).rows.push(seededRow);

      await service.createNotification('user-1', BASE_REQUEST);

      const allRows = (sql as any).rows.filter((r: SqlRow) => r.type === 'progress');
      // Dismissed row was excluded by dismissed_at IS NULL filter; new one created
      expect(allRows).toHaveLength(2);
    });

    it('uses NOTIFICATION_PROGRESS_BATCH_WINDOW_MS env override when set', async () => {
      // Use a very short window (100 ms)
      const shortWindowService = makeNotificationService(sql, { NOTIFICATION_PROGRESS_BATCH_WINDOW_MS: '100' });

      // Seed a progress notification 200 ms old — outside the 100 ms window
      sql.exec(
        `INSERT INTO notifications (id, user_id, project_id, task_id, session_id, type, urgency, title, body, action_url, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        'stale-id',
        'user-1',
        'proj-1',
        'task-1',
        null,
        'progress',
        'low',
        'Progress: Stale',
        null,
        null,
        null,
        Date.now() - 200,
      );

      await shortWindowService.createNotification('user-1', BASE_REQUEST);

      // Both rows should exist — the stale one is outside the 100 ms window
      const allRows = sql.getAllRows().filter((r) => r.type === 'progress');
      expect(allRows).toHaveLength(2);
    });
  });

  // ── task_complete deduplication ─────────────────────────────────────────

  describe('task_complete deduplication', () => {
    const COMPLETE_REQUEST = {
      type: 'task_complete' as const,
      urgency: 'medium' as const,
      title: 'Task completed: Fix the bug',
      projectId: 'proj-1',
      taskId: 'task-1',
    };

    it('creates a task_complete notification when none exists', async () => {
      await service.createNotification('user-1', COMPLETE_REQUEST);

      const rows = sql.getAllRows().filter((r) => r.type === 'task_complete');
      expect(rows).toHaveLength(1);
    });

    it('suppresses a duplicate task_complete within the dedup window', async () => {
      // Seed a task_complete notification inside the dedup window
      sql.exec(
        `INSERT INTO notifications (id, user_id, project_id, task_id, session_id, type, urgency, title, body, action_url, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        'first-complete-id',
        'user-1',
        'proj-1',
        'task-1',
        null,
        'task_complete',
        'medium',
        'Task completed: Fix the bug',
        null,
        null,
        null,
        Date.now() - 5_000, // 5 seconds ago — inside 60-second default window
      );

      const result = await service.createNotification('user-1', COMPLETE_REQUEST);

      // Still only one row
      const rows = sql.getAllRows().filter((r) => r.type === 'task_complete');
      expect(rows).toHaveLength(1);

      // Returned stub must not have a real id
      expect(result.id).toBe('suppressed');
    });

    it('allows a new task_complete after the dedup window expires', async () => {
      const dedupWindowMs = 60_000;
      sql.exec(
        `INSERT INTO notifications (id, user_id, project_id, task_id, session_id, type, urgency, title, body, action_url, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        'old-complete-id',
        'user-1',
        'proj-1',
        'task-1',
        null,
        'task_complete',
        'medium',
        'Task completed: Fix the bug',
        null,
        null,
        null,
        Date.now() - dedupWindowMs - 1000, // beyond the 60-second window
      );

      await service.createNotification('user-1', COMPLETE_REQUEST);

      const rows = sql.getAllRows().filter((r) => r.type === 'task_complete');
      expect(rows).toHaveLength(2);
    });

    it('uses NOTIFICATION_DEDUP_WINDOW_MS env override when set', async () => {
      const shortDedupService = makeNotificationService(sql, { NOTIFICATION_DEDUP_WINDOW_MS: '100' });

      // Seed a task_complete 200 ms old — outside the 100 ms window
      sql.exec(
        `INSERT INTO notifications (id, user_id, project_id, task_id, session_id, type, urgency, title, body, action_url, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        'stale-complete-id',
        'user-1',
        'proj-1',
        'task-1',
        null,
        'task_complete',
        'medium',
        'Task completed: Fix the bug',
        null,
        null,
        null,
        Date.now() - 200,
      );

      await shortDedupService.createNotification('user-1', COMPLETE_REQUEST);

      const rows = sql.getAllRows().filter((r) => r.type === 'task_complete');
      // Stale entry is outside the 100 ms window — new one is created
      expect(rows).toHaveLength(2);
    });

    it('dedup is scoped to task_id — same user, different task_id creates new notification', async () => {
      sql.exec(
        `INSERT INTO notifications (id, user_id, project_id, task_id, session_id, type, urgency, title, body, action_url, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        'task1-complete',
        'user-1',
        'proj-1',
        'task-1',
        null,
        'task_complete',
        'medium',
        'Task completed: Fix the bug',
        null,
        null,
        null,
        Date.now() - 5_000,
      );

      // Different task_id — should NOT be suppressed
      await service.createNotification('user-1', { ...COMPLETE_REQUEST, taskId: 'task-2' });

      const rows = sql.getAllRows().filter((r) => r.type === 'task_complete');
      expect(rows).toHaveLength(2);
    });

    it('stubResponse preserves all request fields in returned object', async () => {
      // Seed existing task_complete to trigger suppression path
      sql.exec(
        `INSERT INTO notifications (id, user_id, project_id, task_id, session_id, type, urgency, title, body, action_url, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        'first-id',
        'user-1',
        'proj-1',
        'task-1',
        null,
        'task_complete',
        'medium',
        'Task completed: Fix the bug',
        null,
        '/projects/proj-1',
        null,
        Date.now() - 5_000,
      );

      const result = await service.createNotification('user-1', {
        ...COMPLETE_REQUEST,
        body: 'Work is done',
        actionUrl: '/projects/proj-1',
        sessionId: 'session-42',
      });

      expect(result.id).toBe('suppressed');
      expect(result.type).toBe('task_complete');
      expect(result.urgency).toBe('medium');
      expect(result.taskId).toBe('task-1');
      expect(result.projectId).toBe('proj-1');
      expect(result.body).toBe('Work is done');
      expect(result.actionUrl).toBe('/projects/proj-1');
      expect(result.sessionId).toBe('session-42');
      expect(result.readAt).toBeNull();
      expect(result.dismissedAt).toBeNull();
      expect(result.createdAt).toBeTruthy(); // ISO string
    });
  });
});
