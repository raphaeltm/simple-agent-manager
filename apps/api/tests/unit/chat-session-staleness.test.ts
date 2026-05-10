/**
 * Unit tests for chat session staleness sweep.
 *
 * Verifies that checkStaleChatSessions() catches:
 * 1. Active sessions whose workspace is in a terminal state (stopped/deleted/error)
 * 2. Active sessions with no workspace that are past the stale timeout
 *
 * Also tests computeStaleChatSessionAlarmTime() alarm scheduling.
 */
import { DEFAULT_CHAT_SESSION_STALE_TIMEOUT_MS } from '@simple-agent-manager/shared';
import { describe, expect, it, vi } from 'vitest';

import { checkStaleChatSessions, computeStaleChatSessionAlarmTime } from '../../src/durable-objects/project-data/sessions';

type Env = Parameters<typeof checkStaleChatSessions>[1];

function createMockSql(queryMap: Record<string, Record<string, unknown>[]>) {
  return {
    exec: vi.fn((query: string, ..._args: unknown[]) => {
      for (const [pattern, rows] of Object.entries(queryMap)) {
        if (query.includes(pattern)) return { toArray: () => rows };
      }
      return { toArray: () => [] };
    }),
  } as unknown as SqlStorage;
}

function createMockD1(batchResults: Array<{ results: Array<Record<string, unknown>> }> = []): D1Database {
  return {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(null) }),
    }),
    batch: vi.fn().mockResolvedValue(batchResults),
  } as unknown as D1Database;
}

function createMockEnv(overrides: Partial<Env> = {}): Env {
  return {
    DATABASE: createMockD1(),
    CHAT_SESSION_STALE_TIMEOUT_MS: String(DEFAULT_CHAT_SESSION_STALE_TIMEOUT_MS),
    ...overrides,
  } as unknown as Env;
}

describe('checkStaleChatSessions', () => {
  it('stops sessions whose workspace is in a terminal state', async () => {
    const sql = createMockSql({
      "status = 'active' AND workspace_id IS NOT NULL": [
        { id: 'session-1', workspace_id: 'ws-1' },
        { id: 'session-2', workspace_id: 'ws-2' },
      ],
      "workspace_id IS NULL": [],
    });

    const env = createMockEnv({
      DATABASE: createMockD1([
        { results: [{ id: 'ws-1', status: 'stopped' }] },
        { results: [{ id: 'ws-2', status: 'running' }] },
      ]),
    });

    const stopped = await checkStaleChatSessions(sql, env);

    expect(stopped).toBe(1);
    // Verify stopSessionInternal was called for the stopped workspace
    const updateCalls = (sql.exec as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => (call[0] as string).includes('UPDATE')
    );
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0][3]).toBe('session-1');
  });

  it('stops sessions whose workspace is not found in D1', async () => {
    const sql = createMockSql({
      "status = 'active' AND workspace_id IS NOT NULL": [
        { id: 'session-1', workspace_id: 'ws-gone' },
      ],
      "workspace_id IS NULL": [],
    });

    const env = createMockEnv({
      DATABASE: createMockD1([
        { results: [] }, // workspace not found
      ]),
    });

    const stopped = await checkStaleChatSessions(sql, env);

    expect(stopped).toBe(1);
  });

  it('stops sessions with no workspace past the stale timeout', async () => {
    const sql = createMockSql({
      "status = 'active' AND workspace_id IS NOT NULL": [],
      "workspace_id IS NULL": [
        { id: 'session-old' },
      ],
    });

    const env = createMockEnv();

    const stopped = await checkStaleChatSessions(sql, env);

    expect(stopped).toBe(1);
    const updateCalls = (sql.exec as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => (call[0] as string).includes('UPDATE')
    );
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0][3]).toBe('session-old');
  });

  it('does not stop sessions when no stale conditions are met', async () => {
    const sql = createMockSql({
      "status = 'active' AND workspace_id IS NOT NULL": [
        { id: 'session-1', workspace_id: 'ws-1' },
      ],
      "workspace_id IS NULL": [],
    });

    const env = createMockEnv({
      DATABASE: createMockD1([
        { results: [{ id: 'ws-1', status: 'running' }] },
      ]),
    });

    const stopped = await checkStaleChatSessions(sql, env);

    expect(stopped).toBe(0);
  });

  it('handles D1 batch errors gracefully', async () => {
    const sql = createMockSql({
      "status = 'active' AND workspace_id IS NOT NULL": [
        { id: 'session-1', workspace_id: 'ws-1' },
      ],
      "workspace_id IS NULL": [],
    });

    const d1 = createMockD1();
    (d1.batch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('D1 unavailable'));
    const env = createMockEnv({ DATABASE: d1 });

    const stopped = await checkStaleChatSessions(sql, env);

    // Should not crash, just return 0 stops from the workspace path
    expect(stopped).toBe(0);
  });

  it('uses SQL query with correct cutoff for no-workspace sessions', async () => {
    const sql = createMockSql({
      "status = 'active' AND workspace_id IS NOT NULL": [],
      "workspace_id IS NULL": [],
    });

    const env = createMockEnv();

    await checkStaleChatSessions(sql, env);

    const nullWsCalls = (sql.exec as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => (call[0] as string).includes('workspace_id IS NULL')
    );
    expect(nullWsCalls).toHaveLength(1);
    const cutoff = nullWsCalls[0][1] as number;
    const expectedCutoff = Date.now() - DEFAULT_CHAT_SESSION_STALE_TIMEOUT_MS;
    expect(Math.abs(cutoff - expectedCutoff)).toBeLessThan(1000);
  });
});

