/**
 * Tests for the session inbox module — per-session message queue for parent agent notifications.
 *
 * Covers: enqueue, getPending, markDelivered, getStats, overflow handling.
 */
import { describe, expect, it } from 'vitest';

import * as inbox from '../../../src/durable-objects/project-data/inbox';

// ─── Mock SqlStorage ──────────────────────────────────────────────────────

interface StoredRow {
  id: string;
  target_session_id: string;
  source_task_id: string | null;
  message_type: string;
  content: string;
  priority: string;
  created_at: number;
  delivered_at: number | null;
}

class MockSqlStorage {
  private rows: StoredRow[] = [];

  exec(query: string, ...params: unknown[]): { toArray: () => Record<string, unknown>[]; rowsWritten: number } {
    const normalized = query.trim().toUpperCase();
    let rowsWritten = 0;

    // COUNT/SUM/MIN for getInboxStats (extended stats query)
    if (normalized.includes('COUNT(*)') && normalized.includes('SESSION_INBOX') && normalized.includes('DELIVERED_AT IS NULL')) {
      const targetId = params[0] as string;
      const pending = this.rows.filter(
        (r) => r.target_session_id === targetId && r.delivered_at === null,
      );
      const count = pending.length;
      const urgentCnt = pending.filter((r) => r.priority === 'urgent').length;
      const oldestCreatedAt = pending.length > 0
        ? Math.min(...pending.map((r) => r.created_at))
        : null;
      return { toArray: () => [{ cnt: count, urgent_cnt: urgentCnt, oldest_created_at: oldestCreatedAt }], rowsWritten: 0 };
    }

    // DELETE overflow
    if (normalized.startsWith('DELETE FROM SESSION_INBOX')) {
      const targetId = params[0] as string;
      const limit = params[1] as number;
      const pending = this.rows
        .filter((r) => r.target_session_id === targetId && r.delivered_at === null)
        .sort((a, b) => a.created_at - b.created_at);
      const toDelete = pending.slice(0, limit);
      const deleteIds = new Set(toDelete.map((r) => r.id));
      this.rows = this.rows.filter((r) => !deleteIds.has(r.id));
      rowsWritten = toDelete.length;
      return { toArray: () => [], rowsWritten };
    }

    // INSERT
    if (normalized.startsWith('INSERT INTO SESSION_INBOX')) {
      this.rows.push({
        id: params[0] as string,
        target_session_id: params[1] as string,
        source_task_id: params[2] as string | null,
        message_type: params[3] as string,
        content: params[4] as string,
        priority: params[5] as string,
        created_at: params[6] as number,
        delivered_at: null,
      });
      rowsWritten = 1;
      return { toArray: () => [], rowsWritten };
    }

    // SELECT pending messages
    if (normalized.includes('SELECT') && normalized.includes('SESSION_INBOX') && normalized.includes('DELIVERED_AT IS NULL') && normalized.includes('LIMIT')) {
      const targetId = params[0] as string;
      const limit = params[1] as number;
      const pending = this.rows
        .filter((r) => r.target_session_id === targetId && r.delivered_at === null)
        .sort((a, b) => a.created_at - b.created_at)
        .slice(0, limit);
      return { toArray: () => pending as unknown as Record<string, unknown>[], rowsWritten: 0 };
    }

    // UPDATE delivered_at
    if (normalized.startsWith('UPDATE SESSION_INBOX')) {
      const now = params[0] as number;
      const id = params[1] as string;
      const row = this.rows.find((r) => r.id === id && r.delivered_at === null);
      if (row) {
        row.delivered_at = now;
        rowsWritten = 1;
      }
      return { toArray: () => [], rowsWritten };
    }

    return { toArray: () => [], rowsWritten: 0 };
  }

