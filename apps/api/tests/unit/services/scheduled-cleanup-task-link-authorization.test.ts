import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { sweepTerminalCfContainers } from '../../../src/scheduled/node-cleanup/node-phases';
import { emptyResult, resolveCleanupConfig } from '../../../src/scheduled/node-cleanup/shared';
import { sweepOrphanedWorkspaces } from '../../../src/scheduled/node-cleanup/workspace-phases';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({
  stopWorkspaceOnNode: vi.fn(),
  stopNodeResources: vi.fn(),
  stopSession: vi.fn(),
  cleanupWorkspaceActivity: vi.fn(),
  persistError: vi.fn(),
}));

vi.mock('../../../src/services/node-agent', () => ({
  stopWorkspaceOnNode: (...args: unknown[]) => mocks.stopWorkspaceOnNode(...args),
  deleteWorkspaceOnNode: vi.fn(),
  getNodeAgentBackgroundRequestTimeoutMs: vi.fn().mockReturnValue(5_000),
}));

vi.mock('../../../src/services/nodes', () => ({
  stopNodeResources: (...args: unknown[]) => mocks.stopNodeResources(...args),
}));

vi.mock('../../../src/services/project-data', () => ({
  stopSession: (...args: unknown[]) => mocks.stopSession(...args),
  cleanupWorkspaceActivity: (...args: unknown[]) => mocks.cleanupWorkspaceActivity(...args),
}));

vi.mock('../../../src/services/observability', () => ({
  persistError: (...args: unknown[]) => mocks.persistError(...args),
}));

let sqlite: Database.Database;
let env: Env;

const NOW = new Date('2026-08-12T12:00:00.000Z');
const OLD = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.stopWorkspaceOnNode.mockResolvedValue(undefined);
  mocks.stopNodeResources.mockResolvedValue(undefined);
  mocks.stopSession.mockResolvedValue(undefined);
  mocks.cleanupWorkspaceActivity.mockResolvedValue(undefined);
  mocks.persistError.mockResolvedValue(undefined);

  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.nodes, schema.workspaces, schema.tasks]);
  env = {
    DATABASE: createSqliteD1(sqlite),
    OBSERVABILITY_DATABASE: createSqliteD1(sqlite),
    ORPHANED_WORKSPACE_GRACE_PERIOD_MS: '1',
  } as unknown as Env;
});

afterEach(() => {
  sqlite.close();
});

function db() {
  return drizzle(env.DATABASE, { schema });
}

async function seedWorkspaceTask(input: {
  runtime: 'vm' | 'cf-container';
  taskProjectId: string;
  taskSessionId: string | null;
  taskMode?: string;
}): Promise<void> {
  await db().insert(schema.nodes).values({
    id: 'node-victim',
    userId: 'user-victim',
    name: 'node-victim',
    status: 'running',
    runtime: input.runtime,
    nodeRole: 'workspace',
    nodeClass: 'managed',
  } as typeof schema.nodes.$inferInsert);
  await db().insert(schema.workspaces).values({
    id: 'ws-victim',
    nodeId: 'node-victim',
    projectId: 'project-victim',
    userId: 'user-victim',
    name: 'ws-victim',
    repository: 'org/repo',
    vmSize: 'small',
    vmLocation: 'nbg1',
    status: 'running',
    chatSessionId: 'session-victim',
    createdAt: OLD,
    updatedAt: OLD,
  } as typeof schema.workspaces.$inferInsert);
  await db().insert(schema.tasks).values({
    id: 'task-terminal',
    projectId: input.taskProjectId,
    userId: 'user-victim',
    workspaceId: 'ws-victim',
    chatSessionId: input.taskSessionId,
    taskMode: input.taskMode ?? 'conversation',
    title: 'terminal task',
    status: 'completed',
    updatedAt: OLD,
  } as typeof schema.tasks.$inferInsert);
}

describe('scheduled cleanup terminal task-link authorization', () => {
  it('ATTACK: orphan workspace sweep ignores a foreign-project terminal task link', async () => {
    await seedWorkspaceTask({
      runtime: 'vm',
      taskProjectId: 'project-foreign',
      taskSessionId: 'session-victim',
    });

    const result = emptyResult();
    await sweepOrphanedWorkspaces(db(), env, NOW, resolveCleanupConfig(env), result);

    expect(mocks.stopWorkspaceOnNode).not.toHaveBeenCalled();
    expect(mocks.stopSession).not.toHaveBeenCalled();
    expect(result.orphanedWorkspacesFlagged).toBe(0);
  });

  it('ATTACK: orphan workspace sweep ignores a stale chat backlink terminal task', async () => {
    await seedWorkspaceTask({
      runtime: 'vm',
      taskProjectId: 'project-victim',
      taskSessionId: 'session-stale',
    });

    const result = emptyResult();
    await sweepOrphanedWorkspaces(db(), env, NOW, resolveCleanupConfig(env), result);

    expect(mocks.stopWorkspaceOnNode).not.toHaveBeenCalled();
    expect(result.orphanedWorkspacesFlagged).toBe(0);
  });

  it('CONTROL: orphan workspace sweep stops a same-project exact-session terminal task', async () => {
    await seedWorkspaceTask({
      runtime: 'vm',
      taskProjectId: 'project-victim',
      taskSessionId: 'session-victim',
    });

    const result = emptyResult();
    await sweepOrphanedWorkspaces(db(), env, NOW, resolveCleanupConfig(env), result);

    expect(mocks.stopWorkspaceOnNode).toHaveBeenCalledWith(
      'node-victim',
      'ws-victim',
      env,
      'user-victim',
      { requestTimeoutMs: 5_000 }
    );
    expect(mocks.stopSession).toHaveBeenCalledWith(env, 'project-victim', 'session-victim');
    expect(result.orphanedWorkspacesFlagged).toBe(1);
  });

  it('ATTACK: cf-container sweep ignores a foreign-project terminal task link', async () => {
    await seedWorkspaceTask({
      runtime: 'cf-container',
      taskProjectId: 'project-foreign',
      taskSessionId: 'session-victim',
    });

    const result = emptyResult();
    await sweepTerminalCfContainers(env, NOW, resolveCleanupConfig(env), result);

    expect(mocks.stopNodeResources).not.toHaveBeenCalled();
    expect(result.cfContainersDestroyed).toBe(0);
  });

  it('ATTACK: cf-container sweep ignores a stale chat backlink terminal task', async () => {
    await seedWorkspaceTask({
      runtime: 'cf-container',
      taskProjectId: 'project-victim',
      taskSessionId: 'session-stale',
    });

    const result = emptyResult();
    await sweepTerminalCfContainers(env, NOW, resolveCleanupConfig(env), result);

    expect(mocks.stopNodeResources).not.toHaveBeenCalled();
    expect(result.cfContainersDestroyed).toBe(0);
  });

  it('CONTROL: cf-container sweep destroys a same-project exact-session terminal task', async () => {
    await seedWorkspaceTask({
      runtime: 'cf-container',
      taskProjectId: 'project-victim',
      taskSessionId: 'session-victim',
    });

    const result = emptyResult();
    await sweepTerminalCfContainers(env, NOW, resolveCleanupConfig(env), result);

    expect(mocks.stopNodeResources).toHaveBeenCalledWith('node-victim', 'user-victim', env, {
      exclusiveWorkspaceId: 'ws-victim',
    });
    expect(result.cfContainersDestroyed).toBe(1);
  });
});