describe('computeStaleChatSessionAlarmTime', () => {
  it('returns null when no active sessions exist', () => {
    const sql = createMockSql({
      "COUNT(*)": [{ cnt: 0 }],
    });
    const env = createMockEnv();

    const alarmTime = computeStaleChatSessionAlarmTime(sql, env);
    expect(alarmTime).toBeNull();
  });

  it('returns polling interval for workspace-linked sessions', () => {
    const now = Date.now();
    const sql = createMockSql({
      "COUNT(*) as cnt FROM chat_sessions WHERE status = 'active'": [{ cnt: 2 }],
      "workspace_id IS NOT NULL": [{ cnt: 1 }],
      "workspace_id IS NULL": [{ earliest: null }],
    });
    const env = createMockEnv();

    const alarmTime = computeStaleChatSessionAlarmTime(sql, env);

    expect(alarmTime).not.toBeNull();
    // Should be roughly now + 5 minutes
    expect(alarmTime! - now).toBeGreaterThan(4 * 60 * 1000);
    expect(alarmTime! - now).toBeLessThan(6 * 60 * 1000);
  });

  it('returns created_at + timeout for no-workspace sessions', () => {
    const createdAt = Date.now() - 30 * 60 * 1000; // 30 min ago
    // Use ordered mock to control exact query responses
    const calls: Array<Record<string, unknown>[]> = [
      [{ cnt: 1 }],  // first: total active count
      [{ cnt: 0 }],  // second: workspace-linked count
      [{ earliest: createdAt }],  // third: earliest no-workspace
    ];
    let callIdx = 0;
    const sql = {
      exec: vi.fn(() => ({ toArray: () => calls[callIdx++] ?? [] })),
    } as unknown as SqlStorage;
    const env = createMockEnv();

    const alarmTime = computeStaleChatSessionAlarmTime(sql, env);

    expect(alarmTime).toBe(createdAt + DEFAULT_CHAT_SESSION_STALE_TIMEOUT_MS);
  });

  it('returns the earlier of workspace-poll and no-workspace alarm', () => {
    const now = Date.now();
    const createdAt = now - (DEFAULT_CHAT_SESSION_STALE_TIMEOUT_MS - 60_000); // 1 min before timeout
    const sql = createMockSql({
      "COUNT(*) as cnt FROM chat_sessions WHERE status = 'active'": [{ cnt: 2 }],
      "workspace_id IS NOT NULL": [{ cnt: 1 }],
      "workspace_id IS NULL": [{ earliest: createdAt }],
    });
    const env = createMockEnv();

    const alarmTime = computeStaleChatSessionAlarmTime(sql, env);

    const noWsAlarm = createdAt + DEFAULT_CHAT_SESSION_STALE_TIMEOUT_MS;
    const pollAlarm = now + 5 * 60 * 1000;
    // The no-workspace alarm (1 min from now) should be earlier than the 5-min poll
    expect(alarmTime).toBe(Math.min(noWsAlarm, pollAlarm));
  });
});
