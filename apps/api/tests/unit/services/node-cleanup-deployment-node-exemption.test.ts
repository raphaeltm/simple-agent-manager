/**
 * Behavioral proof that the cleanup sweep never destroys a deployment node.
 *
 * WHY THIS SUITE EXISTS
 *
 * On 2026-08-06 production held three nodes that looked exactly like textbook
 * orphans: status='running', zero workspace rows, alive for 18-26 days. They were
 * node_role='deployment', and each backed an ACTIVE deployment_environments row —
 * they run users' docker compose applications. Deployment nodes never host
 * workspaces, so "running node with zero live workspaces past an idle threshold"
 * matches every healthy deployment node in the fleet, forever.
 *
 * A reaper written to that description would have destroyed three users' live
 * production applications on its first run.
 *
 * These tests run the REAL sweep against a REAL SQLite database. Every candidate
 * query must reject the deployment node, and each test carries a workspace-role
 * control node proving the query was actually reached — otherwise "nothing was
 * destroyed" could simply mean "nothing matched anything", and the suite would pass
 * against a reaper with no role gate at all.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { runNodeCleanupSweep } from '../../../src/scheduled/node-cleanup';
import { createSqliteD1 } from '../../helpers/sqlite-d1';

const deleteCalls: string[] = [];
const stopCalls: string[] = [];

vi.mock('../../../src/services/nodes', () => ({
  deleteNodeResources: vi.fn(async (nodeId: string) => {
    deleteCalls.push(nodeId);
  }),
  stopNodeResources: vi.fn(async (nodeId: string) => {
    stopCalls.push(nodeId);
  }),
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

/** Old enough to clear every age/idle threshold in the sweep. */
const OLD = '2020-01-01T00:00:00.000Z';

function seedNode(row: {
  id: string;
  nodeRole: 'workspace' | 'deployment';
  status: string;
  warmSince?: string | null;
}): void {
  sqlite
    ?.prepare(
      `INSERT INTO nodes (id, user_id, name, status, warm_since, node_role, node_class, runtime,
                          health_status, created_at, updated_at)
       VALUES (?, 'user-1', ?, ?, ?, ?, 'managed', 'vm', 'healthy', ?, ?)`
    )
    .run(row.id, `node-${row.id}`, row.status, row.warmSince ?? null, row.nodeRole, OLD, OLD);
}

function seedAutoProvisionedTask(taskId: string, nodeId: string): void {
  sqlite
    ?.prepare(
      `INSERT INTO tasks (id, workspace_id, status, auto_provisioned_node_id, updated_at)
       VALUES (?, NULL, 'completed', ?, ?)`
    )
    .run(taskId, nodeId, OLD);
}

function makeEnv(): Env {
  const d1 = createSqliteD1(sqlite as Database.Database);
  return { DATABASE: d1, OBSERVABILITY_DATABASE: d1 } as unknown as Env;
}

