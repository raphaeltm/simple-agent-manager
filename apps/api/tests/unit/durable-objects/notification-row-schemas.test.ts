/**
 * Unit tests for Notification DO Valibot row mappers.
 */
import { describe, it, expect } from 'vitest';
import {
  parseNotificationRow,
  parseNotificationPreferenceRow,
  parseIdRow,
} from '../../../src/durable-objects/notification-row-schemas';

describe('parseNotificationRow', () => {
  const validRow = {
    id: 'notif-1',
    user_id: 'u1',
    project_id: 'p1',
    task_id: 't1',
    session_id: 's1',
    type: 'task_complete',
    urgency: 'high',
    title: 'Task Done',
    body: 'Your task completed successfully',
    action_url: '/projects/p1/tasks/t1',
    metadata: '{"duration":120}',
    read_at: 1711900000000,
    dismissed_at: null,
    created_at: 1711800000000,
  };

  it('parses valid notification row to NotificationResponse', () => {
    const result = parseNotificationRow(validRow);
    expect(result.id).toBe('notif-1');
    expect(result.projectId).toBe('p1');
    expect(result.taskId).toBe('t1');
    expect(result.sessionId).toBe('s1');
    expect(result.type).toBe('task_complete');
    expect(result.urgency).toBe('high');
    expect(result.title).toBe('Task Done');
    expect(result.body).toBe('Your task completed successfully');
    expect(result.actionUrl).toBe('/projects/p1/tasks/t1');
    expect(result.metadata).toEqual({ duration: 120 });
  });

  it('converts timestamps to ISO strings', () => {
    const result = parseNotificationRow(validRow);
    expect(result.createdAt).toBe(new Date(1711800000000).toISOString());
    expect(result.readAt).toBe(new Date(1711900000000).toISOString());
  });

  it('handles null metadata', () => {
    const result = parseNotificationRow({ ...validRow, metadata: null });
    expect(result.metadata).toBeNull();
  });

  it('handles null timestamps', () => {
    const result = parseNotificationRow({ ...validRow, read_at: null, dismissed_at: null });
    expect(result.readAt).toBeNull();
    expect(result.dismissedAt).toBeNull();
  });

  it('handles all nullable fields as null', () => {
    const nullRow = {
      ...validRow,
      project_id: null,
      task_id: null,
      session_id: null,
      body: null,
      action_url: null,
      metadata: null,
      read_at: null,
      dismissed_at: null,
    };
    const result = parseNotificationRow(nullRow);
    expect(result.projectId).toBeNull();
    expect(result.taskId).toBeNull();
    expect(result.sessionId).toBeNull();
    expect(result.body).toBeNull();
    expect(result.actionUrl).toBeNull();
  });

  it('rejects invalid notification type', () => {
    expect(() => parseNotificationRow({ ...validRow, type: 'invalid_type' })).toThrow(
      /Row validation failed/
    );
  });

  it('rejects invalid urgency', () => {
    expect(() => parseNotificationRow({ ...validRow, urgency: 'critical' })).toThrow(
      /Row validation failed/
    );
  });

  it('rejects missing required fields', () => {
    expect(() => parseNotificationRow({ id: 'x' })).toThrow(/Row validation failed/);
  });
});

describe('parseNotificationPreferenceRow', () => {
  it('maps preference row with enabled=1', () => {
    const result = parseNotificationPreferenceRow({
      notification_type: 'task_complete',
      project_id: 'p1',
      channel: 'in_app',
      enabled: 1,
    });
    expect(result).toEqual({
      notificationType: 'task_complete',
      projectId: 'p1',
      channel: 'in_app',
      enabled: true,
    });
  });

  it('maps preference row with enabled=0', () => {
    const result = parseNotificationPreferenceRow({
      notification_type: 'progress',
      project_id: null,
      channel: 'in_app',
      enabled: 0,
    });
    expect(result.enabled).toBe(false);
    expect(result.projectId).toBeNull();
  });

  it('treats empty string project_id as null', () => {
    const result = parseNotificationPreferenceRow({
      notification_type: '*',
      project_id: '',
      channel: 'in_app',
      enabled: 1,
    });
    expect(result.projectId).toBeNull();
  });
});

describe('parseIdRow', () => {
  it('extracts id string', () => {
    expect(parseIdRow({ id: 'notif-123' }, 'test')).toBe('notif-123');
  });

  it('rejects non-string id', () => {
    expect(() => parseIdRow({ id: 123 }, 'test')).toThrow(/Row validation failed/);
  });

  it('rejects missing id', () => {
    expect(() => parseIdRow({}, 'test')).toThrow(/Row validation failed/);
  });
});
