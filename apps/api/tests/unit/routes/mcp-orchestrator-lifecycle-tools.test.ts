/**
 * override_task_state against a real SQL engine (rule 28). It carries the same two gates as
 * stop_subtask: a task-scoped token, and the actor's CURRENT task:write capability read from
 * project_members on every call. Each attack case has an owner-path control.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import type { McpTokenData } from '../../../src/routes/mcp/_helpers';
import { handleOverrideTaskState } from '../../../src/routes/mcp/orchestrator-lifecycle-tools';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  overrideTaskState: vi.fn(),
}));

vi.mock('../../../src/lib/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/logger')>()),
  log: mocks.log,
}));
vi.mock('../../../src/services/project-orchestrator', () => ({
  overrideTaskState: mocks.overrideTaskState,
}));

const tokenData: McpTokenData = {
  workspaceId: 'workspace-1',
  projectId: 'project-caller',
  taskId: 'task-caller',
  userId: 'user-1',
  createdAt: '2026-11-03T00:00:00.000Z',
};

const params = {
  missionId: 'mission-caller',
  taskId: 'task-target',
  newState: 'blocked_human',
  reason: 'manual override',
};

let sqlite: Database.Database;
let env: Env;

function setMembership(role: string, status = 'active') {
  sqlite.prepare('DELETE FROM project_members').run();
  sqlite
    .prepare('INSERT INTO project_members (project_id, user_id, role, status) VALUES (?, ?, ?, ?)')
    .run('project-caller', 'user-1', role, status);
}

beforeEach(() => {
  vi.clearAllMocks();
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.tasks, schema.projectMembers]);
  const task = sqlite.prepare('INSERT INTO tasks (id, project_id, mission_id) VALUES (?, ?, ?)');
  task.run('task-target', 'project-caller', 'mission-caller');
  task.run('task-foreign', 'project-target', 'mission-target');
  setMembership('owner');
  env = { DATABASE: createSqliteD1(sqlite) } as Env;
  mocks.overrideTaskState.mockResolvedValue(true);
});

afterEach(() => {
  sqlite.close();
});

describe('MCP orchestrator lifecycle tools', () => {
  it('allows override_task_state for a current task:write member (owner control)', async () => {
    const result = await handleOverrideTaskState(1, params, tokenData, env);

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ success: true, taskId: 'task-target', newState: 'blocked_human' }),
        },
      ],
    });
    expect(mocks.overrideTaskState).toHaveBeenCalledWith(
      env,
      'project-caller',
      'mission-caller',
      'task-target',
      'blocked_human',
      'manual override'
    );
  });

  it('rejects a user-scoped (non-task) token before any state change', async () => {
    const result = await handleOverrideTaskState(1, params, { ...tokenData, taskId: '' }, env);

    expect(result.error).toMatchObject({
      code: -32602,
      message: 'Only task agents can use orchestration tools',
    });
    expect(mocks.overrideTaskState).not.toHaveBeenCalled();
  });

  it('rejects an actor downgraded to a role without task:write after the token was minted', async () => {
    setMembership('viewer');

    const result = await handleOverrideTaskState(1, params, tokenData, env);

    expect(result.error?.message).toContain("no longer has 'task:write'");
    expect(mocks.overrideTaskState).not.toHaveBeenCalled();
    expect(mocks.log.warn).toHaveBeenCalledWith(
      'mcp.orchestration.stale_actor_authority',
      expect.objectContaining({
        tool: 'override_task_state',
        projectId: 'project-caller',
        userId: 'user-1',
        action: 'rejected',
      })
    );
  });

  it('rejects an actor whose membership was removed', async () => {
    setMembership('owner', 'removed');

    const result = await handleOverrideTaskState(1, params, tokenData, env);

    expect(result.error?.message).toContain("no longer has 'task:write'");
    expect(mocks.overrideTaskState).not.toHaveBeenCalled();
  });

  it('rejects override_task_state when the target task belongs to another project', async () => {
    const result = await handleOverrideTaskState(
      1,
      { ...params, missionId: 'mission-target', taskId: 'task-foreign' },
      tokenData,
      env
    );

    expect(result.error).toMatchObject({
      code: -32602,
      message: 'Task not found',
      data: { httpStatus: 404 },
    });
    expect(mocks.overrideTaskState).not.toHaveBeenCalled();
    expect(mocks.log.warn).toHaveBeenCalledWith('mcp.override_task_state.project_mismatch', {
      projectId: 'project-caller',
      callerProjectId: 'project-caller',
      missionId: 'mission-target',
      taskId: 'task-foreign',
      targetProjectId: 'project-target',
      expectedProjectId: 'project-caller',
      receivedProjectId: 'project-target',
      action: 'rejected',
    });
  });
});
