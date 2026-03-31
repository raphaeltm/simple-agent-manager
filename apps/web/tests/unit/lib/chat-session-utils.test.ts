import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  getSessionState,
  isStaleSession,
  getLastActivity,
  formatRelativeTime,
  STALE_SESSION_THRESHOLD_MS,
  STATE_COLORS,
  STATE_LABELS,
} from '../../../src/lib/chat-session-utils';
import type { ChatSessionResponse } from '../../../src/lib/api';

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
  it('returns "terminated" for stopped sessions', () => {
    expect(getSessionState(makeSession({ status: 'stopped' }))).toBe('terminated');
  });

  it('returns "idle" for idle sessions', () => {
    expect(getSessionState(makeSession({ isIdle: true }))).toBe('idle');
  });

  it('returns "idle" when agentCompletedAt is set', () => {
    expect(getSessionState(makeSession({ agentCompletedAt: Date.now() }))).toBe('idle');
  });

  it('returns "active" for active sessions', () => {
    expect(getSessionState(makeSession({ status: 'active' }))).toBe('active');
  });

  it('returns "terminated" for unknown status', () => {
    expect(getSessionState(makeSession({ status: 'unknown' }))).toBe('terminated');
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
    const session = makeSession({ lastMessageAt: Date.now() - 1000 });
    expect(isStaleSession(session)).toBe(false);
  });

  it('returns true for session with activity beyond threshold', () => {
    const session = makeSession({ lastMessageAt: Date.now() - STALE_SESSION_THRESHOLD_MS - 1 });
    expect(isStaleSession(session)).toBe(true);
  });

  it('returns false at exact threshold boundary', () => {
    const session = makeSession({ lastMessageAt: Date.now() - STALE_SESSION_THRESHOLD_MS });
    expect(isStaleSession(session)).toBe(false);
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

  it('returns "Just now" for timestamps less than a minute ago', () => {
    expect(formatRelativeTime(Date.now() - 30000)).toBe('Just now');
  });

  it('returns minutes for timestamps less than an hour ago', () => {
    expect(formatRelativeTime(Date.now() - 5 * 60000)).toBe('5m ago');
  });

  it('returns hours for timestamps less than a day ago', () => {
    expect(formatRelativeTime(Date.now() - 3 * 3600000)).toBe('3h ago');
  });

  it('returns days for timestamps less than 30 days ago', () => {
    expect(formatRelativeTime(Date.now() - 5 * 86400000)).toBe('5d ago');
  });

  it('returns formatted date for timestamps older than 30 days', () => {
    const old = Date.now() - 45 * 86400000;
    const result = formatRelativeTime(old);
    // Should be a date string, not relative
    expect(result).not.toContain('ago');
  });
});

describe('STATE_COLORS and STATE_LABELS', () => {
  it('maps all session states', () => {
    expect(STATE_COLORS).toHaveProperty('active');
    expect(STATE_COLORS).toHaveProperty('idle');
    expect(STATE_COLORS).toHaveProperty('terminated');
    expect(STATE_LABELS.active).toBe('Active');
    expect(STATE_LABELS.idle).toBe('Idle');
    expect(STATE_LABELS.terminated).toBe('Stopped');
  });
});
