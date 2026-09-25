import { readFileSync } from 'node:fs';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import {
  claimNodeForCleanup,
  emptyResult,
  resolveCleanupConfig,
} from '../../../src/scheduled/node-cleanup/shared';
import {
  sweepUnhealthyNodes,
  type UnhealthyNodeBoundaries,
} from '../../../src/scheduled/node-cleanup/unhealthy-nodes';
import { listNodeHealthEvents } from '../../../src/services/node-health';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const NOW = new Date('2026-09-25T12:00:00.000Z');

describe('unhealthy node cleanup from lost heartbeat', () => {
  let sqlite: Database.Database;
  let env: Env;
  let order: string[];
  let boundaries: UnhealthyNodeBoundaries;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [schema.nodes, schema.workspaces, schema.tasks]);
    sqlite.exec(
      readFileSync(
        new URL('../../../src/db/migrations/0172_node_health_events.sql', import.meta.url),
        'utf8'
      )
    );
    env = { DATABASE: createSqliteD1(sqlite) } as Env;
    order = [];
    boundaries = {
      notice: vi.fn(async () => {
        order.push('notice');
        return 'notice-id';
      }) as UnhealthyNodeBoundaries['notice'],
      sleep: vi.fn(async () => {
        order.push('sleep');
      }) as UnhealthyNodeBoundaries['sleep'],
      release: vi.fn(async (_db, actualEnv, nowIso, node, options) => {
        order.push('release');
        const claimed = await claimNodeForCleanup(actualEnv, node, nowIso, {
          allowActiveWorkspaces: options.allowActiveWorkspaces,
          allowManagedRunningProvenance: options.allowManagedRunningProvenance,
          expectedLastHeartbeatAt: options.expectedLastHeartbeatAt,
          requireWorkspaceIdle: options.requireWorkspaceIdle,
        });
        if (!claimed) return 'skipped';
        sqlite.prepare('DELETE FROM nodes WHERE id = ?').run(node.id);
        return 'destroyed';
      }) as UnhealthyNodeBoundaries['release'],
    };
  });

  afterEach(() => sqlite.close());

  function seedNode(id: string, minutesSinceHeartbeat: number, withSession = true): void {
    const beat = new Date(NOW.getTime() - minutesSinceHeartbeat * 60_000).toISOString();
    sqlite
      .prepare(
        `INSERT INTO nodes (id, user_id, name, status, vm_size, vm_location, health_status,
        heartbeat_stale_after_seconds, last_heartbeat_at, created_at, updated_at,
        node_role, node_class, runtime)
       VALUES (?, 'user-1', ?, 'running', 'small', 'nbg1', 'healthy',
        180, ?, ?, ?, 'workspace', 'managed', 'vm')`
      )
      .run(id, id, beat, beat, beat);
    sqlite
      .prepare(
        `INSERT INTO tasks (id, status, auto_provisioned_node_id)
       VALUES (?, 'completed', ?)`
      )
      .run(`task-${id}`, id);
    if (!withSession) return;
    sqlite
      .prepare(
        `INSERT INTO workspaces (id, node_id, user_id, project_id, name, repository,
        branch, status, vm_size, vm_location, chat_session_id)
       VALUES (?, ?, 'user-1', 'project-1', 'Workspace', 'repo', 'main',
        'running', 'small', 'nbg1', ?)`
      )
      .run(`ws-${id}`, id, `session-${id}`);
  }

  async function sweep(): Promise<void> {
    await sweepUnhealthyNodes(
      drizzle(env.DATABASE, { schema }),
      env,
      NOW,
      resolveCleanupConfig(env),
      emptyResult(),
      boundaries
    );
  }

  it('posts a notice and asks a mid-turn session to sleep before deleting at the bound', async () => {
    seedNode('lost-node', 31);
    await sweep();

    expect(order).toEqual(['notice', 'sleep', 'release']);
    expect(sqlite.prepare(`SELECT id FROM nodes WHERE id = 'lost-node'`).get()).toBeUndefined();
    const events = await listNodeHealthEvents(env, 'lost-node');
    expect(events.map((event) => event.event)).toEqual([
      'unhealthy',
      'session_notice',
      'sleep_requested',
      'draining',
      'released',
    ]);
  });

  it('holds a silent node before the drain window and leaves healthy nodes untouched', async () => {
    seedNode('recovering-node', 7);
    seedNode('healthy-node', 1);
    await sweep();

    expect(order).toEqual([]);
    expect((await listNodeHealthEvents(env, 'recovering-node')).map((e) => e.reason)).toContain(
      'drain_window_not_elapsed'
    );
    expect(await listNodeHealthEvents(env, 'healthy-node')).toEqual([]);
  });

  it('retries preservation without repeating a delivered notice or sleep intent', async () => {
    seedNode('draining-node', 12);
    await sweep();
    await sweep();

    expect(order).toEqual(['notice', 'sleep']);
    const events = await listNodeHealthEvents(env, 'draining-node');
    expect(events.filter((event) => event.event === 'session_notice')).toHaveLength(1);
    expect(events.filter((event) => event.event === 'sleep_requested')).toHaveLength(1);
  });

  it('releases once the session has slept, before the release deadline', async () => {
    seedNode('slept-node', 12);
    boundaries.sleep = vi.fn(async () => {
      order.push('sleep');
      sqlite
        .prepare(`UPDATE workspaces SET status = 'sleeping' WHERE node_id = ?`)
        .run('slept-node');
    }) as UnhealthyNodeBoundaries['sleep'];

    await sweep();
    await sweep();

    expect(order).toEqual(['notice', 'sleep', 'release']);
    expect(sqlite.prepare(`SELECT id FROM nodes WHERE id = 'slept-node'`).get()).toBeUndefined();
  });

  it('holds deletion when multiple nodes lose heartbeat together', async () => {
    seedNode('fleet-1', 31, false);
    seedNode('fleet-2', 31, false);
    seedNode('fleet-3', 31, false);
    await sweep();

    expect(order).toEqual([]);
    expect((await listNodeHealthEvents(env, 'fleet-1')).map((e) => e.reason)).toContain(
      'fleet_heartbeat_intake_unverified'
    );
  });

  it('escalates a fleet-wide outage without deleting busy nodes on a timer', async () => {
    seedNode('fleet-expired-1', 41);
    seedNode('fleet-expired-2', 41, false);
    seedNode('fleet-expired-3', 41, false);
    sqlite
      .prepare(`UPDATE workspaces SET updated_at = ? WHERE node_id = ?`)
      .run(NOW.toISOString(), 'fleet-expired-1');
    await sweep();

    expect(order).toEqual([]);
    expect(sqlite.prepare(`SELECT status FROM nodes WHERE id = 'fleet-expired-1'`).get()).toEqual({
      status: 'running',
    });
    expect((await listNodeHealthEvents(env, 'fleet-expired-1')).map((e) => e.reason)).toContain(
      'fleet_heartbeat_intake_escalation_required'
    );
  });

  it('releases at the deadline even when health-event writes fail', async () => {
    seedNode('event-store-down', 31);
    const database = env.DATABASE;
    env = {
      ...env,
      DATABASE: {
        ...database,
        prepare(sql: string) {
          if (sql.includes('INSERT OR IGNORE INTO node_health_events')) {
            throw new Error('event store unavailable');
          }
          return database.prepare(sql);
        },
      } as D1Database,
    };

    await sweep();

    expect(order).toEqual(['notice', 'sleep', 'release']);
    expect(
      sqlite.prepare(`SELECT id FROM nodes WHERE id = 'event-store-down'`).get()
    ).toBeUndefined();
  });

  it('releases when a preservation RPC never answers', async () => {
    seedNode('sleep-rpc-hung', 31);
    env.NODE_UNHEALTHY_PRESERVATION_TIMEOUT_MS = '20';
    boundaries.sleep = vi.fn(() => {
      order.push('sleep');
      return new Promise<void>(() => {});
    }) as UnhealthyNodeBoundaries['sleep'];

    await sweep();

    expect(order).toEqual(['notice', 'sleep', 'release']);
    expect(
      sqlite.prepare(`SELECT id FROM nodes WHERE id = 'sleep-rpc-hung'`).get()
    ).toBeUndefined();
    expect((await listNodeHealthEvents(env, 'sleep-rpc-hung')).map((e) => e.event)).toContain(
      'sleep_unavailable'
    );
  });

  it('refuses deletion when a heartbeat arrives after selection', async () => {
    seedNode('recovered-race', 31);
    boundaries.sleep = vi.fn(async () => {
      order.push('sleep');
      sqlite
        .prepare(`UPDATE nodes SET last_heartbeat_at = ? WHERE id = 'recovered-race'`)
        .run(NOW.toISOString());
    }) as UnhealthyNodeBoundaries['sleep'];

    await sweep();

    expect(order).toEqual(['notice', 'sleep', 'release']);
    expect(sqlite.prepare(`SELECT id FROM nodes WHERE id = 'recovered-race'`).get()).toBeDefined();
    expect((await listNodeHealthEvents(env, 'recovered-race')).map((e) => e.reason)).toContain(
      'cleanup_claim_refused'
    );
  });
});
