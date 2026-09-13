/**
 * Compatibility slice: old task HTTP/wake entry -> real placement -> real DO RPC
 * serialization -> TaskRunner reuse selection -> atomic SQL reservation.
 * Only auth/repository access and DO transport are replaced. No placement,
 * credential, persistence, resource accounting or admission helper is mocked.
 * Schema-derived SQLite proves predicates; shipped migration/FK tests remain separate.
 */
import type { CapacityPlacementSnapshot } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { afterEach, expect, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { StartTaskInput } from '../../../src/durable-objects/task-runner';
import { findNodeWithCapacity } from '../../../src/durable-objects/task-runner/node-selection';
import type {
  TaskRunnerContext,
  TaskRunnerState,
} from '../../../src/durable-objects/task-runner/types';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { capacityPlacementSnapshotDbValues } from '../../../src/services/capacity-placement-snapshot';
import { capacityPlacementSnapshotForCandidate } from '../../../src/services/placement-resolver';
import { reserveWorkspacePlacement } from '../../../src/services/workspace-placement';
import { resolveWorkspaceAdmissionPolicy } from '../../../src/services/workspace-resource-capacity';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';
import {
  seedCloudCredential,
  seedPlatformCloudCredential,
  seedProjectWithMember,
} from './capacity-pool-test-seeds';

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireApproved: () => async (_c: unknown, next: () => Promise<void>) => next(),
  getAuth: () => ({
    user: {
      id: 'user-1',
      name: 'User One',
      email: 'user-1@example.com',
      role: 'user',
      status: 'active',
    },
    session: { id: 'auth-session', token: null, expiresAt: new Date() },
  }),
}));
vi.mock('../../../src/routes/projects/_helpers', async (load) => ({
  ...(await load<typeof import('../../../src/routes/projects/_helpers')>()),
  requireRepositoryUserAccess: vi.fn(async () => undefined),
}));

const { runRoutes } = await import('../../../src/routes/tasks/run');
const databases: Database.Database[] = [];
afterEach(() => {
  databases.splice(0).forEach((database) => database.close());
  vi.clearAllMocks();
});

export type Scope = 'user' | 'installation' | 'project';
export function fixture(scope: Scope = 'user', existingDatabase?: Database.Database) {
  const sqlite = existingDatabase ?? new Database(':memory:');
  databases.push(sqlite);
  if (!existingDatabase) createAllSchemaTables(sqlite, schema);
  for (const id of ['user-1', 'owner', 'superadmin-1'])
    sqlite
      .prepare('INSERT INTO users (id, github_id, email, role, status) VALUES (?, ?, ?, ?, ?)')
      .run(id, id, `${id}@example.com`, 'user', 'active');
  sqlite.exec(`INSERT INTO github_installations (id, user_id, installation_id, account_type, account_name)
    VALUES ('installation-1', 'user-1', '123', 'Organization', 'acme');`);
  seedProjectWithMember(sqlite, { projectId: 'project-1', userId: 'user-1', role: 'owner' });
  if (scope === 'installation') seedPlatformCloudCredential(sqlite);
  else
    seedCloudCredential(sqlite, {
      id: 'cloud',
      userId: scope === 'project' ? 'owner' : 'user-1',
      projectId: scope === 'project' ? 'project-1' : null,
    });
  if (scope === 'project')
    sqlite.exec(`INSERT INTO project_members (project_id, user_id, role, status)
    VALUES ('project-1', 'owner', 'maintainer', 'active')`);
  sqlite.exec(`INSERT INTO tasks (id, project_id, user_id, title, description, status, priority,
    task_mode, dispatch_depth, triggered_by, created_by, requested_vm_size, requested_vm_size_source, created_at, updated_at)
    VALUES ('task-1', 'project-1', 'user-1', 'Old saved task', 'Continue the saved workload', 'ready', 0,
      'task', 0, 'user', 'user-1', 'small', 'task', '2026-08-28T00:00:00Z', '2026-08-28T00:00:00Z')`);
  const starts: StartTaskInput[] = [];
  const start = vi.fn(async (input: StartTaskInput) => {
    starts.push(structuredClone(input));
  });
  const projectStub = {
    ensureProjectId: vi.fn(async () => undefined),
    createSession: vi.fn(async () => 'chat-1'),
    admitProjectEvent: vi.fn(async () => ({ id: 'event-1', deduplicated: false })),
  };
  const env = {
    DATABASE: createSqliteD1(sqlite),
    BASE_DOMAIN: 'sammy.party',
    COMPUTE_QUOTA_ENFORCEMENT_ENABLED: 'false',
    VM_AGENT_REQUIRED_VERSION: '0123456789abcdef0123456789abcdef01234567',
    TASK_RUNNER: {
      idFromName: (id: string) => id,
      get: () => ({ start, ensureStarted: async () => false }),
    },
    PROJECT_DATA: { idFromName: (id: string) => id, get: () => projectStub },
  } as unknown as Env;
  const db = drizzle(env.DATABASE, { schema });
  const app = new Hono<{ Bindings: Env }>();
  app.onError((error, c) =>
    error instanceof AppError
      ? c.json(error.toJSON(), error.statusCode as never)
      : c.json({ error: error.message }, 500)
  );
  app.route('/api/projects/:projectId/tasks', runRoutes);
  async function run(body: Record<string, unknown> = {}) {
    const response = await app.request(
      '/api/projects/project-1/tasks/task-1/run',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      env,
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext
    );
    const result = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(202);
    expect(starts).toHaveLength(1);
    return starts[0]!;
  }
  return { sqlite, env, db, starts, start, run };
}
export type Fixture = ReturnType<typeof fixture>;

