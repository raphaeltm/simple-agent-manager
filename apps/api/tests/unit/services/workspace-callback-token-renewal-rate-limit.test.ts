/**
 * The per-workspace renewal limit against a real SQLite engine (rule 28: a limit whose state
 * is a SQL statement must be proven on a SQL engine, not a mock). Route-level behaviour,
 * including that only authenticated attempts are counted, is in
 * tests/workers/workspace-callback-token-renewal.test.ts.
 */
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { DEFAULT_RATE_LIMITS } from '../../../src/middleware/rate-limit';
import {
  consumeCallbackTokenRenewalQuota,
  DEFAULT_CALLBACK_TOKEN_RENEWAL_WINDOW_SECONDS,
  getCallbackTokenRenewalRateLimit,
} from '../../../src/services/workspace-callback-token-renewal-rate-limit';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const WS = 'ws-1';
const OTHER_WS = 'ws-2';
const WINDOW_SECONDS = 600;
// Mid-window, so a burst never straddles a window boundary by accident.
const T0 = (1_000_000 * WINDOW_SECONDS + 100) * 1000;

let sqlite: Database.Database;

function makeEnv(overrides: Record<string, string> = {}): Env {
  return {
    DATABASE: createSqliteD1(sqlite),
    RATE_LIMIT_CALLBACK_TOKEN_RENEWAL: '3',
    RATE_LIMIT_CALLBACK_TOKEN_RENEWAL_WINDOW_SECONDS: String(WINDOW_SECONDS),
    ...overrides,
  } as unknown as Env;
}

function counterRows(): Array<{ workspace_id: string; window_start: number; count: number }> {
  return sqlite
    .prepare('SELECT * FROM workspace_callback_token_renewal_rate_limits ORDER BY workspace_id')
    .all() as Array<{ workspace_id: string; window_start: number; count: number }>;
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.workspaces, schema.workspaceCallbackTokenRenewalRateLimits]);
  const insert = sqlite.prepare(
    `INSERT INTO workspaces (id, user_id, node_id, status, name) VALUES (?, 'user-1', 'node-1', 'running', 'ws')`
  );
  insert.run(WS);
  insert.run(OTHER_WS);
});

describe('consumeCallbackTokenRenewalQuota', () => {
  it('allows the configured attempts per window, then reports when the window ends', async () => {
    const env = makeEnv();
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(await consumeCallbackTokenRenewalQuota(env, WS, T0)).toEqual({ outcome: 'allowed' });
    }

    expect(await consumeCallbackTokenRenewalQuota(env, WS, T0 + 1000)).toEqual({
      outcome: 'limited',
      retryAfterSeconds: WINDOW_SECONDS - 101,
    });
  });

  it('starts a new count when the window rolls over, and bounds that burst too', async () => {
    const env = makeEnv();
    for (let attempt = 0; attempt < 4; attempt++) {
      await consumeCallbackTokenRenewalQuota(env, WS, T0);
    }
    const nextWindow = T0 + WINDOW_SECONDS * 1000;

    for (let attempt = 0; attempt < 3; attempt++) {
      expect(await consumeCallbackTokenRenewalQuota(env, WS, nextWindow)).toEqual({
        outcome: 'allowed',
      });
    }
    expect((await consumeCallbackTokenRenewalQuota(env, WS, nextWindow)).outcome).toBe('limited');
    expect(counterRows()).toEqual([
      { workspace_id: WS, window_start: T0 / 1000 - 100 + WINDOW_SECONDS, count: 4 },
    ]);
  });

  it('counts each workspace separately', async () => {
    const env = makeEnv();
    for (let attempt = 0; attempt < 4; attempt++) {
      await consumeCallbackTokenRenewalQuota(env, WS, T0);
    }

    expect(await consumeCallbackTokenRenewalQuota(env, OTHER_WS, T0)).toEqual({
      outcome: 'allowed',
    });
  });

  it('loses no increments when attempts arrive together', async () => {
    const env = makeEnv();

    const results = await Promise.all(
      Array.from({ length: 6 }, () => consumeCallbackTokenRenewalQuota(env, WS, T0))
    );

    expect(results.filter((result) => result.outcome === 'allowed')).toHaveLength(3);
    expect(results.filter((result) => result.outcome === 'limited')).toHaveLength(3);
    expect(counterRows()[0]?.count).toBe(6);
  });

  it('reports a workspace deleted since the caller checked it, without writing a row', async () => {
    sqlite.prepare('DELETE FROM workspaces WHERE id = ?').run(WS);

    expect(await consumeCallbackTokenRenewalQuota(makeEnv(), WS, T0)).toEqual({
      outcome: 'workspace_missing',
    });
    expect(counterRows()).toEqual([]);
  });
});

describe('getCallbackTokenRenewalRateLimit', () => {
  it.each([
    [
      'unset',
      {},
      DEFAULT_RATE_LIMITS.CALLBACK_TOKEN_RENEWAL,
      DEFAULT_CALLBACK_TOKEN_RENEWAL_WINDOW_SECONDS,
    ],
    [
      'configured',
      {
        RATE_LIMIT_CALLBACK_TOKEN_RENEWAL: '5',
        RATE_LIMIT_CALLBACK_TOKEN_RENEWAL_WINDOW_SECONDS: '60',
      },
      5,
      60,
    ],
    [
      'invalid',
      {
        RATE_LIMIT_CALLBACK_TOKEN_RENEWAL: '0',
        RATE_LIMIT_CALLBACK_TOKEN_RENEWAL_WINDOW_SECONDS: 'soon',
      },
      DEFAULT_RATE_LIMITS.CALLBACK_TOKEN_RENEWAL,
      DEFAULT_CALLBACK_TOKEN_RENEWAL_WINDOW_SECONDS,
    ],
  ])('resolves the limit when %s', (_label, vars, limit, windowSeconds) => {
    expect(getCallbackTokenRenewalRateLimit(vars as unknown as Env)).toEqual({
      limit,
      windowSeconds,
    });
  });

  it('defaults to 12 attempts per hour', () => {
    expect(DEFAULT_RATE_LIMITS.CALLBACK_TOKEN_RENEWAL).toBe(12);
    expect(DEFAULT_CALLBACK_TOKEN_RENEWAL_WINDOW_SECONDS).toBe(3600);
  });
});
