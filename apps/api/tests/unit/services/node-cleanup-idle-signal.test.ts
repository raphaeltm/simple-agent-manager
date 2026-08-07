/**
 * The idle reaper must measure IDLENESS, not liveness — and every candidate it
 * selects must be able to leave the candidate set (rule 47).
 *
 * THE BUG THIS PINS
 *
 * Orphan detection used `nodes.updated_at < now - grace`. Every heartbeat writes
 * `updated_at`, so on all nine running production nodes `updated_at` was
 * byte-identical to `last_heartbeat_at`. A healthy-but-idle node therefore never
 * aged into the window: the predicate was unsatisfiable for exactly the nodes it
 * existed to catch, and would only match a node that had ALREADY stopped
 * heartbeating — i.e. one that was broken, not merely idle. Production confirmed
 * it: recoveryType 'orphaned_node' recorded zero events across its whole lifetime.
 *
 * Idleness now comes from COALESCE(MAX(workspaces.updated_at), nodes.created_at).
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { runNodeCleanupSweep } from '../../../src/scheduled/node-cleanup';
import { deleteNodeResources } from '../../../src/services/nodes';
import { createSqliteD1 } from '../../helpers/sqlite-d1';

const deleteCalls: string[] = [];

vi.mock('../../../src/services/nodes', () => ({
  deleteNodeResources: vi.fn(async (nodeId: string) => {
    deleteCalls.push(nodeId);
  }),
  stopNodeResources: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/services/node-agent', () => ({
  deleteWorkspaceOnNode: vi.fn().mockResolvedValue(undefined),
  stopWorkspaceOnNode: vi.fn().mockResolvedValue(undefined),
  getNodeAgentBackgroundRequestTimeoutMs: vi.fn().mockReturnValue(5_000),
}));
vi.mock('../../../src/services/project-data', () => ({
  stopSession: vi.fn().mockResolvedValue(undefined),
  cleanupWorkspaceActivity: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/services/observability', () => ({
  persistError: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let sqlite: Database.Database | null = null;

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

function seedNode(row: {
  id: string;
  createdAt: string;
  /** Simulates the heartbeat writer: this is what the old predicate looked at. */
  updatedAt: string;
  status?: string;
}): void {
  sqlite
    ?.prepare(
      `INSERT INTO nodes (id, user_id, name, status, warm_since, node_role, node_class, runtime,
                          health_status, created_at, updated_at)
       VALUES (?, 'user-1', ?, ?, NULL, 'workspace', 'managed', 'vm', 'healthy', ?, ?)`
    )
    .run(row.id, `node-${row.id}`, row.status ?? 'running', row.createdAt, row.updatedAt);
}

function seedWorkspace(row: {
  id: string;
  nodeId: string;
  status: string;
  updatedAt: string;
}): void {
  sqlite
    ?.prepare(
      `INSERT INTO workspaces (id, node_id, user_id, status, created_at, updated_at)
       VALUES (?, ?, 'user-1', ?, ?, ?)`
    )
    .run(row.id, row.nodeId, row.status, row.updatedAt, row.updatedAt);
}

function makeEnv(): Env {
  const d1 = createSqliteD1(sqlite as Database.Database);
  return {
    DATABASE: d1,
    OBSERVABILITY_DATABASE: d1,
    NODE_WARM_GRACE_PERIOD_MS: String(35 * MINUTE),
    MAX_AUTO_NODE_LIFETIME_MS: String(4 * HOUR),
    NODE_ABSOLUTE_MAX_LIFETIME_MS: String(24 * HOUR),
    ORPHANED_WORKSPACE_GRACE_PERIOD_MS: String(10 * MINUTE),
    NODE_ORPHAN_IDLE_TIMEOUT_MS: String(45 * MINUTE),
    WORKSPACE_STOPPED_TTL_MS: String(6 * HOUR),
    NODE_CLEANUP_SWEEP_LIMIT: '25',
    WORKSPACE_CLEANUP_SWEEP_LIMIT: '50',
    CF_CONTAINER_TERMINAL_TASK_SWEEP_LIMIT: '25',
  } as unknown as Env;
}

