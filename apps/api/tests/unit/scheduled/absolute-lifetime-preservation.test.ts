import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { prepareAbsoluteLifetimeRelease } from '../../../src/scheduled/node-cleanup/absolute-lifetime-preservation';
import { resolveCleanupConfig } from '../../../src/scheduled/node-cleanup/config';
import { sweepMaxLifetimeNodes } from '../../../src/scheduled/node-cleanup/node-phases';
import { emptyResult } from '../../../src/scheduled/node-cleanup/result';
import { claimNodeForCleanup } from '../../../src/scheduled/node-cleanup/shared';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({
  queue: vi.fn(async () => {}),
  message: vi.fn(async () => 'notice-1'),
  delete: vi.fn(),
}));
vi.mock('../../../src/services/nodes', () => ({
  deleteNodeResourcesStrict: (...args: unknown[]) => mocks.delete(...args),
}));
vi.mock('../../../src/services/session-sleep', () => ({
  queueWorkspaceSessionSleep: (...args: unknown[]) => mocks.queue(...args),
}));
vi.mock('../../../src/services/project-data', () => ({
  persistMessage: (...args: unknown[]) => mocks.message(...args),
}));

const node = {
  id: 'old-node',
  user_id: 'user-1',
  status: 'running',
  created_at: '2026-09-30T00:00:00.000Z',
};
const now = new Date('2026-10-01T06:00:00.000Z');

function seed(
  sqlite: Database.Database,
  attempts: number,
  sleepStatus: string,
  sleepAfter?: string
) {
  sqlite
    .prepare(
      `INSERT INTO nodes (id, user_id, status, node_role, node_class, runtime, created_at, updated_at)
    VALUES ('old-node', 'user-1', 'running', 'workspace', 'managed', 'vm', ?, ?)`
    )
    .run(node.created_at, node.created_at);
  sqlite
    .prepare(
      `INSERT INTO tasks (id, auto_provisioned_node_id, created_at, updated_at)
    VALUES ('task-1', 'old-node', ?, ?)`
    )
    .run(node.created_at, node.created_at);
  sqlite
    .prepare(
      `INSERT INTO workspaces
    (id, node_id, user_id, project_id, chat_session_id, status, created_at, updated_at)
    VALUES ('old-workspace', 'old-node', 'user-1', 'project-1', 'chat-1', 'running', ?, ?)`
    )
    .run(node.created_at, node.created_at);
  sqlite
    .prepare(
      `INSERT INTO session_snapshots
    (id, workspace_id, node_id, project_id, user_id, chat_session_id, runtime,
     status, degradation, sleep_status, sleep_after, sleep_attempts, expires_at, created_at, updated_at)
    VALUES ('snapshot-1', 'old-workspace', 'old-node', 'project-1', 'user-1', 'chat-1',
      'vm', 'degraded', 'home-skipped', ?, ?, ?, '2026-10-02T00:00:00.000Z', ?, ?)`
    )
    .run(sleepStatus, sleepAfter ?? null, attempts, node.created_at, node.created_at);
}