  getRows(): StoredRow[] {
    return this.rows;
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('session inbox', () => {
  const DEFAULT_MAX_SIZE = 100;
  const DEFAULT_MAX_CONTENT_LENGTH = 8192;

  function createMockSql(): MockSqlStorage {
    return new MockSqlStorage();
  }

  describe('enqueueInboxMessage', () => {
    it('should enqueue a message and return an id', () => {
      const sql = createMockSql();
      const id = inbox.enqueueInboxMessage(
        sql as unknown as SqlStorage,
        {
          targetSessionId: 'session-1',
          sourceTaskId: 'task-1',
          messageType: 'child_completed',
          content: 'Task completed successfully',
          priority: 'normal',
        },
        DEFAULT_MAX_SIZE,
        DEFAULT_MAX_CONTENT_LENGTH,
      );

      expect(id).toBeTruthy();
      expect(typeof id).toBe('string');
      const rows = sql.getRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.target_session_id).toBe('session-1');
      expect(rows[0]?.source_task_id).toBe('task-1');
      expect(rows[0]?.message_type).toBe('child_completed');
      expect(rows[0]?.content).toBe('Task completed successfully');
      expect(rows[0]?.priority).toBe('normal');
      expect(rows[0]?.delivered_at).toBeNull();
    });

    it('should truncate content exceeding max length', () => {
      const sql = createMockSql();
      const longContent = 'x'.repeat(10000);
      inbox.enqueueInboxMessage(
        sql as unknown as SqlStorage,
        {
          targetSessionId: 'session-1',
          sourceTaskId: null,
          messageType: 'child_failed',
          content: longContent,
          priority: 'normal',
        },
        DEFAULT_MAX_SIZE,
        100, // very short max
      );

      const rows = sql.getRows();
      expect(rows[0]?.content).toHaveLength(100);
    });

    it('should drop oldest messages when inbox exceeds max size', () => {
      const sql = createMockSql();
      // Fill the inbox to capacity
      for (let i = 0; i < 3; i++) {
        inbox.enqueueInboxMessage(
          sql as unknown as SqlStorage,
          {
            targetSessionId: 'session-1',
            sourceTaskId: `task-${i}`,
            messageType: 'child_completed',
            content: `Message ${i}`,
            priority: 'normal',
          },
          3, // max size of 3
          DEFAULT_MAX_CONTENT_LENGTH,
        );
      }

      expect(sql.getRows()).toHaveLength(3);

      // Add one more — should trigger overflow
      inbox.enqueueInboxMessage(
        sql as unknown as SqlStorage,
        {
          targetSessionId: 'session-1',
          sourceTaskId: 'task-overflow',
          messageType: 'child_completed',
          content: 'Overflow message',
          priority: 'normal',
        },
        3,
        DEFAULT_MAX_CONTENT_LENGTH,
      );

      const rows = sql.getRows();
      expect(rows).toHaveLength(3);
      // The oldest message (task-0) should have been dropped
      expect(rows.find((r) => r.source_task_id === 'task-0')).toBeUndefined();
      expect(rows.find((r) => r.source_task_id === 'task-overflow')).toBeTruthy();
    });

    it('should support urgent priority', () => {
      const sql = createMockSql();
      inbox.enqueueInboxMessage(
        sql as unknown as SqlStorage,
        {
          targetSessionId: 'session-1',
          sourceTaskId: 'task-1',
          messageType: 'child_needs_input',
          content: 'Need help',
          priority: 'urgent',
        },
        DEFAULT_MAX_SIZE,
        DEFAULT_MAX_CONTENT_LENGTH,
      );

      expect(sql.getRows()[0]?.priority).toBe('urgent');
    });
  });

  describe('getPendingInboxMessages', () => {
    it('should return only undelivered messages ordered by creation time', () => {
      const sql = createMockSql();
      inbox.enqueueInboxMessage(
        sql as unknown as SqlStorage,
        { targetSessionId: 'session-1', sourceTaskId: 'task-1', messageType: 'child_completed', content: 'First', priority: 'normal' },
        DEFAULT_MAX_SIZE, DEFAULT_MAX_CONTENT_LENGTH,
      );
      inbox.enqueueInboxMessage(
        sql as unknown as SqlStorage,
        { targetSessionId: 'session-1', sourceTaskId: 'task-2', messageType: 'child_failed', content: 'Second', priority: 'normal' },
        DEFAULT_MAX_SIZE, DEFAULT_MAX_CONTENT_LENGTH,
      );

      const messages = inbox.getPendingInboxMessages(sql as unknown as SqlStorage, 'session-1', 10);
      expect(messages).toHaveLength(2);
      expect(messages[0]?.content).toBe('First');
      expect(messages[1]?.content).toBe('Second');
    });

    it('should return empty array for session with no messages', () => {
      const sql = createMockSql();
      const messages = inbox.getPendingInboxMessages(sql as unknown as SqlStorage, 'nonexistent', 10);
      expect(messages).toHaveLength(0);
    });

    it('should respect the limit parameter', () => {
      const sql = createMockSql();
      for (let i = 0; i < 5; i++) {
        inbox.enqueueInboxMessage(
          sql as unknown as SqlStorage,
          { targetSessionId: 'session-1', sourceTaskId: `task-${i}`, messageType: 'child_completed', content: `Msg ${i}`, priority: 'normal' },
          DEFAULT_MAX_SIZE, DEFAULT_MAX_CONTENT_LENGTH,
        );
      }

      const messages = inbox.getPendingInboxMessages(sql as unknown as SqlStorage, 'session-1', 2);
      expect(messages).toHaveLength(2);
    });

    it('should not return delivered messages', () => {
      const sql = createMockSql();
      inbox.enqueueInboxMessage(
        sql as unknown as SqlStorage,
        { targetSessionId: 'session-1', sourceTaskId: 'task-1', messageType: 'child_completed', content: 'Delivered', priority: 'normal' },
        DEFAULT_MAX_SIZE, DEFAULT_MAX_CONTENT_LENGTH,
      );
      const pending = inbox.getPendingInboxMessages(sql as unknown as SqlStorage, 'session-1', 10);
      inbox.markInboxDelivered(sql as unknown as SqlStorage, [pending[0]!.id]);

      const afterDelivery = inbox.getPendingInboxMessages(sql as unknown as SqlStorage, 'session-1', 10);
      expect(afterDelivery).toHaveLength(0);
    });
  });

  describe('markInboxDelivered', () => {
    it('should mark messages as delivered', () => {
      const sql = createMockSql();
      const id1 = inbox.enqueueInboxMessage(
        sql as unknown as SqlStorage,
        { targetSessionId: 'session-1', sourceTaskId: 'task-1', messageType: 'child_completed', content: 'Done', priority: 'normal' },
        DEFAULT_MAX_SIZE, DEFAULT_MAX_CONTENT_LENGTH,
      );
      const id2 = inbox.enqueueInboxMessage(
        sql as unknown as SqlStorage,
        { targetSessionId: 'session-1', sourceTaskId: 'task-2', messageType: 'child_failed', content: 'Failed', priority: 'normal' },
        DEFAULT_MAX_SIZE, DEFAULT_MAX_CONTENT_LENGTH,
      );

      const updated = inbox.markInboxDelivered(sql as unknown as SqlStorage, [id1, id2]);
      expect(updated).toBe(2);

      const rows = sql.getRows();
      expect(rows[0]?.delivered_at).not.toBeNull();
      expect(rows[1]?.delivered_at).not.toBeNull();
    });

    it('should return 0 for empty array', () => {
      const sql = createMockSql();
      const updated = inbox.markInboxDelivered(sql as unknown as SqlStorage, []);
      expect(updated).toBe(0);
    });

    it('should not double-deliver', () => {
      const sql = createMockSql();
      const id = inbox.enqueueInboxMessage(
        sql as unknown as SqlStorage,
        { targetSessionId: 'session-1', sourceTaskId: 'task-1', messageType: 'child_completed', content: 'Done', priority: 'normal' },
        DEFAULT_MAX_SIZE, DEFAULT_MAX_CONTENT_LENGTH,
      );

      inbox.markInboxDelivered(sql as unknown as SqlStorage, [id]);
      const secondUpdate = inbox.markInboxDelivered(sql as unknown as SqlStorage, [id]);
      expect(secondUpdate).toBe(0);
    });
  });

  describe('getInboxStats', () => {
    it('should return count of pending messages', () => {
      const sql = createMockSql();
      inbox.enqueueInboxMessage(
        sql as unknown as SqlStorage,
        { targetSessionId: 'session-1', sourceTaskId: 'task-1', messageType: 'child_completed', content: 'A', priority: 'normal' },
        DEFAULT_MAX_SIZE, DEFAULT_MAX_CONTENT_LENGTH,
      );
      inbox.enqueueInboxMessage(
        sql as unknown as SqlStorage,
        { targetSessionId: 'session-1', sourceTaskId: 'task-2', messageType: 'child_completed', content: 'B', priority: 'normal' },
        DEFAULT_MAX_SIZE, DEFAULT_MAX_CONTENT_LENGTH,
      );

      const stats = inbox.getInboxStats(sql as unknown as SqlStorage, 'session-1');
      expect(stats.pending).toBe(2);
      expect(stats.urgentCount).toBe(0);
      expect(stats.oldestMessageAge).toBeGreaterThanOrEqual(0);
    });

    it('should return 0 for empty inbox', () => {
      const sql = createMockSql();
      const stats = inbox.getInboxStats(sql as unknown as SqlStorage, 'nonexistent');
      expect(stats.pending).toBe(0);
      expect(stats.urgentCount).toBe(0);
      expect(stats.oldestMessageAge).toBe(0);
    });

    it('should not count delivered messages', () => {
      const sql = createMockSql();
      const id = inbox.enqueueInboxMessage(
        sql as unknown as SqlStorage,
        { targetSessionId: 'session-1', sourceTaskId: 'task-1', messageType: 'child_completed', content: 'A', priority: 'normal' },
        DEFAULT_MAX_SIZE, DEFAULT_MAX_CONTENT_LENGTH,
      );
      inbox.markInboxDelivered(sql as unknown as SqlStorage, [id]);

      const stats = inbox.getInboxStats(sql as unknown as SqlStorage, 'session-1');
      expect(stats.pending).toBe(0);
      expect(stats.urgentCount).toBe(0);
      expect(stats.oldestMessageAge).toBe(0);
    });

    it('should count urgent messages separately', () => {
      const sql = createMockSql();
      inbox.enqueueInboxMessage(
        sql as unknown as SqlStorage,
        { targetSessionId: 'session-1', sourceTaskId: 'task-1', messageType: 'child_completed', content: 'A', priority: 'normal' },
        DEFAULT_MAX_SIZE, DEFAULT_MAX_CONTENT_LENGTH,
      );
      inbox.enqueueInboxMessage(
        sql as unknown as SqlStorage,
        { targetSessionId: 'session-1', sourceTaskId: 'task-2', messageType: 'child_needs_input', content: 'B', priority: 'urgent' },
        DEFAULT_MAX_SIZE, DEFAULT_MAX_CONTENT_LENGTH,
      );
      inbox.enqueueInboxMessage(
        sql as unknown as SqlStorage,
        { targetSessionId: 'session-1', sourceTaskId: 'task-3', messageType: 'child_needs_input', content: 'C', priority: 'urgent' },
        DEFAULT_MAX_SIZE, DEFAULT_MAX_CONTENT_LENGTH,
      );

      const stats = inbox.getInboxStats(sql as unknown as SqlStorage, 'session-1');
      expect(stats.pending).toBe(3);
      expect(stats.urgentCount).toBe(2);
      expect(stats.oldestMessageAge).toBeGreaterThanOrEqual(0);
    });
  });

  describe('isolation between sessions', () => {
    it('should not return messages for different sessions', () => {
      const sql = createMockSql();
      inbox.enqueueInboxMessage(
        sql as unknown as SqlStorage,
        { targetSessionId: 'session-1', sourceTaskId: 'task-1', messageType: 'child_completed', content: 'For S1', priority: 'normal' },
        DEFAULT_MAX_SIZE, DEFAULT_MAX_CONTENT_LENGTH,
      );
      inbox.enqueueInboxMessage(
        sql as unknown as SqlStorage,
        { targetSessionId: 'session-2', sourceTaskId: 'task-2', messageType: 'child_completed', content: 'For S2', priority: 'normal' },
        DEFAULT_MAX_SIZE, DEFAULT_MAX_CONTENT_LENGTH,
      );

      const s1 = inbox.getPendingInboxMessages(sql as unknown as SqlStorage, 'session-1', 10);
      expect(s1).toHaveLength(1);
      expect(s1[0]?.content).toBe('For S1');

      const s2 = inbox.getPendingInboxMessages(sql as unknown as SqlStorage, 'session-2', 10);
      expect(s2).toHaveLength(1);
      expect(s2[0]?.content).toBe('For S2');
    });
  });
});
