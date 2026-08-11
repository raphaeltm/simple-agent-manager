import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  createWorkspaceOnNode: vi.fn(),
  provisionNode: vi.fn(),
  recordActivityEvent: vi.fn(),
  signCallbackToken: vi.fn(),
  waitForNodeAgentReady: vi.fn(),
}));

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => (_context: unknown, next: () => Promise<void>) => next(),
  requireApproved: () => (_context: unknown, next: () => Promise<void>) => next(),
  getAuth: () => ({
    user: {
      id: 'user-1',
      name: 'User One',
      email: 'user-1@example.com',
      status: 'active',
      role: 'user',
    },
  }),
  getUserId: () => 'user-1',
}));
vi.mock('../../../src/services/node-agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/node-agent')>()),
  createWorkspaceOnNode: mocks.createWorkspaceOnNode,
  waitForNodeAgentReady: mocks.waitForNodeAgentReady,
}));
vi.mock('../../../src/services/nodes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/nodes')>()),
  provisionNode: mocks.provisionNode,
}));
vi.mock('../../../src/services/jwt', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/jwt')>()),
  signCallbackToken: mocks.signCallbackToken,
}));
vi.mock('../../../src/services/project-data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/project-data')>()),
  createSession: mocks.createSession,
  recordActivityEvent: mocks.recordActivityEvent,
}));

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { crudRoutes } from '../../../src/routes/workspaces/crud';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const NODE_ID = '01KZR2JAP92AK3SKW951E4H21M';
const REQUIRED_VERSION = 'a'.repeat(40);

