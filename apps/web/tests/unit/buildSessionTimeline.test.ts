import type { NotificationResponse } from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import { buildSessionTimeline } from '../../src/components/project-message-view/buildSessionTimeline';
import type { ActivityEventResponse, ChatMessageResponse } from '../../src/lib/api/sessions';

function makeMessage(overrides: Partial<ChatMessageResponse> & { id: string }): ChatMessageResponse {
  return {
    sessionId: 'sess-1',
    role: 'user',
    content: 'Hello',
    toolMetadata: null,
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeEvent(overrides: Partial<ActivityEventResponse> & { id: string }): ActivityEventResponse {
  return {
    eventType: 'workspace.created',
    actorType: 'system',
    actorId: null,
    workspaceId: null,
    sessionId: null,
    taskId: null,
    payload: null,
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeNotification(overrides: Partial<NotificationResponse> & { id: string }): NotificationResponse {
  return {
    projectId: 'proj-1',
    taskId: 'task-1',
    sessionId: 'sess-1',
    type: 'progress',
    urgency: 'low',
    title: 'Progress update',
    body: 'Working on it',
    actionUrl: null,
    metadata: null,
    readAt: null,
    dismissedAt: null,
    createdAt: new Date(Date.now()).toISOString(),
    ...overrides,
  };
}

describe('buildSessionTimeline', () => {
  it('returns empty array when no messages and no events', () => {
    const result = buildSessionTimeline([], [], [], false);
    expect(result).toEqual([]);
  });

  it('includes only user messages, not assistant messages', () => {
    const messages: ChatMessageResponse[] = [
      makeMessage({ id: 'm1', role: 'user', content: 'Hello world', createdAt: 1000 }),
      makeMessage({ id: 'm2', role: 'assistant', content: 'Hi there', createdAt: 2000 }),
      makeMessage({ id: 'm3', role: 'user', content: 'How are you?', createdAt: 3000 }),
    ];
    const result = buildSessionTimeline(messages, [], [], false);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ kind: 'user_message', messageId: 'm1' });
    expect(result[1]).toMatchObject({ kind: 'user_message', messageId: 'm3' });
  });

  it('carries the messageId and timestamp used to anchor a jump', () => {
    const messages: ChatMessageResponse[] = [
      makeMessage({ id: 'm1', content: 'Hello', createdAt: 1234 }),
    ];
    const result = buildSessionTimeline(messages, [], [], false);

    expect(result[0]).toMatchObject({ kind: 'user_message', messageId: 'm1', timestamp: 1234 });
  });

  it('excludes activity events when showContext is false', () => {
    const messages: ChatMessageResponse[] = [
      makeMessage({ id: 'm1', content: 'Hello', createdAt: 1000 }),
    ];
    const events: ActivityEventResponse[] = [
      makeEvent({ id: 'e1', eventType: 'workspace.created', createdAt: 500 }),
    ];
    const result = buildSessionTimeline(messages, events, [], false);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: 'user_message' });
  });

  it('includes activity events when showContext is true', () => {
    const messages: ChatMessageResponse[] = [
      makeMessage({ id: 'm1', content: 'Hello', createdAt: 2000 }),
    ];
    const events: ActivityEventResponse[] = [
      makeEvent({ id: 'e1', eventType: 'workspace.created', createdAt: 1000 }),
    ];
    const result = buildSessionTimeline(messages, events, [], true);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ kind: 'system_event', title: 'Workspace created' });
    expect(result[1]).toMatchObject({ kind: 'user_message', messageId: 'm1' });
  });

  it('includes progress notifications even when context is hidden', () => {
    const notifications: NotificationResponse[] = [
      makeNotification({
        id: 'n1',
        title: 'Progress: Build',
        body: 'Installed dependencies and started tests',
        createdAt: new Date(1000).toISOString(),
      }),
    ];
    const result = buildSessionTimeline([], [], notifications, false);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: 'progress_notification',
      id: 'notif-n1',
      notificationId: 'n1',
      title: 'Progress: Build',
      text: 'Installed dependencies and started tests',
      timestamp: 1000,
      severity: 'info',
    });
  });

  it('uses notification fullMessage metadata before body and title', () => {
    const result = buildSessionTimeline(
      [],
      [],
      [
        makeNotification({
          id: 'n1',
          title: 'Progress: Fallback title',
          body: 'Short body',
          metadata: { fullMessage: 'Detailed status update from the agent' },
          createdAt: new Date(1000).toISOString(),
        }),
        makeNotification({
          id: 'n2',
          title: 'Progress: Title fallback',
          body: 'Body fallback',
          metadata: { fullMessage: '   ' },
          createdAt: new Date(2000).toISOString(),
        }),
        makeNotification({
          id: 'n3',
          title: 'Progress: Title fallback',
          body: null,
          createdAt: new Date(3000).toISOString(),
        }),
      ],
      false
    );

    expect(result.map((entry) => ('text' in entry ? entry.text : ''))).toEqual([
      'Detailed status update from the agent',
      'Body fallback',
      'Progress: Title fallback',
    ]);
  });

  it('truncates long progress notification text', () => {
    const longText = 'A'.repeat(220);
    const result = buildSessionTimeline(
      [],
      [],
      [
        makeNotification({
          id: 'n1',
          metadata: { fullMessage: longText },
          createdAt: new Date(1000).toISOString(),
        }),
      ],
      false
    );

    expect(result).toHaveLength(1);
    if (result[0].kind === 'progress_notification') {
      expect(result[0].text.length).toBeLessThanOrEqual(180);
      expect(result[0].text.endsWith('\u2026')).toBe(true);
    }
  });

  it('skips non-progress notifications and invalid notification timestamps', () => {
    const result = buildSessionTimeline(
      [],
      [],
      [
        makeNotification({ id: 'n1', type: 'error', createdAt: new Date(1000).toISOString() }),
        makeNotification({ id: 'n2', createdAt: 'not-a-date' }),
        makeNotification({ id: 'n3', body: 'Visible update', createdAt: new Date(2000).toISOString() }),
      ],
      false
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: 'progress_notification', notificationId: 'n3' });
  });

  it('sorts entries chronologically', () => {
    const messages: ChatMessageResponse[] = [
      makeMessage({ id: 'm1', content: 'First', createdAt: 3000 }),
      makeMessage({ id: 'm2', content: 'Second', createdAt: 1000 }),
    ];
    const events: ActivityEventResponse[] = [
      makeEvent({ id: 'e1', eventType: 'session.started', createdAt: 2000 }),
    ];
    const notifications: NotificationResponse[] = [
      makeNotification({ id: 'n1', body: 'Progress between event and final message', createdAt: new Date(2500).toISOString() }),
    ];
    const result = buildSessionTimeline(messages, events, notifications, true);

    expect(result).toHaveLength(4);
    expect(result[0].timestamp).toBe(1000);
    expect(result[1].timestamp).toBe(2000);
    expect(result[2].timestamp).toBe(2500);
    expect(result[3].timestamp).toBe(3000);
  });

  it('maps task.status_changed to correct severity', () => {
    const events: ActivityEventResponse[] = [
      makeEvent({ id: 'e1', eventType: 'task.status_changed', payload: { toStatus: 'completed' }, createdAt: 1000 }),
      makeEvent({ id: 'e2', eventType: 'task.status_changed', payload: { toStatus: 'failed' }, createdAt: 2000 }),
      makeEvent({ id: 'e3', eventType: 'task.status_changed', payload: { toStatus: 'cancelled' }, createdAt: 3000 }),
    ];
    const result = buildSessionTimeline([], events, [], true);

    expect(result[0]).toMatchObject({ severity: 'success', title: 'Task completed' });
    expect(result[1]).toMatchObject({ severity: 'error', title: 'Task failed' });
    expect(result[2]).toMatchObject({ severity: 'warning', title: 'Task cancelled' });
  });

  it('truncates long user message text', () => {
    const longText = 'A'.repeat(200);
    const messages: ChatMessageResponse[] = [
      makeMessage({ id: 'm1', content: longText, createdAt: 1000 }),
    ];
    const result = buildSessionTimeline(messages, [], [], false);

    expect(result).toHaveLength(1);
    if (result[0].kind === 'user_message') {
      expect(result[0].text.length).toBeLessThanOrEqual(120);
      expect(result[0].text.endsWith('\u2026')).toBe(true);
    }
  });

  it('skips empty/whitespace-only user messages', () => {
    const messages: ChatMessageResponse[] = [
      makeMessage({ id: 'm1', content: '   ', createdAt: 1000 }),
      makeMessage({ id: 'm2', content: '', createdAt: 2000 }),
      makeMessage({ id: 'm3', content: 'Real message', createdAt: 3000 }),
    ];
    const result = buildSessionTimeline(messages, [], [], false);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: 'user_message', messageId: 'm3' });
  });

  it('handles non-string message content', () => {
    const messages: ChatMessageResponse[] = [
      makeMessage({ id: 'm1', content: 123 as unknown as string, createdAt: 1000 }),
    ];
    const result = buildSessionTimeline(messages, [], [], false);
    // Non-string content produces empty text which is skipped
    expect(result).toHaveLength(0);
  });

  it('maps all event types to correct titles', () => {
    const eventTypes = [
      { eventType: 'workspace.created', expectedTitle: 'Workspace created' },
      { eventType: 'workspace.stopped', expectedTitle: 'Workspace stopped' },
      { eventType: 'workspace.restarted', expectedTitle: 'Workspace restarted' },
      { eventType: 'session.started', expectedTitle: 'Session started' },
      { eventType: 'session.stopped', expectedTitle: 'Session stopped' },
      { eventType: 'task.created', expectedTitle: 'Task created' },
      { eventType: 'task.delegated', expectedTitle: 'Task delegated' },
    ];
    const events = eventTypes.map((et, i) =>
      makeEvent({ id: `e${i}`, eventType: et.eventType, createdAt: i * 1000 })
    );
    const result = buildSessionTimeline([], events, [], true);

    for (let i = 0; i < eventTypes.length; i++) {
      expect(result[i]).toMatchObject({
        kind: 'system_event',
        title: eventTypes[i].expectedTitle,
      });
    }
  });

  it('maps all event types to correct severity', () => {
    const expectations = [
      { eventType: 'workspace.created', severity: 'info' },
      { eventType: 'workspace.stopped', severity: 'warning' },
      { eventType: 'workspace.restarted', severity: 'info' },
      { eventType: 'session.started', severity: 'info' },
      { eventType: 'session.stopped', severity: 'warning' },
      { eventType: 'task.created', severity: 'info' },
      { eventType: 'task.delegated', severity: 'info' },
    ];
    const events = expectations.map((et, i) =>
      makeEvent({ id: `e${i}`, eventType: et.eventType, createdAt: i * 1000 })
    );
    const result = buildSessionTimeline([], events, [], true);

    for (let i = 0; i < expectations.length; i++) {
      expect(result[i]).toMatchObject({
        kind: 'system_event',
        severity: expectations[i].severity,
      });
    }
  });

  it('maps task.status_changed with error status to error severity', () => {
    const events: ActivityEventResponse[] = [
      makeEvent({ id: 'e1', eventType: 'task.status_changed', payload: { toStatus: 'error' }, createdAt: 1000 }),
    ];
    const result = buildSessionTimeline([], events, [], true);
    expect(result[0]).toMatchObject({ severity: 'error', title: 'Task error' });
  });

  it('handles task.status_changed with null payload', () => {
    const events: ActivityEventResponse[] = [
      makeEvent({ id: 'e1', eventType: 'task.status_changed', payload: null, createdAt: 1000 }),
    ];
    const result = buildSessionTimeline([], events, [], true);
    expect(result[0]).toMatchObject({ severity: 'info', title: 'Task status changed' });
  });

  it('falls back to raw event type for unknown event types', () => {
    const events: ActivityEventResponse[] = [
      makeEvent({ id: 'e1', eventType: 'unknown.event', createdAt: 1000 }),
    ];
    const result = buildSessionTimeline([], events, [], true);
    expect(result[0]).toMatchObject({
      kind: 'system_event',
      title: 'unknown.event',
      severity: 'info',
    });
  });
});
