import { describe, expect, it } from 'vitest';

import { ATTENTION_TYPES } from '../../../src/components/NotificationCenter';

describe('ATTENTION_TYPES — notification badge classification', () => {
  it('includes needs_input as attention-required', () => {
    expect(ATTENTION_TYPES.has('needs_input')).toBe(true);
  });

  it('includes error as attention-required', () => {
    expect(ATTENTION_TYPES.has('error')).toBe(true);
  });

  it('excludes task_complete from attention count', () => {
    expect(ATTENTION_TYPES.has('task_complete')).toBe(false);
  });

  it('excludes progress from attention count', () => {
    expect(ATTENTION_TYPES.has('progress')).toBe(false);
  });

  it('excludes session_ended from attention count', () => {
    expect(ATTENTION_TYPES.has('session_ended')).toBe(false);
  });

  it('excludes pr_created from attention count', () => {
    expect(ATTENTION_TYPES.has('pr_created')).toBe(false);
  });

  it('contains exactly 2 attention types', () => {
    expect(ATTENTION_TYPES.size).toBe(2);
  });
});

describe('notification badge count logic', () => {
  let notificationId = 0;
  const makeNotification = (type: string, readAt: string | null = null) => ({
    id: `n-${notificationId++}`,
    type,
    readAt,
    title: 'test',
    body: null,
    projectId: null,
    taskId: null,
    sessionId: null,
    urgency: 'high' as const,
    actionUrl: null,
    metadata: null,
    dismissedAt: null,
    createdAt: new Date().toISOString(),
  });

  it('counts only attention types for badge', () => {
    const notifications = [
      makeNotification('needs_input'),          // attention - unread
      makeNotification('error'),                // attention - unread
      makeNotification('task_complete'),         // update - unread
      makeNotification('progress'),             // update - unread
      makeNotification('session_ended'),         // update - unread
      makeNotification('pr_created'),            // update - unread
    ];

    const attentionUnreadCount = notifications.filter(
      (n) => ATTENTION_TYPES.has(n.type) && !n.readAt
    ).length;

    // Badge should show 2 (needs_input + error), not 6 (all unread)
    expect(attentionUnreadCount).toBe(2);
  });

  it('does not count read attention notifications', () => {
    const notifications = [
      makeNotification('needs_input', new Date().toISOString()), // read
      makeNotification('error'),                                  // unread
    ];

    const attentionUnreadCount = notifications.filter(
      (n) => ATTENTION_TYPES.has(n.type) && !n.readAt
    ).length;

    expect(attentionUnreadCount).toBe(1);
  });

  it('returns 0 when no attention-required notifications exist', () => {
    const notifications = [
      makeNotification('task_complete'),
      makeNotification('progress'),
      makeNotification('pr_created'),
    ];

    const attentionUnreadCount = notifications.filter(
      (n) => ATTENTION_TYPES.has(n.type) && !n.readAt
    ).length;

    expect(attentionUnreadCount).toBe(0);
  });

  it('updates tab correctly separates attention from updates', () => {
    const notifications = [
      makeNotification('needs_input'),
      makeNotification('error'),
      makeNotification('task_complete'),
      makeNotification('progress'),
    ];

    const attentionNotifs = notifications.filter((n) => ATTENTION_TYPES.has(n.type));
    const updateNotifs = notifications.filter((n) => !ATTENTION_TYPES.has(n.type));

    expect(attentionNotifs).toHaveLength(2);
    expect(updateNotifs).toHaveLength(2);
    expect(attentionNotifs.map((n) => n.type)).toEqual(['needs_input', 'error']);
    expect(updateNotifs.map((n) => n.type)).toEqual(['task_complete', 'progress']);
  });
});
