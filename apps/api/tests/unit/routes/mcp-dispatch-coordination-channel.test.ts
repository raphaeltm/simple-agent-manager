/**
 * dispatch_task carries a feature coordination channel to children and every
 * later descendant, through the real handler and real SQLite persistence.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import type { McpTokenData } from '../../../src/routes/mcp/_helpers';
import { parseDispatchTaskParams } from '../../../src/routes/mcp/dispatch-tool-params';
import { ensureDefaultCapacityPoolsForExistingCredentials } from '../../../src/services/default-capacity-pools';
import { createAllSchemaTables, createSqliteD1WithBindLimit } from '../../helpers/sqlite-d1';
import { seedCloudCredential, seedProjectWithMember, seedUser } from './capacity-pool-test-seeds';

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  persistMessage: vi.fn(),
  getActivePolicies: vi.fn(),
  requireRepositoryOwnerAccess: vi.fn(),
  startTaskRunnerDO: vi.fn(),
  generateTaskTitle: vi.fn(),
}));

vi.mock('../../../src/services/project-data', () => ({
  createSession: mocks.createSession,
  persistMessage: mocks.persistMessage,
  getActivePolicies: mocks.getActivePolicies,
  stopSession: vi.fn(),
}));

vi.mock('../../../src/routes/projects/_helpers', () => ({
  requireRepositoryOwnerAccess: mocks.requireRepositoryOwnerAccess,
}));

vi.mock('../../../src/services/task-runner-do', () => ({
  startTaskRunnerDO: mocks.startTaskRunnerDO,
}));

vi.mock('../../../src/services/task-title', () => ({
  generateTaskTitle: mocks.generateTaskTitle,
  getTaskTitleConfig: vi.fn(() => ({})),
}));

const { handleDispatchTask } = await import('../../../src/routes/mcp/dispatch-tool');

const limits = {
  dispatchDescriptionMaxLength: 4000,
  dispatchMaxPriority: 10,
  dispatchMaxReferences: 5,
  dispatchMaxReferenceLength: 200,
};

type TaskRow = {
  id: string;
  parent_task_id: string | null;
  coordination_channel: string | null;
  description: string;
};

describe('dispatch_task coordinationChannel parsing', () => {
  const parse = (coordinationChannel: unknown) =>
    parseDispatchTaskParams(1, { description: 'child', coordinationChannel }, limits);

  it('accepts a canonical channel name and leaves an omitted value to inheritance', () => {
    const accepted = parse('feature.event-messaging_v2');
    expect('parsed' in accepted && accepted.parsed.explicitCoordinationChannel).toBe(
      'feature.event-messaging_v2'
    );
    const omitted = parseDispatchTaskParams(1, { description: 'child' }, limits);
    expect('parsed' in omitted && omitted.parsed.explicitCoordinationChannel).toBeUndefined();
  });

  it('rejects invalid, non-string and reserved agent-dm names', () => {
    for (const value of ['Feature/X', '', 42, 'agent-dm.abc']) {
      const result = parse(value);
      expect('error' in result).toBe(true);
      if ('error' in result) expect(result.error.error?.code).toBe(-32602);
    }
    const reserved = parse('agent-dm.abc');
    expect('error' in reserved && reserved.error.error?.message).toContain('reserved');
  });
});

describe('dispatch_task coordination channel inheritance (real persistence)', () => {
  let sqlite: Database.Database;
  let env: Env;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.createSession.mockResolvedValue('session-child');
    mocks.persistMessage.mockResolvedValue(undefined);
    mocks.getActivePolicies.mockResolvedValue([]);
    mocks.requireRepositoryOwnerAccess.mockResolvedValue(undefined);
    mocks.startTaskRunnerDO.mockResolvedValue(undefined);
    mocks.generateTaskTitle.mockResolvedValue('Child task');

    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    seedUser(sqlite, 'user-1');
    seedProjectWithMember(sqlite, { projectId: 'project-1', userId: 'user-1', role: 'owner' });
    seedCloudCredential(sqlite, { id: 'cloud-1', userId: 'user-1', projectId: 'project-1' });
    sqlite
      .prepare(
        `INSERT INTO tasks (id, project_id, user_id, title, description, status, priority,
           task_mode, dispatch_depth, triggered_by, created_by, coordination_channel,
           created_at, updated_at)
         VALUES ('root', 'project-1', 'user-1', 'Root', 'Root', 'in_progress', 0, 'task', 0,
           'user', 'user-1', NULL, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`
      )
      .run();
    env = {
      DATABASE: createSqliteD1WithBindLimit(sqlite, 100),
      BASE_DOMAIN: 'sammy.party',
      BRANCH_NAME_PREFIX: 'sam/',
      BRANCH_NAME_MAX_LENGTH: '60',
      COMPUTE_QUOTA_ENFORCEMENT_ENABLED: 'false',
      MCP_DISPATCH_MAX_DEPTH: '5',
    } as Env;
    await ensureDefaultCapacityPoolsForExistingCredentials(drizzle(env.DATABASE, { schema }), {
      userId: 'user-1',
      projectId: 'project-1',
      includeInstallation: false,
    });
  });

  afterEach(() => sqlite.close());

  const token = (taskId: string): McpTokenData => ({
    taskId,
    projectId: 'project-1',
    userId: 'user-1',
    workspaceId: `workspace-${taskId}`,
    createdAt: '2026-10-01T00:00:00.000Z',
  });

  const dispatchFrom = async (parentTaskId: string, params: Record<string, unknown> = {}) => {
    const response = await handleDispatchTask(
      1,
      { description: `work for ${parentTaskId}`, ...params },
      token(parentTaskId),
      env
    );
    expect(response.error).toBeUndefined();
    return sqlite
      .prepare(
        `SELECT id, parent_task_id, coordination_channel, description FROM tasks
         WHERE parent_task_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`
      )
      .get(parentTaskId) as TaskRow;
  };

  it('passes an explicit channel to a child and then on to the grandchild', async () => {
    const child = await dispatchFrom('root', { coordinationChannel: 'feature.messaging' });
    expect(child.coordination_channel).toBe('feature.messaging');
    expect(child.description).toContain('## Coordination channel');
    expect(child.description).toContain('`feature.messaging`');

    const grandchild = await dispatchFrom(child.id);
    expect(grandchild.coordination_channel).toBe('feature.messaging');
    expect(grandchild.description).toContain('`feature.messaging`');
  });

  it('inherits the dispatcher channel and lets an explicit value replace it', async () => {
    sqlite
      .prepare(`UPDATE tasks SET coordination_channel = 'feature.root' WHERE id = 'root'`)
      .run();
    const inherited = await dispatchFrom('root');
    expect(inherited.coordination_channel).toBe('feature.root');
    const replaced = await dispatchFrom('root', { coordinationChannel: 'feature.split' });
    expect(replaced.coordination_channel).toBe('feature.split');
  });

  it('leaves tasks without a channel unchanged', async () => {
    const child = await dispatchFrom('root');
    expect(child.coordination_channel).toBeNull();
    expect(child.description).not.toContain('Coordination channel');
  });

  it('rejects an invalid channel before creating any task', async () => {
    const response = await handleDispatchTask(
      1,
      { description: 'bad channel', coordinationChannel: 'Not Valid' },
      token('root'),
      env
    );
    expect(response.error?.code).toBe(-32602);
    expect(
      sqlite.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE parent_task_id = 'root'`).get()
    ).toEqual({ n: 0 });
  });
});