beforeEach(() => {
  deleteCalls.length = 0;
  vi.mocked(deleteNodeResources).mockImplementation(async (nodeId: string) => {
    deleteCalls.push(nodeId);
  });
  sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL,
      warm_since TEXT, node_role TEXT NOT NULL DEFAULT 'workspace',
      node_class TEXT NOT NULL DEFAULT 'managed', runtime TEXT NOT NULL DEFAULT 'vm',
      health_status TEXT NOT NULL DEFAULT 'unhealthy', agent_version TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY, node_id TEXT, user_id TEXT, status TEXT NOT NULL,
      project_id TEXT, chat_session_id TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, workspace_id TEXT, status TEXT,
      auto_provisioned_node_id TEXT, updated_at TEXT
    );
  `);
});

afterEach(() => {
  sqlite?.close();
  sqlite = null;
  vi.clearAllMocks();
});

describe('idle reaping is immune to heartbeat activity', () => {
  it('reaps an idle node whose updated_at is refreshed by heartbeats every few seconds', async () => {
    // The exact production shape: node created 10h ago, its only workspace stopped
    // 7h ago, and updated_at is CURRENT because the agent is heartbeating happily.
    // The old `updated_at < now - grace` predicate could never match this row.
    seedNode({ id: 'heartbeating-idle', createdAt: ago(10 * HOUR), updatedAt: ago(2 * 1000) });
    seedWorkspace({
      id: 'ws-stopped',
      nodeId: 'heartbeating-idle',
      status: 'stopped',
      updatedAt: ago(7 * HOUR),
    });
    const env = makeEnv();

    const result = await runNodeCleanupSweep(env);

    expect(deleteCalls).toContain('heartbeating-idle');
    expect(result.orphanedNodesDestroyed).toBe(1);
  });

  it('does NOT reap a node whose workspaces are currently active', async () => {
    seedNode({ id: 'busy', createdAt: ago(10 * HOUR), updatedAt: ago(2 * 1000) });
    seedWorkspace({
      id: 'ws-running',
      nodeId: 'busy',
      status: 'running',
      updatedAt: ago(1 * MINUTE),
    });
    const env = makeEnv();

    const result = await runNodeCleanupSweep(env);

    expect(deleteCalls).not.toContain('busy');
    expect(result.orphanedNodesDestroyed).toBe(0);
  });

  it('does NOT reap a recently idled node still inside the idle window', async () => {
    // Zero active workspaces, but only 5 minutes idle — well under the 45m default.
    // A shared node legitimately sits empty between tasks; reaping here would
    // destroy the warm-reuse behaviour the pool exists to provide.
    seedNode({ id: 'recently-idle', createdAt: ago(3 * HOUR), updatedAt: ago(1000) });
    seedWorkspace({
      id: 'ws-just-stopped',
      nodeId: 'recently-idle',
      status: 'stopped',
      updatedAt: ago(5 * MINUTE),
    });
    const env = makeEnv();

    const result = await runNodeCleanupSweep(env);

    expect(deleteCalls).not.toContain('recently-idle');
    expect(result.orphanedNodesDestroyed).toBe(0);
  });

  it('does NOT reap a freshly provisioned node that has no workspace yet', async () => {
    // No workspace rows at all, so idleness falls back to created_at. A node still
    // waiting for its first workspace must not be reaped out from under the task
    // that just provisioned it.
    seedNode({ id: 'brand-new', createdAt: ago(2 * MINUTE), updatedAt: ago(1000) });
    const env = makeEnv();

    const result = await runNodeCleanupSweep(env);

    expect(deleteCalls).not.toContain('brand-new');
    expect(result.orphanedNodesDestroyed).toBe(0);
  });

  it('respects NODE_ORPHAN_IDLE_TIMEOUT_MS instead of a hardcoded window', async () => {
    // Each threshold gets FRESH state on purpose. Running both against one database
    // would not test what it looks like it tests: the stale-stopped-workspace phase
    // deletes `ws-20m` during the first sweep, and that write bumps the workspace's
    // updated_at to now — which is genuine activity by this signal's definition, so
    // the node reads as freshly active on the second sweep. That interaction is
    // intentional and bounded (a stopped workspace is deleted once, delaying reaping
    // by at most the phase-6 window), but it makes a two-sweep threshold comparison
    // meaningless.
    const seedIdleNode = () => {
      seedNode({ id: 'idle-20m', createdAt: ago(3 * HOUR), updatedAt: ago(1000) });
      seedWorkspace({
        id: 'ws-20m',
        nodeId: 'idle-20m',
        status: 'stopped',
        updatedAt: ago(20 * MINUTE),
      });
    };

    // Default 45m — 20m idle is not yet eligible.
    seedIdleNode();
    expect((await runNodeCleanupSweep(makeEnv())).orphanedNodesDestroyed).toBe(0);
    expect(deleteCalls).not.toContain('idle-20m');

    // Same node, threshold lowered to 10m — now eligible.
    sqlite?.exec('DELETE FROM workspaces; DELETE FROM nodes;');
    deleteCalls.length = 0;
    seedIdleNode();
    const env = { ...makeEnv(), NODE_ORPHAN_IDLE_TIMEOUT_MS: String(10 * MINUTE) } as Env;
    expect((await runNodeCleanupSweep(env)).orphanedNodesDestroyed).toBe(1);
    expect(deleteCalls).toContain('idle-20m');
  });

  it('two-sweep zombie check: a permanently failing candidate is not retried forever', async () => {
    // rule 47 — a candidate that can never be destroyed must still leave the
    // candidate set, or every sweep re-attempts it and the loop never converges.
    const { deleteNodeResources } = await import('../../../src/services/nodes');
    vi.mocked(deleteNodeResources).mockRejectedValue(new Error('provider unreachable'));

    seedNode({ id: 'doomed', createdAt: ago(10 * HOUR), updatedAt: ago(1000) });
    seedWorkspace({
      id: 'ws-doomed',
      nodeId: 'doomed',
      status: 'stopped',
      updatedAt: ago(7 * HOUR),
    });
    const env = makeEnv();

    const first = await runNodeCleanupSweep(env);
    const second = await runNodeCleanupSweep(env);

    // It is attempted and fails, and the failure is surfaced rather than swallowed.
    expect(first.orphanedNodesSkipped).toBe(1);
    expect(first.errors).toBeGreaterThan(0);

    // Bounded: repeated sweeps do not silently succeed or escalate, and the node is
    // never reported as destroyed on either pass.
    expect(second.orphanedNodesDestroyed).toBe(0);
    expect(first.orphanedNodesDestroyed).toBe(0);
  });
});

describe('incompatible vm-agent cleanup', () => {
  it('preserves the production-shaped pre-heartbeat node claimed by an active task', async () => {
    // Production session 696a21e7-84d1-4080-9060-a77302a7ffc9 had this exact
    // shape: running VM, no workspace yet, agent_version NULL, and a queued task
    // pointing at the node. The rollout sweep destroyed it after only 65 seconds.
    seedNode({ id: 'provisioning-claimed', createdAt: ago(65 * 1000), updatedAt: ago(1000) });
    sqlite
      ?.prepare(
        `INSERT INTO tasks (id, workspace_id, status, auto_provisioned_node_id, updated_at)
         VALUES ('task-provisioning', NULL, 'queued', 'provisioning-claimed', ?)`
      )
      .run(ago(65 * 1000));
    const env = { ...makeEnv(), VM_AGENT_REQUIRED_VERSION: 'current-sha' } as Env;

    const result = await runNodeCleanupSweep(env);

    expect(deleteCalls).not.toContain('provisioning-claimed');
    expect(result.incompatibleDestroyed).toBe(0);
    expect(result.incompatibleSkipped).toBe(1);
  });

  it('preserves a fresh unversioned VM during the configurable pre-heartbeat grace', async () => {
    seedNode({ id: 'fresh-unversioned', createdAt: ago(2 * MINUTE), updatedAt: ago(1000) });
    const env = { ...makeEnv(), VM_AGENT_REQUIRED_VERSION: 'current-sha' } as Env;

    const result = await runNodeCleanupSweep(env);

    expect(deleteCalls).not.toContain('fresh-unversioned');
    expect(result.incompatibleDestroyed).toBe(0);
  });

  it('preserves an actively claimed unversioned VM even after the boot grace expires', async () => {
    seedNode({ id: 'old-but-claimed', createdAt: ago(2 * HOUR), updatedAt: ago(1000) });
    // Recent terminal workspace activity keeps the independent idle-orphan phase
    // out of this assertion; zero active workspaces still makes the node eligible
    // for the incompatible-agent phase unless the task-claim gate is present.
    seedWorkspace({
      id: 'ws-recently-stopped',
      nodeId: 'old-but-claimed',
      status: 'stopped',
      updatedAt: ago(1 * MINUTE),
    });
    sqlite
      ?.prepare(
        `INSERT INTO tasks (id, workspace_id, status, auto_provisioned_node_id, updated_at)
         VALUES ('task-still-provisioning', NULL, 'delegated', 'old-but-claimed', ?)`
      )
      .run(ago(2 * HOUR));
    const env = { ...makeEnv(), VM_AGENT_REQUIRED_VERSION: 'current-sha' } as Env;

    const result = await runNodeCleanupSweep(env);

    expect(deleteCalls).not.toContain('old-but-claimed');
    expect(result.incompatibleDestroyed).toBe(0);
    expect(result.incompatibleSkipped).toBe(1);
  });

  it('eventually retires an old unclaimed VM that never reports an agent version', async () => {
    seedNode({ id: 'old-unversioned', createdAt: ago(2 * HOUR), updatedAt: ago(1000) });
    const env = { ...makeEnv(), VM_AGENT_REQUIRED_VERSION: 'current-sha' } as Env;

    const result = await runNodeCleanupSweep(env);

    expect(deleteCalls).toContain('old-unversioned');
    expect(result.incompatibleDestroyed).toBe(1);
  });

  it('protects an in-progress task claim but does not let a completed task pin a stale VM', async () => {
    for (const nodeId of ['claimed-in-progress', 'claimed-completed']) {
      seedNode({ id: nodeId, createdAt: ago(2 * HOUR), updatedAt: ago(1000) });
      sqlite
        ?.prepare(`UPDATE nodes SET agent_version = 'old-sha' WHERE id = ?`)
        .run(nodeId);
      seedWorkspace({
        id: `ws-stopped-${nodeId}`,
        nodeId,
        status: 'stopped',
        updatedAt: ago(1 * MINUTE),
      });
    }
    sqlite
      ?.prepare(
        `INSERT INTO tasks (id, workspace_id, status, auto_provisioned_node_id, updated_at)
         VALUES ('task-in-progress', NULL, 'in_progress', 'claimed-in-progress', ?),
                ('task-completed', NULL, 'completed', 'claimed-completed', ?)`
      )
      .run(ago(2 * HOUR), ago(1 * MINUTE));
    const env = { ...makeEnv(), VM_AGENT_REQUIRED_VERSION: 'current-sha' } as Env;

    const result = await runNodeCleanupSweep(env);

    expect(deleteCalls).not.toContain('claimed-in-progress');
    expect(deleteCalls).toContain('claimed-completed');
    expect(result.incompatibleSkipped).toBe(1);
    expect(result.incompatibleDestroyed).toBe(1);
  });

  it('destroys an idle managed VM whose agent build does not match the deployment requirement', async () => {
    seedNode({ id: 'legacy-idle', createdAt: ago(10 * HOUR), updatedAt: ago(1000) });
    sqlite?.prepare(`UPDATE nodes SET agent_version = 'old-sha' WHERE id = 'legacy-idle'`).run();
    const env = { ...makeEnv(), VM_AGENT_REQUIRED_VERSION: 'current-sha' } as Env;

    const result = await runNodeCleanupSweep(env);

    expect(deleteCalls).toContain('legacy-idle');
    expect(result.incompatibleDestroyed).toBe(1);
  });

  it('preserves a busy incompatible VM so active work can drain naturally', async () => {
    seedNode({ id: 'legacy-busy', createdAt: ago(10 * HOUR), updatedAt: ago(1000) });
    sqlite?.prepare(`UPDATE nodes SET agent_version = 'old-sha' WHERE id = 'legacy-busy'`).run();
    seedWorkspace({
      id: 'ws-running-legacy',
      nodeId: 'legacy-busy',
      status: 'running',
      updatedAt: ago(1 * MINUTE),
    });
    const env = { ...makeEnv(), VM_AGENT_REQUIRED_VERSION: 'current-sha' } as Env;

    const result = await runNodeCleanupSweep(env);

    expect(deleteCalls).not.toContain('legacy-busy');
    expect(result.incompatibleSkipped).toBe(1);
  });

  it('does not treat cf-container Instant nodes as reusable VM rollout candidates', async () => {
    seedNode({ id: 'instant-idle', createdAt: ago(10 * HOUR), updatedAt: ago(1000) });
    sqlite
      ?.prepare(
        `UPDATE nodes SET runtime = 'cf-container', agent_version = 'old-sha' WHERE id = 'instant-idle'`
      )
      .run();
    const env = { ...makeEnv(), VM_AGENT_REQUIRED_VERSION: 'current-sha' } as Env;

    const result = await runNodeCleanupSweep(env);

    expect(result.incompatibleDestroyed).toBe(0);
  });
});