export function snapshotFor(start: StartTaskInput): CapacityPlacementSnapshot {
  const selection = start.config.capacityPoolSelection;
  expect(selection?.candidates.length).toBeGreaterThan(0);
  return capacityPlacementSnapshotForCandidate(selection!, selection!.candidates[0]!);
}

export async function seedHost(f: Fixture, start: StartTaskInput, id = 'host', userId = 'user-1') {
  const snapshot = snapshotFor(start);
  await f.db.insert(schema.nodes).values({
    ...capacityPlacementSnapshotDbValues(snapshot),
    id,
    userId,
    name: id,
    status: 'running',
    runtime: 'vm',
    vmSize: 'large',
    vmLocation: start.config.vmLocation,
    cloudProvider: start.config.cloudProvider,
    providerInstanceId: `provider-${id}`,
    nodeRole: 'workspace',
    nodeClass: 'managed',
    agentVersion: '0123456789abcdef0123456789abcdef01234567',
    healthStatus: 'healthy',
    observedProviderInstanceType: snapshot.providerInstanceType,
    observedProviderInstanceVcpuCount: snapshot.providerInstanceVcpuCount,
    observedProviderInstanceMemoryMb: snapshot.providerInstanceMemoryMb,
    observedProviderInstanceDiskGb: snapshot.providerInstanceDiskGb,
    observedHardwareSource: 'observed',
    lastHeartbeatAt: new Date().toISOString(),
    lastMetrics: JSON.stringify({ version: 1, cpuLoadAvg1: 0.1, memoryPercent: 5, diskPercent: 5 }),
  });
  return snapshot;
}

function runnerState(start: StartTaskInput): TaskRunnerState {
  return { ...start, stepResults: {} } as TaskRunnerState;
}
export async function select(f: Fixture, start: StartTaskInput) {
  return findNodeWithCapacity(runnerState(start), { env: f.env } as TaskRunnerContext);
}
export async function reserve(
  f: Fixture,
  start: StartTaskInput,
  snapshot: CapacityPlacementSnapshot,
  nodeId = 'host',
  id = 'new-workspace'
) {
  return reserveWorkspacePlacement(
    f.env.DATABASE,
    {
      id,
      nodeId,
      projectId: start.projectId,
      userId: start.userId,
      installationId: start.config.installationId,
      name: id,
      displayName: id,
      normalizedDisplayName: id,
      repository: start.config.repository,
      branch: start.config.branch,
      vmSize: start.config.vmSize,
      vmLocation: start.config.vmLocation,
      workspaceProfile: 'full',
      devcontainerConfigName: null,
      agentProfileHint: null,
      capacityPlacementSnapshot: snapshot,
      resolvedReservation: start.config.resolvedReservation,
      createdAt: new Date().toISOString(),
    },
    resolveWorkspaceAdmissionPolicy(f.env, start.config.projectScaling)
  );
}

export function assertReserved(
  f: Fixture,
  start: StartTaskInput,
  snapshot: CapacityPlacementSnapshot
) {
  const row = f.sqlite
    .prepare(
      `SELECT node_id, user_id, capacity_pool_id, capacity_pool_scope,
    capacity_source_id, placement_credential_reference, provider_instance_type, resolved_reservation_json
    FROM workspaces WHERE id = 'new-workspace'`
    )
    .get() as Record<string, unknown>;
  expect(row).toMatchObject({
    node_id: 'host',
    user_id: 'user-1',
    capacity_pool_id: snapshot.capacityPoolId,
    capacity_pool_scope: snapshot.capacityPoolScope,
    capacity_source_id: snapshot.capacitySourceId,
    placement_credential_reference: snapshot.placementCredentialReference,
    provider_instance_type: snapshot.providerInstanceType,
  });
  expect(JSON.parse(row.resolved_reservation_json as string)).toEqual(
    start.config.resolvedReservation
  );
}