describe('manual workspace placement route vertical slice', () => {
  let sqlite: Database.Database;
  let env: Env;
  let app: Hono<{ Bindings: Env }>;

  beforeEach(() => {
    vi.clearAllMocks();
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    env = {
      DATABASE: createSqliteD1(sqlite),
      BASE_DOMAIN: 'example.test',
      VM_AGENT_REQUIRED_VERSION: REQUIRED_VERSION,
    } as Env;
    app = new Hono<{ Bindings: Env }>();
    app.onError((error, context) =>
      error instanceof AppError
        ? context.json(error.toJSON(), error.statusCode as never)
        : context.json({ error: 'INTERNAL_ERROR', message: error.message }, 500)
    );
    app.route('/api/workspaces', crudRoutes);

    const now = '2026-08-11T00:00:00.000Z';
    sqlite
      .prepare(
        `INSERT INTO projects
           (id, user_id, name, normalized_name, installation_id, repository,
            default_branch, repo_provider, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'main', 'artifacts', 'active', ?, ?, ?)`
      )
      .run(
        'project-1',
        'user-1',
        'Placement project',
        'placement project',
        'artifacts-installation',
        'artifacts/placement-project',
        'user-1',
        now,
        now
      );
    sqlite
      .prepare(
        `INSERT INTO project_members
           (project_id, user_id, role, status, created_at, updated_at)
         VALUES (?, ?, 'owner', 'active', ?, ?)`
      )
      .run('project-1', 'user-1', now, now);
    sqlite
      .prepare(
        `INSERT INTO nodes
           (id, user_id, name, status, vm_size, vm_location, runtime, node_role,
            node_mode, health_status, heartbeat_stale_after_seconds,
            last_heartbeat_at, agent_ready_at, agent_version, last_metrics,
            credential_source, created_at, updated_at)
         VALUES (?, ?, ?, 'running', 'medium', 'hel1', 'vm', 'workspace',
                 'shared', 'healthy', 180, ?, ?, ?, ?, 'user', ?, ?)`
      )
      .run(
        NODE_ID,
        'user-1',
        'Existing node',
        new Date().toISOString(),
        new Date().toISOString(),
        REQUIRED_VERSION,
        JSON.stringify({ cpuLoadAvg1: 2, memoryPercent: 10 }),
        now,
        now
      );

    mocks.createSession.mockResolvedValue('session-1');
    mocks.recordActivityEvent.mockResolvedValue(undefined);
    mocks.signCallbackToken.mockResolvedValue('callback-token');
    mocks.provisionNode.mockResolvedValue(undefined);
    mocks.waitForNodeAgentReady.mockResolvedValue(undefined);
  });

  afterEach(() => sqlite.close());

  it('persists selected-node reuse to its workspace and task before VM scheduling', async () => {
    const scheduleObservations: Array<{
      workspace: Record<string, unknown>;
      task: Record<string, unknown>;
    }> = [];
    mocks.createWorkspaceOnNode.mockImplementation(async () => {
      const workspace = sqlite
        .prepare(
          `SELECT id, node_id, placement_explanation_json
             FROM workspaces WHERE project_id = ?`
        )
        .get('project-1') as Record<string, unknown>;
      const task = sqlite
        .prepare(
          `SELECT id, workspace_id, placement_explanation_json
             FROM tasks WHERE project_id = ?`
        )
        .get('project-1') as Record<string, unknown>;
      scheduleObservations.push({ workspace, task });
      return { workspaceId: workspace.id, status: 'creating' };
    });
    const waitUntilPromises: Promise<unknown>[] = [];
    const executionContext = {
      waitUntil: vi.fn((promise: Promise<unknown>) => waitUntilPromises.push(promise)),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;

    const response = await app.request(
      '/api/workspaces',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Reused workspace',
          projectId: 'project-1',
          nodeId: NODE_ID,
          vmSize: 'medium',
          vmLocation: 'hel1',
        }),
      },
      env,
      executionContext
    );
    await Promise.all(waitUntilPromises);

    expect(response.status).toBe(201);
    expect(mocks.createWorkspaceOnNode).toHaveBeenCalledOnce();
    expect(scheduleObservations).toHaveLength(1);
    const [{ workspace, task }] = scheduleObservations;
    expect(task.workspace_id).toBe(workspace.id);
    for (const row of [workspace, task]) {
      expect(JSON.parse(row.placement_explanation_json as string)).toMatchObject({
        schemaVersion: 2,
        outcome: 'reused',
        selectionPath: 'manual',
        selectedNodeId: NODE_ID,
        evaluatedNodes: [{ nodeId: NODE_ID, path: 'manual', accepted: true, rejectionReasons: [] }],
      });
    }
  });

  it('carries real credential resolution and create-node output into started then succeeded records', async () => {
    const now = '2026-08-11T00:00:00.000Z';
    sqlite
      .prepare(
        `INSERT INTO credentials
           (id, user_id, provider, credential_type, credential_kind, is_active,
            encrypted_token, iv, created_at, updated_at)
         VALUES (?, ?, 'hetzner', 'cloud-provider', 'api-key', 1, ?, ?, ?, ?)`
      )
      .run('credential-1', 'user-1', 'encrypted-not-read-by-resolution', 'iv-not-read', now, now);

    let provisionedNodeId: string | null = null;
    mocks.provisionNode.mockImplementation(async (nodeId: string) => {
      provisionedNodeId = nodeId;
      const workspace = sqlite
        .prepare(`SELECT placement_explanation_json FROM workspaces WHERE project_id = ?`)
        .get('project-1') as { placement_explanation_json: string };
      const task = sqlite
        .prepare(`SELECT placement_explanation_json FROM tasks WHERE project_id = ?`)
        .get('project-1') as { placement_explanation_json: string };
      for (const row of [workspace, task]) {
        expect(JSON.parse(row.placement_explanation_json)).toMatchObject({
          schemaVersion: 2,
          outcome: 'provisioned',
          selectionPath: 'provisioning',
          selectedNodeId: nodeId,
          provisioningAttempts: [{ vmSize: 'medium', vmLocation: 'hel1', outcome: 'started' }],
        });
      }
      sqlite.prepare(`UPDATE nodes SET status = 'running' WHERE id = ?`).run(nodeId);
    });
    mocks.createWorkspaceOnNode.mockImplementation(async (nodeId: string) => {
      const workspace = sqlite
        .prepare(`SELECT placement_explanation_json FROM workspaces WHERE project_id = ?`)
        .get('project-1') as { placement_explanation_json: string };
      const task = sqlite
        .prepare(`SELECT placement_explanation_json FROM tasks WHERE project_id = ?`)
        .get('project-1') as { placement_explanation_json: string };
      for (const row of [workspace, task]) {
        expect(JSON.parse(row.placement_explanation_json)).toMatchObject({
          outcome: 'provisioned',
          selectedNodeId: nodeId,
          provisioningAttempts: [{ outcome: 'started' }, { outcome: 'succeeded' }],
        });
      }
      return { workspaceId: 'workspace-new', status: 'creating' };
    });
    const waitUntilPromises: Promise<unknown>[] = [];
    const executionContext = {
      waitUntil: vi.fn((promise: Promise<unknown>) => waitUntilPromises.push(promise)),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;

    const response = await app.request(
      '/api/workspaces',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Provisioned workspace',
          projectId: 'project-1',
          provider: 'hetzner',
          vmSize: 'medium',
          vmLocation: 'hel1',
        }),
      },
      env,
      executionContext
    );
    await Promise.all(waitUntilPromises);

    expect(response.status).toBe(201);
    expect(provisionedNodeId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(mocks.provisionNode).toHaveBeenCalledOnce();
    expect(mocks.waitForNodeAgentReady).toHaveBeenCalledWith(provisionedNodeId, env);
    expect(mocks.createWorkspaceOnNode).toHaveBeenCalledOnce();
  });
});
