import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { destroyNodeForCleanup } from '../../../src/scheduled/node-cleanup/shared';
import { cleanupTerminalTaskResources } from '../../../src/services/task-terminal-cleanup';
import { cleanupWorkspaceForDeletion } from '../../../src/services/workspace-cleanup';
import { finalizeWorkspaceLifecycleClosure } from '../../../src/services/workspace-lifecycle-finalizer';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({
  cleanupWorkspaceActivity: vi.fn(async () => {}),
  deleteNodeResourcesStrict: vi.fn(async () => ({ providerVm: 'deleted' })),
  deleteWorkspaceOnNode: vi.fn(async () => {}),
  failSession: vi.fn(async () => {}),
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  markIdle: vi.fn(async () => {}),
  persistError: vi.fn(async () => {}),
  stopSession: vi.fn(async () => {}),
  stopWorkspaceOnNode: vi.fn(async () => {}),
}));

vi.mock('../../../src/services/project-data', () => ({
  cleanupWorkspaceActivity: (...args: unknown[]) => mocks.cleanupWorkspaceActivity(...args),
  failSession: (...args: unknown[]) => mocks.failSession(...args),
  stopSession: (...args: unknown[]) => mocks.stopSession(...args),
}));

vi.mock('../../../src/services/node-agent', () => ({
  deleteWorkspaceOnNode: (...args: unknown[]) => mocks.deleteWorkspaceOnNode(...args),
  getNodeAgentBackgroundRequestTimeoutMs: vi.fn(() => 5_000),
  stopWorkspaceOnNode: (...args: unknown[]) => mocks.stopWorkspaceOnNode(...args),
}));

vi.mock('../../../src/services/node-lifecycle', () => ({
  markIdle: (...args: unknown[]) => mocks.markIdle(...args),
}));

vi.mock('../../../src/services/nodes', () => ({
  deleteNodeResourcesStrict: (...args: unknown[]) => mocks.deleteNodeResourcesStrict(...args),
  stopNodeResources: vi.fn(async () => {}),
}));

vi.mock('../../../src/services/observability', () => ({
  persistError: (...args: unknown[]) => mocks.persistError(...args),
}));

vi.mock('../../../src/lib/logger', () => ({
  createModuleLogger: () => mocks.log,
  log: mocks.log,
}));

const NOW = new Date('2026-08-26T21:10:00.000Z');
const NOW_ISO = NOW.toISOString();
const PROJECT_ID = 'project-finalizer';
const USER_ID = 'user-finalizer';
const WORKSPACE_ID = 'workspace-finalizer';
const NODE_ID = 'node-finalizer';
const CHAT_SESSION_ID = 'chat-finalizer';
const AGENT_SESSION_ID = 'agent-finalizer';
const TASK_ID = 'task-finalizer';

let sqlite: Database.Database;
let env: Env;

function iso(offsetMs: number): string {
  return new Date(NOW.getTime() + offsetMs).toISOString();
}

function seedNode(
  id = NODE_ID,
  overrides: { status?: string; createdAt?: string; updatedAt?: string } = {}
): void {
  sqlite
    .prepare(
      `INSERT INTO nodes
        (id, user_id, name, status, health_status, vm_size, vm_location, cloud_provider,
         runtime, node_role, node_class, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'healthy', 'medium', 'nbg1', 'hetzner', 'vm', 'workspace',
               'managed', ?, ?)`
    )
    .run(
      id,
      USER_ID,
      `node-${id}`,
      overrides.status ?? 'running',
      overrides.createdAt ?? iso(-5 * 60 * 60 * 1000),
      overrides.updatedAt ?? iso(-5 * 60 * 1000)
    );
}

