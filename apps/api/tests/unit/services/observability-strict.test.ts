import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Env } from '../../../src/env';
import { persistErrorBatchStrict } from '../../../src/services/observability-strict';
import { createSqliteD1 } from '../../helpers/sqlite-d1';

describe('strict observability persistence', () => {
  let sqlite: Database.Database;
  let d1: D1Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE platform_errors (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL,
        stack TEXT, context TEXT, user_id TEXT, node_id TEXT, workspace_id TEXT,
        ip_address TEXT, user_agent TEXT, timestamp INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );
    `);
    d1 = createSqliteD1(sqlite);
  });

  it('idempotently acknowledges an identical stable incident', async () => {
    const input = {
      id: '01KZ8V0GMXQ4ZCSERPRT2X2K6Q',
      source: 'vm-agent' as const,
      level: 'error' as const,
      message: 'exact failure',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      timestamp: 1_786_000_000_000,
    };
    await persistErrorBatchStrict(d1, [input]);
    await persistErrorBatchStrict(d1, [input]);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM platform_errors').get()).toEqual({
      count: 1,
    });
  });

  it('rejects same-node incident ID reuse with different error metadata', async () => {
    const id = '01KZ8V0GMXQ4ZCSERPRT2X2K6R';
    const base = {
      id,
      source: 'vm-agent' as const,
      level: 'error' as const,
      message: 'first failure',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
    };
    await persistErrorBatchStrict(d1, [base]);
    await expect(
      persistErrorBatchStrict(d1, [{ ...base, message: 'conflicting failure' }])
    ).rejects.toThrow('different metadata');
    expect(sqlite.prepare('SELECT message FROM platform_errors WHERE id = ?').get(id)).toEqual({
      message: 'first failure',
    });
  });

  it('rejects an oversized strict batch instead of silently acknowledging a prefix', async () => {
    const inputs = ['Q', 'R'].map((suffix) => ({
      id: `01KZ8V0GMXQ4ZCSERPRT2X2K6${suffix}`,
      source: 'vm-agent' as const,
      level: 'error' as const,
      message: `failure-${suffix}`,
      nodeId: 'node-1',
    }));
    await expect(
      persistErrorBatchStrict(d1, inputs, { OBSERVABILITY_ERROR_BATCH_SIZE: '1' } as never)
    ).rejects.toThrow('exceeds configured limit of 1');
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM platform_errors').get()).toEqual({
      count: 0,
    });
  });

  it('uses operator-configured field limits for persisted diagnostics', async () => {
    await persistErrorBatchStrict(
      d1,
      [
        {
          id: '01KZ8V0GMXQ4ZCSERPRT2X2K6S',
          source: 'vm-agent',
          level: 'error',
          message: 'message-too-long',
          stack: 'stack-too-long',
          userAgent: 'user-agent-too-long',
          nodeId: 'node-1',
        },
      ],
      {
        OBSERVABILITY_ERROR_MESSAGE_MAX_LENGTH: '4',
        OBSERVABILITY_ERROR_STACK_MAX_LENGTH: '5',
        OBSERVABILITY_ERROR_USER_AGENT_MAX_LENGTH: '6',
      } as Env
    );

    expect(
      sqlite.prepare('SELECT message, stack, user_agent FROM platform_errors LIMIT 1').get()
    ).toEqual({ message: 'mess...', stack: 'stack...', user_agent: 'user-a...' });
  });
});
