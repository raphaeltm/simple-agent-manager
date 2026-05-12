import { afterEach,beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatSessionResponse } from '../../../src/lib/api';
import {
  formatRelativeTime,
  getLastActivity,
  getSessionState,
  isActiveSession,
  isStaleSession,
  STALE_SESSION_THRESHOLD_MS,
  STATE_BADGE_BG,
  STATE_COLORS,
  STATE_LABELS,
} from '../../../src/lib/chat-session-utils';

function makeSession(overrides: Partial<ChatSessionResponse> = {}): ChatSessionResponse {
  return {
    id: 'sess-1',
    workspaceId: null,
    taskId: null,
    topic: null,
    status: 'active',
    messageCount: 0,
    startedAt: Date.now(),
    endedAt: null,
    createdAt: Date.now(),
    lastMessageAt: null,
    isIdle: false,
    agentCompletedAt: null,
    ...overrides,
  };
}

describe('getSessionState', () => {
  it.each([
    ['stopped session', { status: 'stopped' }, 'terminated'],
    ['failed session status', { status: 'failed' }, 'terminated'],
    ['unknown status', { status: 'unknown' }, 'terminated'],
    ['idle session', { isIdle: true }, 'idle'],
    ['agentCompletedAt set', { agentCompletedAt: Date.now() }, 'idle'],
    ['active session', { status: 'active' }, 'active'],
    ['task failed + active session', { status: 'active', task: { id: 't-1', status: 'failed' } }, 'terminated'],
    ['task completed + active session', { status: 'active', task: { id: 't-1', status: 'completed' } }, 'terminated'],
    ['task cancelled + active session', { status: 'active', task: { id: 't-1', status: 'cancelled' } }, 'terminated'],
    ['task in_progress + active session', { status: 'active', task: { id: 't-1', status: 'in_progress' } }, 'active'],
    ['task with no status', { status: 'active', task: { id: 't-1' } }, 'active'],
    ['no task embed', { status: 'active' }, 'active'],
    ['task failed + idle (priority)', { status: 'active', isIdle: true, task: { id: 't-1', status: 'failed' } }, 'terminated'],
    ['task completed + agentCompletedAt (priority)', { status: 'active', agentCompletedAt: Date.now(), task: { id: 't-1', status: 'completed' } }, 'terminated'],
  ] as const)('returns correct state for %s', (_label, overrides, expected) => {
    expect(getSessionState(makeSession(overrides as Partial<ChatSessionResponse>))).toBe(expected);
  });
});

describe('getLastActivity', () => {
  it('returns lastMessageAt when available', () => {
    const ts = 1700000000000;
    expect(getLastActivity(makeSession({ lastMessageAt: ts, startedAt: ts - 1000 }))).toBe(ts);
  });

  it('falls back to startedAt when lastMessageAt is null', () => {
    const ts = 1700000000000;
    expect(getLastActivity(makeSession({ lastMessageAt: null, startedAt: ts }))).toBe(ts);
  });
});

describe('isStaleSession', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-31T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns false for session with recent activity', () => {
    expect(isStaleSession(makeSession({ lastMessageAt: Date.now() - 1000 }))).toBe(false);
  });

  it('returns true for session with activity beyond threshold', () => {
    expect(isStaleSession(makeSession({ lastMessageAt: Date.now() - STALE_SESSION_THRESHOLD_MS - 1 }))).toBe(true);
  });

  it('returns false at exact threshold boundary', () => {
    expect(isStaleSession(makeSession({ lastMessageAt: Date.now() - STALE_SESSION_THRESHOLD_MS }))).toBe(false);
  });
});

describe('formatRelativeTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-31T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    [30000, 'Just now'],
    [5 * 60000, '5m ago'],
    [3 * 3600000, '3h ago'],
    [5 * 86400000, '5d ago'],
  ])('formats %ims ago as "%s"', (ms, expected) => {
    expect(formatRelativeTime(Date.now() - ms)).toBe(expected);
  });

  it('returns formatted date for timestamps older than 30 days', () => {
    const result = formatRelativeTime(Date.now() - 45 * 86400000);
    expect(result).not.toContain('ago');
  });
});

describe('isActiveSession', () => {
  it.each([
    ['active session', { status: 'active' }, true],
    ['stopped session', { status: 'stopped' }, false],
    ['failed session status', { status: 'failed' }, false],
    ['unknown status (non-terminal)', { status: 'pending' }, true],
    ['task failed + active', { status: 'active', task: { id: 't-1', status: 'failed' } }, false],
    ['task completed + active', { status: 'active', task: { id: 't-1', status: 'completed' } }, false],
    ['task cancelled + active', { status: 'active', task: { id: 't-1', status: 'cancelled' } }, false],
    ['task in_progress + active', { status: 'active', task: { id: 't-1', status: 'in_progress' } }, true],
  ] as const)('returns %s → %s', (_label, overrides, expected) => {
    expect(isActiveSession(makeSession(overrides as Partial<ChatSessionResponse>))).toBe(expected);
  });
});

describe('STATE_COLORS, STATE_LABELS, and STATE_BADGE_BG', () => {
  it('maps all session states', () => {
    expect(STATE_COLORS).toHaveProperty('active');
    expect(STATE_COLORS).toHaveProperty('idle');
    expect(STATE_COLORS).toHaveProperty('terminated');
    expect(STATE_LABELS.active).toBe('Active');
    expect(STATE_LABELS.idle).toBe('Idle');
    expect(STATE_LABELS.terminated).toBe('Stopped');
    expect(STATE_BADGE_BG).toHaveProperty('active');
    expect(STATE_BADGE_BG).toHaveProperty('idle');
    expect(STATE_BADGE_BG).toHaveProperty('terminated');
  });
});