function seedWorkspace(
  overrides: {
    id?: string;
    nodeId?: string | null;
    status?: string;
    chatSessionId?: string | null;
    projectId?: string | null;
    updatedAt?: string;
  } = {}
): void {
  sqlite
    .prepare(
      `INSERT INTO workspaces
        (id, node_id, user_id, project_id, name, repository, branch, status, vm_size,
         vm_location, chat_session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'org/repo', 'main', ?, 'medium', 'nbg1', ?, ?, ?)`
    )
    .run(
      overrides.id ?? WORKSPACE_ID,
      overrides.nodeId === undefined ? NODE_ID : overrides.nodeId,
      USER_ID,
      overrides.projectId === undefined ? PROJECT_ID : overrides.projectId,
      `ws-${overrides.id ?? WORKSPACE_ID}`,
      overrides.status ?? 'sleeping',
      overrides.chatSessionId === undefined ? CHAT_SESSION_ID : overrides.chatSessionId,
      iso(-60 * 60 * 1000),
      overrides.updatedAt ?? iso(-5 * 60 * 1000)
    );
}

function seedAgentSession(
  overrides: { id?: string; workspaceId?: string; status?: string } = {}
): void {
  sqlite
    .prepare(
      `INSERT INTO agent_sessions
        (id, workspace_id, user_id, status, agent_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'codex', ?, ?)`
    )
    .run(
      overrides.id ?? AGENT_SESSION_ID,
      overrides.workspaceId ?? WORKSPACE_ID,
      USER_ID,
      overrides.status ?? 'running',
      iso(-60 * 60 * 1000),
      iso(-5 * 60 * 1000)
    );
}

function seedTask(overrides: { status?: string; workspaceId?: string | null } = {}): void {
  sqlite
    .prepare(
      `INSERT INTO tasks
        (id, project_id, user_id, workspace_id, title, status, priority, task_mode,
         created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'task', ?, 0, 'conversation', ?, ?, ?)`
    )
    .run(
      TASK_ID,
      PROJECT_ID,
      USER_ID,
      overrides.workspaceId === undefined ? WORKSPACE_ID : overrides.workspaceId,
      overrides.status ?? 'completed',
      USER_ID,
      iso(-60 * 60 * 1000),
      iso(-5 * 60 * 1000)
    );
}