describe('absolute lifetime active-workspace preservation', () => {
  let sqlite: Database.Database;
  let env: Env;
  beforeEach(() => {
    vi.clearAllMocks();
    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [
      schema.nodes,
      schema.tasks,
      schema.workspaces,
      schema.sessionSnapshots,
      schema.agentSessions,
      schema.nodeHealthEvents,
    ]);
    sqlite.exec(
      `CREATE UNIQUE INDEX session_snapshots_chat_session_id_unique ON session_snapshots(chat_session_id)`
    );
    env = {
      DATABASE: createSqliteD1(sqlite),
      SESSION_SLEEP_MAX_ATTEMPTS: '9',
      SESSION_SLEEP_RETRY_DELAY_MS: '300000',
      NODE_UNHEALTHY_RELEASE_AFTER_MS: '1800000',
    } as Env;
    mocks.delete.mockImplementation(async (nodeId: string) => {
      const proof = now.toISOString();
      sqlite
        .prepare(`UPDATE nodes SET runtime_termination_confirmed_at = ? WHERE id = ?`)
        .run(proof, nodeId);
      return { runtimeTerminationConfirmedAt: proof, runtimeIncarnationId: null };
    });
  });
  afterEach(() => sqlite.close());

  it('holds the old-node shape with home-skipped and nine failed attempts even after escalation', async () => {
    seed(sqlite, 9, 'failed');
    const config = resolveCleanupConfig(env);
    expect(await prepareAbsoluteLifetimeRelease(env, node, now, config)).toBe(false);
    expect(mocks.queue).not.toHaveBeenCalled();
    expect(mocks.message).not.toHaveBeenCalled();
    expect(sqlite.prepare(`SELECT event FROM node_health_events`).pluck().all()).toEqual([
      'absolute_lifetime_preservation_requested',
    ]);

    sqlite.prepare(`UPDATE node_health_events SET created_at = '2026-10-01T05:00:00.000Z'`).run();
    expect(await prepareAbsoluteLifetimeRelease(env, node, now, config)).toBe(false);
    expect(mocks.message).toHaveBeenCalledWith(
      env,
      'project-1',
      'chat-1',
      'system',
      expect.stringContaining('degraded/home-skipped after 9 sleep attempts'),
      expect.any(Object),
      expect.any(String)
    );
    expect(
      sqlite
        .prepare(`SELECT event FROM node_health_events ORDER BY created_at, rowid`)
        .pluck()
        .all()
    ).toContain('absolute_lifetime_preservation_blocked');
    await prepareAbsoluteLifetimeRelease(env, node, now, config);
    expect(mocks.message).toHaveBeenCalledTimes(1);
  });

  it('queues a bounded capture attempt while retaining the active workspace', async () => {
    seed(sqlite, 2, 'failed');
    expect(await prepareAbsoluteLifetimeRelease(env, node, now, resolveCleanupConfig(env))).toBe(
      false
    );
    expect(mocks.queue).toHaveBeenCalledWith(env, {
      workspaceId: 'old-workspace',
      userId: 'user-1',
      reason: 'absolute_node_lifetime',
      sleepAfterMs: 0,
      expectedNodeId: 'old-node',
    });
  });

  it('does not pull a future failed-sleep retry forward during repeated cleanup sweeps', async () => {
    const retryAt = new Date(Date.now() + 5 * 60_000).toISOString();
    seed(sqlite, 2, 'failed', retryAt);
    sqlite
      .prepare(
        `INSERT INTO agent_sessions (id, workspace_id, user_id, status, created_at, updated_at) VALUES ('agent-1', 'old-workspace', 'user-1', 'running', ?, ?)`
      )
      .run(node.created_at, node.created_at);
    const actualQueue = await vi.importActual<
      typeof import('../../../src/services/session-sleep-queue')
    >('../../../src/services/session-sleep-queue');
    await actualQueue.queueWorkspaceSessionSleep(env, {
      workspaceId: 'old-workspace',
      userId: 'user-1',
      reason: 'regression_probe',
      sleepAfterMs: 0,
      expectedNodeId: 'old-node',
    });
    expect(
      sqlite
        .prepare(`SELECT sleep_after FROM session_snapshots WHERE id = 'snapshot-1'`)
        .pluck()
        .get()
    ).not.toBe(retryAt);
    sqlite
      .prepare(
        `UPDATE session_snapshots SET sleep_status = 'failed', sleep_after = ? WHERE id = 'snapshot-1'`
      )
      .run(retryAt);
    const config = resolveCleanupConfig(env);
    await prepareAbsoluteLifetimeRelease(env, node, now, config);
    await prepareAbsoluteLifetimeRelease(env, node, now, config);
    expect(mocks.queue).not.toHaveBeenCalled();
    expect(
      sqlite
        .prepare(`SELECT sleep_after FROM session_snapshots WHERE id = 'snapshot-1'`)
        .pluck()
        .get()
    ).toBe(retryAt);
  });

  it('retries a failed owner notice before marking escalation delivered', async () => {
    seed(sqlite, 9, 'failed');
    const config = resolveCleanupConfig(env);
    await prepareAbsoluteLifetimeRelease(env, node, now, config);
    sqlite.prepare(`UPDATE node_health_events SET created_at = '2026-10-01T05:00:00.000Z'`).run();
    mocks.message.mockRejectedValueOnce(new Error('Durable Object unavailable'));
    await prepareAbsoluteLifetimeRelease(env, node, now, config);
    expect(
      sqlite
        .prepare(
          `SELECT count(*) FROM node_health_events WHERE event = 'absolute_lifetime_preservation_blocked'`
        )
        .pluck()
        .get()
    ).toBe(0);
    await prepareAbsoluteLifetimeRelease(env, node, now, config);
    await prepareAbsoluteLifetimeRelease(env, node, now, config);
    expect(mocks.message).toHaveBeenCalledTimes(2);
    expect(mocks.message.mock.calls[0]?.at(-1)).toBe(mocks.message.mock.calls[1]?.at(-1));
    expect(
      sqlite
        .prepare(
          `SELECT count(*) FROM node_health_events WHERE event = 'absolute_lifetime_preservation_blocked'`
        )
        .pluck()
        .get()
    ).toBe(1);
  });

  it('stops scheduling new capture attempts once the bounded hold has escalated', async () => {
    seed(sqlite, 2, 'failed');
    const config = resolveCleanupConfig(env);
    await prepareAbsoluteLifetimeRelease(env, node, now, config);
    expect(mocks.queue).toHaveBeenCalledTimes(1);
    sqlite.prepare(`UPDATE node_health_events SET created_at = '2026-10-01T05:00:00.000Z'`).run();
    await prepareAbsoluteLifetimeRelease(env, node, now, config);
    expect(mocks.queue).toHaveBeenCalledTimes(1);
    expect(mocks.message).toHaveBeenCalledTimes(1);
  });

  it('does not destroy the old-node shape in the absolute-lifetime sweep', async () => {
    seed(sqlite, 9, 'failed');
    const result = emptyResult();
    await sweepMaxLifetimeNodes(
      drizzle(env.DATABASE, { schema }),
      env,
      now,
      resolveCleanupConfig(env),
      result
    );
    expect(result).toMatchObject({ lifetimeDestroyed: 0, lifetimeSkipped: 1 });
    expect(sqlite.prepare(`SELECT status FROM nodes WHERE id = 'old-node'`).pluck().get()).toBe(
      'running'
    );
    expect(
      sqlite.prepare(`SELECT cleanup_backoff_until FROM nodes WHERE id = 'old-node'`).pluck().get()
    ).toEqual(expect.any(String));
  });

  it('holds a shared node while any of its active workspaces still needs preservation', async () => {
    seed(sqlite, 9, 'failed');
    sqlite
      .prepare(
        `INSERT INTO workspaces
      (id, node_id, user_id, project_id, chat_session_id, status, created_at, updated_at)
      VALUES ('second-workspace', 'old-node', 'user-1', 'project-1', 'chat-2', 'running', ?, ?)`
      )
      .run(node.created_at, node.created_at);
    const result = emptyResult();
    await sweepMaxLifetimeNodes(
      drizzle(env.DATABASE, { schema }),
      env,
      now,
      resolveCleanupConfig(env),
      result
    );
    expect(result).toMatchObject({ lifetimeDestroyed: 0, lifetimeSkipped: 1 });
    expect(sqlite.prepare(`SELECT status FROM nodes WHERE id = 'old-node'`).pluck().get()).toBe(
      'running'
    );
    expect(
      sqlite
        .prepare(
          `SELECT reason FROM node_health_events WHERE event = 'absolute_lifetime_preservation_requested' ORDER BY reason`
        )
        .pluck()
        .all()
    ).toEqual(['old-workspace', 'second-workspace']);
  });

  it('deletes eligible empty nodes across bounded sweeps despite a larger protected backlog', async () => {
    seed(sqlite, 9, 'failed');
    for (const id of ['protected-2', 'protected-3']) {
      sqlite
        .prepare(
          `INSERT INTO nodes (id, user_id, status, node_role, node_class, created_at, updated_at) VALUES (?, 'user-1', 'running', 'workspace', 'managed', ?, ?)`
        )
        .run(id, node.created_at, node.created_at);
      sqlite
        .prepare(
          `INSERT INTO tasks (id, auto_provisioned_node_id, created_at, updated_at) VALUES (?, ?, ?, ?)`
        )
        .run(`task-${id}`, id, node.created_at, node.created_at);
      sqlite
        .prepare(
          `INSERT INTO workspaces (id, node_id, user_id, status, created_at, updated_at) VALUES (?, ?, 'user-1', 'running', ?, ?)`
        )
        .run(`workspace-${id}`, id, node.created_at, node.created_at);
    }
    for (const id of ['empty-1', 'empty-2']) {
      sqlite
        .prepare(
          `INSERT INTO nodes (id, user_id, status, node_role, node_class, created_at, updated_at) VALUES (?, 'user-1', 'running', 'workspace', 'managed', '2026-09-30T01:00:00.000Z', '2026-09-30T01:00:00.000Z')`
        )
        .run(id);
      sqlite
        .prepare(
          `INSERT INTO tasks (id, auto_provisioned_node_id, created_at, updated_at) VALUES (?, ?, ?, ?)`
        )
        .run(`task-${id}`, id, node.created_at, node.created_at);
    }
    const config = { ...resolveCleanupConfig(env), nodeSweepLimit: 1 };
    for (let i = 0; i < 2; i++) {
      const result = emptyResult();
      await sweepMaxLifetimeNodes(drizzle(env.DATABASE, { schema }), env, now, config, result);
      expect(result).toMatchObject({ lifetimeDestroyed: 1, errors: 0 });
    }
    expect(mocks.delete.mock.calls.map((call) => call[0])).toEqual(['empty-1', 'empty-2']);
    expect(
      sqlite.prepare(`SELECT id FROM nodes WHERE status = 'deleted' ORDER BY id`).pluck().all()
    ).toEqual(['empty-1', 'empty-2']);
    expect(
      sqlite.prepare(`SELECT count(*) FROM nodes WHERE status = 'running'`).pluck().get()
    ).toBe(3);
  });

  it('refuses the node cleanup claim even after preservation escalation', async () => {
    seed(sqlite, 9, 'failed');
    const claimed = await claimNodeForCleanup(env, node, now.toISOString(), {
      allowActiveWorkspaces: false,
      requireWorkspaceIdle: false,
    });
    expect(claimed).toBe(false);
    expect(sqlite.prepare(`SELECT status FROM nodes WHERE id = 'old-node'`).pluck().get()).toBe(
      'running'
    );

    await prepareAbsoluteLifetimeRelease(env, node, now, resolveCleanupConfig(env));
    sqlite.prepare(`UPDATE node_health_events SET created_at = '2026-10-01T05:00:00.000Z'`).run();
    await prepareAbsoluteLifetimeRelease(env, node, now, resolveCleanupConfig(env));
    expect(
      await claimNodeForCleanup(env, node, now.toISOString(), {
        allowActiveWorkspaces: false,
        requireWorkspaceIdle: false,
      })
    ).toBe(false);
  });
});
