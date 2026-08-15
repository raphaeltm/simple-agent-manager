import { describe, expect, it, vi } from 'vitest';

import {
  parseIdRow,
  parseNotificationPreferenceRow,
  parseNotificationRow,
  parsePushSubscriptionRow,
  parsePushSubscriptionRows,
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
    push_delivered_at: null,
    in_app_visible: 1,
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

  it('handles null metadata and timestamps', () => {
    const result = parseNotificationRow({
      ...validRow,
      metadata: null,
      read_at: null,
      dismissed_at: null,
    });
    expect(result.metadata).toBeNull();
    expect(result.readAt).toBeNull();
    expect(result.dismissedAt).toBeNull();
  });

  it('handles all nullable fields as null', () => {
    const result = parseNotificationRow({
      ...validRow,
      project_id: null,
      task_id: null,
      session_id: null,
      body: null,
      action_url: null,
      metadata: null,
      read_at: null,
      dismissed_at: null,
    });
    expect(result.projectId).toBeNull();
    expect(result.taskId).toBeNull();
    expect(result.sessionId).toBeNull();
    expect(result.body).toBeNull();
    expect(result.actionUrl).toBeNull();
  });

  it('rejects invalid notification type, urgency, and missing fields', () => {
    expect(() => parseNotificationRow({ ...validRow, type: 'invalid_type' })).toThrow(
      /Row validation failed/
    );
    expect(() => parseNotificationRow({ ...validRow, urgency: 'critical' })).toThrow(
      /Row validation failed/
    );
    expect(() => parseNotificationRow({ id: 'x' })).toThrow(/Row validation failed/);
  });

  it('normalizes empty project IDs and parses dismissal', () => {
    expect(parseNotificationRow({ ...validRow, project_id: '' }).projectId).toBeNull();
    expect(parseNotificationRow({ ...validRow, dismissed_at: 1711900000000 }).dismissedAt).toBe(
      new Date(1711900000000).toISOString()
    );
  });

  it('throws on invalid JSON in metadata', () => {
    expect(() => parseNotificationRow({ ...validRow, metadata: 'not-json' })).toThrow();
  });
});

describe('parseNotificationPreferenceRow', () => {
  it('maps enabled project and disabled global preferences', () => {
    expect(
      parseNotificationPreferenceRow({
        notification_type: 'task_complete',
        project_id: 'p1',
        channel: 'in_app',
        enabled: 1,
      })
    ).toEqual({
      notificationType: 'task_complete',
      projectId: 'p1',
      channel: 'in_app',
      enabled: true,
    });
    expect(
      parseNotificationPreferenceRow({
        notification_type: '*',
        project_id: '',
        channel: 'web_push',
        enabled: 0,
      })
    ).toMatchObject({ projectId: null, channel: 'web_push', enabled: false });
  });
});

describe('parseIdRow', () => {
  it('extracts an id and rejects malformed rows', () => {
    expect(parseIdRow({ id: 'notif-123' }, 'test')).toBe('notif-123');
    expect(() => parseIdRow({ id: 123 }, 'test')).toThrow(/Row validation failed/);
    expect(() => parseIdRow({}, 'test')).toThrow(/Row validation failed/);
  });
});

describe('parsePushSubscriptionRow', () => {
  const validPushRow = {
    endpoint: 'https://push.example.test/subscription',
    user_id: 'user-1',
    p256dh: 'secret-public-key',
    auth: 'secret-auth-key',
    user_agent: 'Test Browser',
    disabled_at: null,
    failure_count: 2,
    last_success_at: 1_786_406_400_000,
    created_at: 1_786_400_000_000,
    updated_at: 1_786_406_400_000,
  };

  it('maps the durable row without exposing subscription key material', () => {
    expect(parsePushSubscriptionRow(validPushRow)).toEqual({
      endpoint: 'https://push.example.test/subscription',
      userAgent: 'Test Browser',
      disabledAt: null,
      failureCount: 2,
      lastSuccessAt: '2026-08-11T00:00:00.000Z',
      createdAt: '2026-08-10T22:13:20.000Z',
      updatedAt: '2026-08-11T00:00:00.000Z',
    });
  });

  it('rejects malformed durable rows', () => {
    expect(() => parsePushSubscriptionRow({ endpoint: 42 })).toThrow();
  });

  it('isolates a malformed row between two healthy list rows', () => {
    const onInvalid = vi.fn();
    const rows = parsePushSubscriptionRows(
      [
        validPushRow,
        { endpoint: 42 },
        { ...validPushRow, endpoint: 'https://push.example.test/2' },
      ],
      onInvalid
    );

    expect(rows.map((row) => row.endpoint)).toEqual([
      validPushRow.endpoint,
      'https://push.example.test/2',
    ]);
    expect(onInvalid).toHaveBeenCalledWith(1, expect.anything());
  });
});