function seedRestorableSnapshot(
  overrides: {
    id?: string;
    chatSessionId?: string;
    projectId?: string;
    workspaceId?: string;
    expiresAt?: string;
    status?: string;
    degradation?: string;
    sleepStatus?: string | null;
    sleepingAt?: string | null;
    recoveryAttempts?: number;
  } = {}
): void {
  const chatSessionId = overrides.chatSessionId ?? CHAT_SESSION_ID;
  sqlite
    .prepare(
      `INSERT INTO session_snapshots
        (id, project_id, workspace_id, node_id, user_id, chat_session_id, runtime, status,
         degradation, manifest_r2_key, home_r2_key, expires_at, sleeping_at, sleep_status,
         recovery_attempts, sleep_attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'vm', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
    )
    .run(
      overrides.id ?? `snapshot-${chatSessionId}`,
      overrides.projectId ?? PROJECT_ID,
      overrides.workspaceId ?? WORKSPACE_ID,
      NODE_ID,
      USER_ID,
      chatSessionId,
      overrides.status ?? 'available',
      overrides.degradation ?? 'none',
      `snapshots/${chatSessionId}/manifest.json`,
      `snapshots/${chatSessionId}/home.tar.zst`,
      overrides.expiresAt ?? iso(7 * 24 * 60 * 60 * 1000),
      overrides.sleepingAt === undefined ? iso(-5 * 60 * 1000) : overrides.sleepingAt,
      overrides.sleepStatus === undefined ? 'sleeping' : overrides.sleepStatus,
      overrides.recoveryAttempts ?? 0,
      iso(-60 * 60 * 1000),
      iso(-5 * 60 * 1000)
    );
}

async function loadWorkspace(id = WORKSPACE_ID): Promise<schema.Workspace> {
  const db = drizzle(env.DATABASE, { schema });
  const row = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, id)).get();
  if (!row) throw new Error(`workspace ${id} not found`);
  return row;
}

async function finalizeWorkspace(): Promise<void> {
  await finalizeWorkspaceLifecycleClosure(env, {
    workspaceIds: [WORKSPACE_ID],
    userId: USER_ID,
    agentSessionStatus: 'completed',
    nowIso: NOW_ISO,
    reason: 'test_finalizer',
  });
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [
    schema.workspaces,
    schema.nodes,
    schema.tasks,
    schema.agentSessions,
    schema.computeUsage,
    schema.sessionSnapshots,
  ]);
  env = {
    DATABASE: createSqliteD1(sqlite),
    OBSERVABILITY_DATABASE: createSqliteD1(new Database(':memory:')),
    R2: { delete: vi.fn(async () => {}) },
    SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS: '3',
    TASK_RUN_CLEANUP_DELAY_MS: '0',
  } as unknown as Env;
  vi.clearAllMocks();
});

describe('finalizeWorkspaceLifecycleClosure ProjectData session finalization', () => {
  it('preserves a slept ProjectData session when its snapshot is restorable', async () => {
    seedNode();
    seedWorkspace({ status: 'deleted' });
    seedAgentSession();
    seedRestorableSnapshot();

    await finalizeWorkspace();

    expect(mocks.stopSession).not.toHaveBeenCalled();
    expect(mocks.failSession).not.toHaveBeenCalled();
    expect(mocks.cleanupWorkspaceActivity).toHaveBeenCalledWith(env, PROJECT_ID, WORKSPACE_ID);
  });

  it('preserves a degraded slept ProjectData session when the snapshot is still restorable', async () => {
    seedNode();
    seedWorkspace({ status: 'deleted' });
    seedAgentSession();
    seedRestorableSnapshot({ status: 'degraded', degradation: 'entries-skipped' });

    await finalizeWorkspace();

    expect(mocks.stopSession).not.toHaveBeenCalled();
    expect(mocks.failSession).not.toHaveBeenCalled();
    expect(mocks.cleanupWorkspaceActivity).toHaveBeenCalledWith(env, PROJECT_ID, WORKSPACE_ID);
  });

  it('still stops a session with no snapshot row', async () => {
    seedNode();
    seedWorkspace({ status: 'deleted' });

    await finalizeWorkspace();

    expect(mocks.stopSession).toHaveBeenCalledWith(env, PROJECT_ID, CHAT_SESSION_ID);
    expect(mocks.failSession).not.toHaveBeenCalled();
  });

  it('still stops a session with an expired snapshot row', async () => {
    seedNode();
    seedWorkspace({ status: 'deleted' });
    seedRestorableSnapshot({ expiresAt: iso(-1_000) });

    await finalizeWorkspace();

    expect(mocks.stopSession).toHaveBeenCalledWith(env, PROJECT_ID, CHAT_SESSION_ID);
    expect(mocks.failSession).not.toHaveBeenCalled();
  });

  it.each([
    ['snapshot is not marked sleeping', { sleepStatus: 'awake' }],
    ['snapshot has no sleeping timestamp', { sleepingAt: null }],
    ['snapshot exhausted recovery attempts', { recoveryAttempts: 3 }],
    ['snapshot status is not restorable', { status: 'failed', degradation: 'none' }],
    ['available snapshot has non-none degradation', { status: 'available', degradation: 'partial' }],
    ['snapshot belongs to a different project', { projectId: 'project-other' }],
    ['snapshot belongs to a different workspace', { workspaceId: 'workspace-other' }],
  ])('still stops when the %s', async (_name, snapshotOverrides) => {
    seedNode();
    seedWorkspace({ status: 'deleted' });
    seedRestorableSnapshot(snapshotOverrides);

    await finalizeWorkspace();

    expect(mocks.stopSession).toHaveBeenCalledWith(env, PROJECT_ID, CHAT_SESSION_ID);
    expect(mocks.failSession).not.toHaveBeenCalled();
  });

  it('still fails a session when the lifecycle closure is failed', async () => {
    seedNode();
    seedWorkspace({ status: 'deleted' });
    seedRestorableSnapshot();

    await finalizeWorkspaceLifecycleClosure(env, {
      workspaceIds: [WORKSPACE_ID],
      userId: USER_ID,
      agentSessionStatus: 'failed',
      errorMessage: 'workspace failed',
      nowIso: NOW_ISO,
      reason: 'test_failed_finalizer',
    });

    expect(mocks.failSession).toHaveBeenCalledWith(
      env,
      PROJECT_ID,
      CHAT_SESSION_ID,
      'workspace failed'
    );
    expect(mocks.stopSession).not.toHaveBeenCalled();
  });

  it('withholds ProjectData stop when the snapshot lookup fails', async () => {
    seedNode();
    seedWorkspace({ status: 'deleted' });
    const workingDatabase = env.DATABASE;
    env = {
      ...env,
      DATABASE: {
        ...workingDatabase,
        prepare: (query: string) => {
          if (query.includes('session_snapshots')) {
            throw new Error('snapshot database unavailable');
          }
          return workingDatabase.prepare(query);
        },
      },
    } as Env;

    const result = await finalizeWorkspaceLifecycleClosure(env, {
      workspaceIds: [WORKSPACE_ID],
      userId: USER_ID,
      agentSessionStatus: 'completed',
      nowIso: NOW_ISO,
      reason: 'test_lookup_failure',
    });

    expect(result.projectSessionErrors).toBe(1);
    expect(mocks.stopSession).not.toHaveBeenCalled();
    expect(mocks.failSession).not.toHaveBeenCalled();
  });
});

describe('real teardown writers preserve sleeping sessions through the finalizer', () => {
  it('preserves a slept ProjectData session when destroyNodeForCleanup destroys its node', async () => {
    seedNode(NODE_ID, { status: 'running' });
    seedWorkspace({ status: 'sleeping' });
    seedAgentSession();
    seedRestorableSnapshot();
    const db = drizzle(env.DATABASE, { schema });

    const result = await destroyNodeForCleanup(
      db,
      env,
      NOW_ISO,
      { id: NODE_ID, user_id: USER_ID, status: 'running' },
      {
        logEvent: 'node_cleanup.destroying_max_lifetime',
        failureLogEvent: 'node_cleanup.destroy_failed',
        successMessage: 'Destroyed max-lifetime node',
        failureMessagePrefix: 'Failed to destroy max-lifetime node',
        recoveryType: 'max_lifetime',
        failureRecoveryType: 'max_lifetime_failure',
        failureBackoffMs: 60_000,
        context: { phase: 'test' },
      }
    );

    expect(result).toBe('destroyed');
    expect(mocks.deleteNodeResourcesStrict).toHaveBeenCalledWith(NODE_ID, USER_ID, env);
    expect(mocks.stopSession).not.toHaveBeenCalled();
    expect(mocks.cleanupWorkspaceActivity).toHaveBeenCalledWith(env, PROJECT_ID, WORKSPACE_ID);
  });
});

describe('destructive archive/delete paths still stop sessions', () => {
  it('user workspace deletion removes snapshot state before finalization, so the session still stops', async () => {
    seedWorkspace({ nodeId: null, status: 'sleeping' });
    seedRestorableSnapshot();
    const db = drizzle(env.DATABASE, { schema });

    await cleanupWorkspaceForDeletion({
      db,
      env,
      workspace: await loadWorkspace(),
      userId: USER_ID,
      logContext: { closePath: 'user_archive' },
    });

    expect(sqlite.prepare('SELECT COUNT(*) FROM session_snapshots').pluck().get()).toBe(0);
    expect(mocks.stopSession).toHaveBeenCalledWith(env, PROJECT_ID, CHAT_SESSION_ID);
  });

  it('task-terminal destructive cleanup deletes snapshot state before direct ProjectData stop', async () => {
    seedWorkspace({ nodeId: null, status: 'sleeping' });
    seedTask({ status: 'completed' });
    seedRestorableSnapshot();

    await cleanupTerminalTaskResources(env, TASK_ID, {
      status: 'completed',
      destructiveSessionEnd: true,
    });

    expect(sqlite.prepare('SELECT COUNT(*) FROM session_snapshots').pluck().get()).toBe(0);
    expect(mocks.stopSession).toHaveBeenCalledWith(env, PROJECT_ID, CHAT_SESSION_ID);
  });
});