beforeEach(() => {
  deleteCalls.length = 0;
  stopCalls.length = 0;
  sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL,
      warm_since TEXT, node_role TEXT NOT NULL DEFAULT 'workspace',
      node_class TEXT NOT NULL DEFAULT 'managed', runtime TEXT NOT NULL DEFAULT 'vm',
      health_status TEXT NOT NULL DEFAULT 'unhealthy',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, cleanup_backoff_until TEXT
    );
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY, node_id TEXT, user_id TEXT, status TEXT NOT NULL,
      project_id TEXT, chat_session_id TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, workspace_id TEXT, status TEXT,
      auto_provisioned_node_id TEXT, updated_at TEXT
    );
    CREATE TABLE session_snapshots (
      chat_session_id TEXT PRIMARY KEY, status TEXT NOT NULL,
      degradation TEXT NOT NULL, expires_at TEXT NOT NULL
    );
  `);
});

afterEach(() => {
  sqlite?.close();
  sqlite = null;
  vi.clearAllMocks();
});

describe('node-cleanup sweep never destroys deployment nodes', () => {
  it('idle orphan phase: destroys an idle workspace node, never an idle deployment node', async () => {
    // Both are running with zero workspaces and are far past the idle threshold —
    // indistinguishable except by node_role. This is the exact production shape.
    seedNode({ id: 'workspace-idle', nodeRole: 'workspace', status: 'running' });
    seedNode({ id: 'deployment-idle', nodeRole: 'deployment', status: 'running' });
    const env = makeEnv();

    const result = await runNodeCleanupSweep(env);
    await runNodeCleanupSweep(env); // rule 47: must not reappear as a candidate

    // Control — proves the idle-orphan query is reached and does destroy.
    expect(deleteCalls).toContain('workspace-idle');
    expect(result.orphanedNodesDestroyed).toBe(1);

    // The gate. Fails against any reaper missing node_role = 'workspace'.
    expect(deleteCalls).not.toContain('deployment-idle');
    expect(stopCalls).not.toContain('deployment-idle');
  });

  it('max-lifetime phase: never destroys a deployment node past the lifetime ceiling', async () => {
    seedNode({ id: 'workspace-old', nodeRole: 'workspace', status: 'running' });
    seedNode({ id: 'deployment-old', nodeRole: 'deployment', status: 'running' });
    // The INNER JOIN on auto_provisioned_node_id must admit BOTH, so node_role is
    // demonstrably the only thing rejecting the deployment node.
    seedAutoProvisionedTask('task-wo', 'workspace-old');
    seedAutoProvisionedTask('task-do', 'deployment-old');
    const env = makeEnv();

    await runNodeCleanupSweep(env);
    await runNodeCleanupSweep(env);

    expect(deleteCalls).toContain('workspace-old');
    expect(deleteCalls).not.toContain('deployment-old');
  });

  it('stale-warm phase: never destroys a deployment node carrying warm_since', async () => {
    seedNode({
      id: 'workspace-warm',
      nodeRole: 'workspace',
      status: 'running',
      warmSince: OLD,
    });
    seedNode({
      id: 'deployment-warm',
      nodeRole: 'deployment',
      status: 'running',
      warmSince: OLD,
    });
    const env = makeEnv();

    await runNodeCleanupSweep(env);
    await runNodeCleanupSweep(env);

    expect(deleteCalls).toContain('workspace-warm');
    expect(deleteCalls).not.toContain('deployment-warm');
  });

  it('stopped-handoff phase: never destroys a stopped deployment node', async () => {
    seedNode({ id: 'workspace-stopped', nodeRole: 'workspace', status: 'stopped' });
    seedNode({ id: 'deployment-stopped', nodeRole: 'deployment', status: 'stopped' });
    seedAutoProvisionedTask('task-ws', 'workspace-stopped');
    seedAutoProvisionedTask('task-ds', 'deployment-stopped');
    const env = makeEnv();

    await runNodeCleanupSweep(env);
    await runNodeCleanupSweep(env);

    expect(deleteCalls).toContain('workspace-stopped');
    expect(deleteCalls).not.toContain('deployment-stopped');
  });

  it('a deployment node survives repeated sweeps entirely untouched', async () => {
    // The full production shape: a lone deployment node, no workspaces, no tasks,
    // running for a very long time. Nothing in the sweep may ever touch it.
    seedNode({ id: 'deployment-only', nodeRole: 'deployment', status: 'running' });
    const env = makeEnv();

    for (let i = 0; i < 3; i++) {
      const result = await runNodeCleanupSweep(env);
      expect(result.errors).toBe(0);
    }

    expect(deleteCalls).toHaveLength(0);
    expect(stopCalls).toHaveLength(0);

    const row = sqlite?.prepare(`SELECT status FROM nodes WHERE id = ?`).get('deployment-only') as
      | { status: string }
      | undefined;
    expect(row?.status).toBe('running');
  });
});
