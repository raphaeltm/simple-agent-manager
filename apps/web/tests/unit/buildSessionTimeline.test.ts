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

describe('buildSessionTimeline', () => {
  it('returns empty array when no messages and no events', () => {
    const result = buildSessionTimeline([], [], false, new Map());
    expect(result).toEqual([]);
  });

  it('includes only user messages, not assistant messages', () => {
    const messages: ChatMessageResponse[] = [
      makeMessage({ id: 'm1', role: 'user', content: 'Hello world', createdAt: 1000 }),
      makeMessage({ id: 'm2', role: 'assistant', content: 'Hi there', createdAt: 2000 }),
      makeMessage({ id: 'm3', role: 'user', content: 'How are you?', createdAt: 3000 }),
    ];
    const indexMap = new Map([['m1', 0], ['m2', 1], ['m3', 2]]);
    const result = buildSessionTimeline(messages, [], false, indexMap);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ kind: 'user_message', messageId: 'm1' });
    expect(result[1]).toMatchObject({ kind: 'user_message', messageId: 'm3' });
  });

  it('excludes activity events when showContext is false', () => {
    const messages: ChatMessageResponse[] = [
      makeMessage({ id: 'm1', content: 'Hello', createdAt: 1000 }),
    ];
    const events: ActivityEventResponse[] = [
      makeEvent({ id: 'e1', eventType: 'workspace.created', createdAt: 500 }),
    ];
    const result = buildSessionTimeline(messages, events, false, new Map([['m1', 0]]));

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
    const result = buildSessionTimeline(messages, events, true, new Map([['m1', 0]]));

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ kind: 'system_event', title: 'Workspace created' });
    expect(result[1]).toMatchObject({ kind: 'user_message', messageId: 'm1' });
  });

  it('sorts entries chronologically', () => {
    const messages: ChatMessageResponse[] = [
      makeMessage({ id: 'm1', content: 'First', createdAt: 3000 }),
      makeMessage({ id: 'm2', content: 'Second', createdAt: 1000 }),
    ];
    const events: ActivityEventResponse[] = [
      makeEvent({ id: 'e1', eventType: 'session.started', createdAt: 2000 }),
    ];
    const result = buildSessionTimeline(messages, events, true, new Map([['m1', 0], ['m2', 1]]));

    expect(result).toHaveLength(3);
    expect(result[0].timestamp).toBe(1000);
    expect(result[1].timestamp).toBe(2000);
    expect(result[2].timestamp).toBe(3000);
  });

  it('maps task.status_changed to correct severity', () => {
    const events: ActivityEventResponse[] = [
      makeEvent({ id: 'e1', eventType: 'task.status_changed', payload: { toStatus: 'completed' }, createdAt: 1000 }),
      makeEvent({ id: 'e2', eventType: 'task.status_changed', payload: { toStatus: 'failed' }, createdAt: 2000 }),
      makeEvent({ id: 'e3', eventType: 'task.status_changed', payload: { toStatus: 'cancelled' }, createdAt: 3000 }),
    ];
    const result = buildSessionTimeline([], events, true, new Map());

    expect(result[0]).toMatchObject({ severity: 'success', title: 'Task completed' });
    expect(result[1]).toMatchObject({ severity: 'error', title: 'Task failed' });
    expect(result[2]).toMatchObject({ severity: 'warning', title: 'Task cancelled' });
  });

  it('truncates long user message text', () => {
    const longText = 'A'.repeat(200);
    const messages: ChatMessageResponse[] = [
      makeMessage({ id: 'm1', content: longText, createdAt: 1000 }),
    ];
    const result = buildSessionTimeline(messages, [], false, new Map([['m1', 0]]));

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
    const result = buildSessionTimeline(messages, [], false, new Map([['m1', 0], ['m2', 1], ['m3', 2]]));

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: 'user_message', messageId: 'm3' });
  });

  it('preserves messageIndex from the index map', () => {
    const messages: ChatMessageResponse[] = [
      makeMessage({ id: 'm1', content: 'Hello', createdAt: 1000 }),
    ];
    const indexMap = new Map([['m1', 42]]);
    const result = buildSessionTimeline(messages, [], false, indexMap);

    expect(result[0]).toMatchObject({ kind: 'user_message', messageIndex: 42 });
  });

  it('returns messageIndex -1 when message ID is absent from index map', () => {
    const messages: ChatMessageResponse[] = [
      makeMessage({ id: 'm1', content: 'Hello', createdAt: 1000 }),
    ];
    const result = buildSessionTimeline(messages, [], false, new Map());

    expect(result[0]).toMatchObject({ kind: 'user_message', messageIndex: -1 });
  });

  it('handles non-string message content', () => {
    const messages: ChatMessageResponse[] = [
      makeMessage({ id: 'm1', content: 123 as unknown as string, createdAt: 1000 }),
    ];
    const result = buildSessionTimeline(messages, [], false, new Map([['m1', 0]]));
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
    const result = buildSessionTimeline([], events, true, new Map());

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
    const result = buildSessionTimeline([], events, true, new Map());

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
    const result = buildSessionTimeline([], events, true, new Map());
    expect(result[0]).toMatchObject({ severity: 'error', title: 'Task error' });
  });

  it('handles task.status_changed with null payload', () => {
    const events: ActivityEventResponse[] = [
      makeEvent({ id: 'e1', eventType: 'task.status_changed', payload: null, createdAt: 1000 }),
    ];
    const result = buildSessionTimeline([], events, true, new Map());
    expect(result[0]).toMatchObject({ severity: 'info', title: 'Task status changed' });
  });

  it('falls back to raw event type for unknown event types', () => {
    const events: ActivityEventResponse[] = [
      makeEvent({ id: 'e1', eventType: 'unknown.event', createdAt: 1000 }),
    ];
    const result = buildSessionTimeline([], events, true, new Map());
    expect(result[0]).toMatchObject({
      kind: 'system_event',
      title: 'unknown.event',
      severity: 'info',
    });
  });
});
