import { readFileSync } from 'node:fs';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { refreshNodeHealth } from '../../../src/routes/nodes/response';
import { listNodeHealthEvents } from '../../../src/services/node-health';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const NOW = new Date('2026-09-25T12:00:00.000Z');

describe('node health refresh', () => {
  let sqlite: Database.Database;
  let env: Env;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [schema.nodes]);
    sqlite.exec(
      readFileSync(
        new URL('../../../src/db/migrations/0172_node_health_events.sql', import.meta.url),
        'utf8'
      )
    );
    env = { DATABASE: createSqliteD1(sqlite) } as Env;
    const old = new Date(NOW.getTime() - 10 * 60_000).toISOString();
    sqlite
      .prepare(
        `INSERT INTO nodes (id, user_id, name, status, vm_size, vm_location,
          health_status, heartbeat_stale_after_seconds, last_heartbeat_at, created_at, updated_at)
         VALUES ('node-1', 'user-1', 'Test', 'running', 'small', 'nbg1',
          'healthy', 180, ?, ?, ?)`
      )
      .run(old, old, old);
  });

  afterEach(() => {
    sqlite.close();
    vi.useRealTimers();
  });

  async function snapshot() {
    const [node] = await drizzle(env.DATABASE, { schema }).select().from(schema.nodes);
    if (!node) throw new Error('missing node');
    return node;
  }

  it('records a missing heartbeat transition', async () => {
    const result = await refreshNodeHealth(
      drizzle(env.DATABASE, { schema }),
      await snapshot(),
      env
    );

    expect(result.healthStatus).toBe('unhealthy');
    expect((await listNodeHealthEvents(env, 'node-1')).map((event) => event.reason)).toEqual([
      'node_heartbeat_missing',
    ]);
  });

  it('does not overwrite a heartbeat that arrived after the node was read', async () => {
    const stale = await snapshot();
    sqlite
      .prepare(
        `UPDATE nodes SET last_heartbeat_at = ?, health_status = 'healthy' WHERE id = 'node-1'`
      )
      .run(NOW.toISOString());

    const result = await refreshNodeHealth(drizzle(env.DATABASE, { schema }), stale, env);

    expect(result.healthStatus).toBe('healthy');
    expect(result.lastHeartbeatAt).toBe(NOW.toISOString());
    expect(await listNodeHealthEvents(env, 'node-1')).toEqual([]);
  });
});
