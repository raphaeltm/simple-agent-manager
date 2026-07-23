/**
 * Zombie-sweep regression for user-owned (BYO) nodes (rule 47, architecture-critique #2/#10).
 *
 * The node-cleanup cron is the real teardown backstop. Every destroy/flag candidate query must
 * exclude node_class='user-owned', or an enrolled machine SAM does not own could be swept. This
 * test runs the sweep against a FAITHFUL in-memory DB (so the WHERE-clause guard actually filters)
 * TWICE, and asserts BYO nodes are never selected for destruction/flagging while equivalent managed
 * nodes ARE — proving the guard is discriminating and the candidate leaves no zombie behind.
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
    return {
      nodeFound: true,
      providerVmDeleted: true,
      providerVmDeleteSkippedReason: null,
      backendDnsDeleted: false,
      errors: [],
    };
  }),
  stopNodeResources: vi.fn(async (nodeId: string) => {
    stopCalls.push(nodeId);
  }),
}));
vi.mock('../../../src/services/node-agent', () => ({
  deleteWorkspaceOnNode: vi.fn().mockResolvedValue(undefined),
  stopWorkspaceOnNode: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/services/project-data', () => ({
  stopSession: vi.fn().mockResolvedValue(undefined),
  cleanupWorkspaceActivity: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/services/vm-agent-container', () => ({
  destroyVmAgentContainer: vi.fn().mockResolvedValue(undefined),
}));
const persistErrorCalls: Array<Record<string, unknown>> = [];
vi.mock('../../../src/services/observability', () => ({
  persistError: vi.fn(async (_db: unknown, input: Record<string, unknown>) => {
    persistErrorCalls.push(input);
  }),
}));
vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let sqlite: Database.Database | null = null;
const OLD = '2020-01-01T00:00:00.000Z';

function seedNode(row: {
  id: string;
  nodeClass: 'managed' | 'user-owned';
  status: string;
  warmSince: string | null;
  runtime?: string;
}): void {
  sqlite
    ?.prepare(
      `
      INSERT INTO nodes (id, user_id, name, status, warm_since, node_role, node_class, runtime, created_at, updated_at)
      VALUES (?, 'user-1', ?, ?, ?, 'workspace', ?, ?, ?, ?)
    `
    )
    .run(
      row.id,
      `node-${row.id}`,
      row.status,
      row.warmSince,
      row.nodeClass,
      row.runtime ?? 'vm',
      OLD,
      OLD
    );
}

// A task whose auto_provisioned_node_id points at a node makes the max-lifetime and stopped-handoff
// queries' INNER JOIN admit that node as a candidate (so the node_class guard is what filters it).
function seedAutoProvisionedTask(taskId: string, nodeId: string): void {
  sqlite
    ?.prepare(
      `INSERT INTO tasks (id, workspace_id, status, auto_provisioned_node_id, updated_at) VALUES (?, NULL, 'completed', ?, ?)`
    )
    .run(taskId, nodeId, OLD);
}

// A workspace + terminal task on it makes the cf-container terminal-task query admit the node.
function seedWorkspaceWithTerminalTask(wsId: string, nodeId: string, taskId: string): void {
  sqlite
    ?.prepare(
      `INSERT INTO workspaces (id, node_id, user_id, status, created_at, updated_at) VALUES (?, ?, 'user-1', 'running', ?, ?)`
    )
    .run(wsId, nodeId, OLD, OLD);
  sqlite
    ?.prepare(
      `INSERT INTO tasks (id, workspace_id, status, auto_provisioned_node_id, updated_at) VALUES (?, ?, 'completed', NULL, ?)`
    )
    .run(taskId, wsId, OLD);
}

function makeEnv(): Env {
  const d1 = createSqliteD1(sqlite as Database.Database);
  return { DATABASE: d1, OBSERVABILITY_DATABASE: d1 } as unknown as Env;
}

beforeEach(() => {
  deleteCalls.length = 0;
  stopCalls.length = 0;
  persistErrorCalls.length = 0;
  sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL,
      warm_since TEXT, node_role TEXT NOT NULL DEFAULT 'workspace', node_class TEXT NOT NULL DEFAULT 'managed',
      runtime TEXT NOT NULL DEFAULT 'vm', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY, node_id TEXT, user_id TEXT, status TEXT NOT NULL,
      project_id TEXT, chat_session_id TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, workspace_id TEXT, status TEXT, auto_provisioned_node_id TEXT, updated_at TEXT
    );
  `);
});

afterEach(() => {
  sqlite?.close();
  sqlite = null;
  vi.clearAllMocks();
});

describe('node-cleanup sweep excludes user-owned nodes', () => {
  it('stale-warm: destroys a managed warm node but never a user-owned warm node (2 sweeps)', async () => {
    seedNode({ id: 'managed-warm', nodeClass: 'managed', status: 'running', warmSince: OLD });
    seedNode({ id: 'byo-warm', nodeClass: 'user-owned', status: 'running', warmSince: OLD });
    const env = makeEnv();

    await runNodeCleanupSweep(env);
    await runNodeCleanupSweep(env); // rule 47: the BYO node must not reappear as a candidate

    expect(deleteCalls).toContain('managed-warm');
    expect(deleteCalls).not.toContain('byo-warm');
    expect(stopCalls).not.toContain('byo-warm');
  });

  it('orphan detection: flags a managed orphan but never a user-owned node', async () => {
    // Orphaned = running, no warm_since, stale updated_at, no active workspaces.
    seedNode({ id: 'managed-orphan', nodeClass: 'managed', status: 'running', warmSince: null });
    seedNode({ id: 'byo-orphan', nodeClass: 'user-owned', status: 'running', warmSince: null });
    const env = makeEnv();

    const result = await runNodeCleanupSweep(env);
    await runNodeCleanupSweep(env);

    const flaggedNodeIds = persistErrorCalls.map((e) => e.nodeId);
    expect(flaggedNodeIds).toContain('managed-orphan');
    expect(flaggedNodeIds).not.toContain('byo-orphan');
    expect(result.orphanedNodesFlagged).toBe(1);
    expect(deleteCalls).not.toContain('byo-orphan');
  });

  it('stopped-handoff: destroys a managed stopped auto-provisioned node but never a user-owned one', async () => {
    // stopNodeResources marks a BYO node 'stopped'; the stopped-handoff sweep (INNER JOIN tasks on
    // auto_provisioned_node_id) must destroy the managed one and skip the BYO one. Seeding the task
    // rows is essential — without them the INNER JOIN admits nobody and the guard is never exercised.
    seedNode({ id: 'managed-stopped', nodeClass: 'managed', status: 'stopped', warmSince: null });
    seedNode({ id: 'byo-stopped', nodeClass: 'user-owned', status: 'stopped', warmSince: null });
    seedAutoProvisionedTask('task-ms', 'managed-stopped');
    seedAutoProvisionedTask('task-bs', 'byo-stopped');
    const env = makeEnv();

    await runNodeCleanupSweep(env);
    await runNodeCleanupSweep(env);

    expect(deleteCalls).toContain('managed-stopped'); // control proves the query IS reached
    expect(deleteCalls).not.toContain('byo-stopped');
    expect(stopCalls).not.toContain('byo-stopped');
  });

  it('max-lifetime: destroys a managed auto-provisioned node past lifetime but never a user-owned one', async () => {
    // max-lifetime query: INNER JOIN tasks on auto_provisioned_node_id, running node, old created_at.
    seedNode({ id: 'managed-old', nodeClass: 'managed', status: 'running', warmSince: null });
    seedNode({ id: 'byo-old', nodeClass: 'user-owned', status: 'running', warmSince: null });
    seedAutoProvisionedTask('task-mo', 'managed-old');
    seedAutoProvisionedTask('task-bo', 'byo-old');
    const env = makeEnv();

    await runNodeCleanupSweep(env);
    await runNodeCleanupSweep(env);

    expect(deleteCalls).toContain('managed-old'); // control
    expect(deleteCalls).not.toContain('byo-old');
  });

  it('cf-container terminal-task: stops a managed container node but never a user-owned one', async () => {
    // cf-container query: INNER JOIN workspaces + tasks (terminal task on the workspace), runtime cf-container.
    seedNode({
      id: 'managed-cf',
      nodeClass: 'managed',
      status: 'running',
      warmSince: null,
      runtime: 'cf-container',
    });
    seedNode({
      id: 'byo-cf',
      nodeClass: 'user-owned',
      status: 'running',
      warmSince: null,
      runtime: 'cf-container',
    });
    seedWorkspaceWithTerminalTask('ws-mcf', 'managed-cf', 'task-mcf');
    seedWorkspaceWithTerminalTask('ws-bcf', 'byo-cf', 'task-bcf');
    const env = makeEnv();

    await runNodeCleanupSweep(env);
    await runNodeCleanupSweep(env);

    expect(stopCalls).toContain('managed-cf'); // control proves the cf-container query IS reached
    expect(stopCalls).not.toContain('byo-cf');
  });
});
