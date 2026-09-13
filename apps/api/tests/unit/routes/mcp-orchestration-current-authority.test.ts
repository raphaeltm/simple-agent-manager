/**
 * Finding 1 — destructive MCP child control must re-derive CURRENT authority.
 *
 * An MCP token is a KV entry with a sliding TTL; nothing in its lifecycle
 * observes project membership. Parent lineage is equally stale evidence: it
 * records who dispatched the child once. So an actor removed from the project,
 * or downgraded below `task:write`, kept full destructive control of the child
 * until the token's max lifetime expired.
 *
 * Membership is exercised through real `project_members` rows against a real SQL
 * engine — the guard is a relational query, so a mock that ignores its WHERE
 * clause would pass with the guard deleted (rule 28).
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import type { McpTokenData } from '../../../src/routes/mcp/_helpers';
import { ensureDefaultCapacityPoolsForExistingCredentials } from '../../../src/services/default-capacity-pools';
import { createAllSchemaTables, createSqliteD1WithBindLimit } from '../../helpers/sqlite-d1';
import { seedCloudCredential, seedProjectWithMember, seedUser } from './capacity-pool-test-seeds';

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  persistMessage: vi.fn(),
  stopSession: vi.fn(),
  startTaskRunnerDO: vi.fn(),
  generateTaskTitle: vi.fn(),
  stopAgentSessionOnNode: vi.fn(),
  sendPromptToAgentOnNode: vi.fn(),
  cleanupTerminalTaskResources: vi.fn(),
}));

vi.mock('../../../src/services/project-data', () => ({
  createSession: mocks.createSession,
  persistMessage: mocks.persistMessage,
  stopSession: mocks.stopSession,
  acceptPromptDelivery: vi.fn(),
}));

vi.mock('../../../src/services/task-runner-do', () => ({
  startTaskRunnerDO: mocks.startTaskRunnerDO,
}));

vi.mock('../../../src/services/task-title', () => ({
  generateTaskTitle: mocks.generateTaskTitle,
  getTaskTitleConfig: vi.fn(() => ({})),
}));

vi.mock('../../../src/services/node-agent', () => ({
  stopAgentSessionOnNode: mocks.stopAgentSessionOnNode,
  sendPromptToAgentOnNode: mocks.sendPromptToAgentOnNode,
}));

vi.mock('../../../src/services/task-terminal-cleanup', () => ({
  cleanupTerminalTaskResources: mocks.cleanupTerminalTaskResources,
}));

const { handleRetrySubtask } = await import('../../../src/routes/mcp/orchestration-tools');
const { handleStopSubtask } = await import('../../../src/routes/mcp/orchestration-comms');

const PROJECT_ID = 'project-1';
const ACTOR_ID = 'user-actor';

function token(overrides: Partial<McpTokenData> = {}): McpTokenData {
  return {
    taskId: 'parent-task-1',
    projectId: PROJECT_ID,
    userId: ACTOR_ID,
    workspaceId: 'workspace-parent',
    createdAt: '2026-09-07T00:00:00.000Z',
    ...overrides,
  };
}

function seedTask(
  sqlite: Database.Database,
  input: { id: string; parentTaskId: string | null; status: string; workspaceId?: string | null }
): void {
  sqlite
    .prepare(
      `INSERT INTO tasks (
         id, project_id, user_id, parent_task_id, workspace_id, title, description, status,
         priority, task_mode, dispatch_depth, triggered_by, created_by, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'task', 1, 'mcp', ?, '2026-09-07T00:00:00.000Z',
         '2026-09-07T00:00:00.000Z')`
    )
    .run(
      input.id,
      PROJECT_ID,
      ACTOR_ID,
      input.parentTaskId,
      input.workspaceId ?? null,
      `Task ${input.id}`,
      `Description ${input.id}`,
      input.status,
      ACTOR_ID
    );
}

/**
 * A live child on a live node — the state where every destructive effect is
 * genuinely reachable, so an "authorized" assertion is not vacuous.
 */
function seedRunningChild(sqlite: Database.Database): void {
  sqlite
    .prepare(
      `INSERT INTO nodes (id, user_id, name, status, created_at, updated_at)
       VALUES ('node-1', ?, 'node-1', 'running', '2026-09-07T00:00:00.000Z',
         '2026-09-07T00:00:00.000Z')`
    )
    .run(ACTOR_ID);
  sqlite
    .prepare(
      `INSERT INTO workspaces (
         id, user_id, project_id, node_id, name, status, chat_session_id, created_at, updated_at
       )
       VALUES ('workspace-child', ?, ?, 'node-1', 'child-ws', 'running', 'chat-child',
         '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z')`
    )
    .run(ACTOR_ID, PROJECT_ID);
  sqlite
    .prepare(
      `INSERT INTO agent_sessions (id, workspace_id, agent_type, status, created_at, updated_at)
       VALUES ('agent-session-child', 'workspace-child', 'claude-code', 'running',
         '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z')`
    )
    .run();
  seedTask(sqlite, {
    id: 'child-1',
    parentTaskId: 'parent-task-1',
    // An MCP ACTIVE_STATUS, so the stop/replace effects are genuinely reachable.
    status: 'in_progress',
    workspaceId: 'workspace-child',
  });
}

async function createFixture(memberRole: string | null): Promise<{
  sqlite: Database.Database;
  env: Env;
}> {
  const sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  seedUser(sqlite, ACTOR_ID);
  // Seed as owner so the project row exists, then apply the actual membership
  // state under test. `null` means the row was deleted outright.
  seedProjectWithMember(sqlite, { projectId: PROJECT_ID, userId: ACTOR_ID, role: 'owner' });
  if (memberRole === null) {
    sqlite
      .prepare(`DELETE FROM project_members WHERE project_id = ? AND user_id = ?`)
      .run(PROJECT_ID, ACTOR_ID);
  } else if (memberRole === 'removed') {
    sqlite
      .prepare(
        `UPDATE project_members SET status = 'removed' WHERE project_id = ? AND user_id = ?`
      )
      .run(PROJECT_ID, ACTOR_ID);
  } else {
    sqlite
      .prepare(`UPDATE project_members SET role = ? WHERE project_id = ? AND user_id = ?`)
      .run(memberRole, PROJECT_ID, ACTOR_ID);
  }
  seedCloudCredential(sqlite, {
    id: 'project-cloud-1',
    userId: ACTOR_ID,
    projectId: PROJECT_ID,
  });

  seedTask(sqlite, { id: 'parent-task-1', parentTaskId: null, status: 'in_progress' });
  seedRunningChild(sqlite);

  const env = {
    DATABASE: createSqliteD1WithBindLimit(sqlite, 100),
    BASE_DOMAIN: 'sammy.party',
    BRANCH_NAME_PREFIX: 'sam/',
    BRANCH_NAME_MAX_LENGTH: '60',
    COMPUTE_QUOTA_ENFORCEMENT_ENABLED: 'false',
    ORCHESTRATOR_STOP_GRACE_MS: '0',
  } as unknown as Env;
  await ensureDefaultCapacityPoolsForExistingCredentials(drizzle(env.DATABASE, { schema }), {
    userId: ACTOR_ID,
    projectId: PROJECT_ID,
    includeInstallation: false,
  });
  return { sqlite, env };
}

function childStatus(sqlite: Database.Database): string {
  return (sqlite.prepare(`SELECT status FROM tasks WHERE id = 'child-1'`).get() as {
    status: string;
  }).status;
}

function taskCount(sqlite: Database.Database): number {
  return (sqlite.prepare(`SELECT count(*) AS n FROM tasks`).get() as { n: number }).n;
}

function assertNoSideEffects(sqlite: Database.Database): void {
  // The child agent was never stopped, no terminal transition was written, no
  // replacement task/session/runner was created.
  expect(mocks.stopAgentSessionOnNode).not.toHaveBeenCalled();
  expect(mocks.sendPromptToAgentOnNode).not.toHaveBeenCalled();
  expect(mocks.createSession).not.toHaveBeenCalled();
  expect(mocks.startTaskRunnerDO).not.toHaveBeenCalled();
  expect(mocks.stopSession).not.toHaveBeenCalled();
  expect(childStatus(sqlite)).toBe('in_progress');
  expect(taskCount(sqlite)).toBe(2);
  expect(
    (sqlite.prepare(`SELECT count(*) AS n FROM task_status_events`).get() as { n: number }).n
  ).toBe(0);
}

describe('destructive MCP child control requires current project authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createSession.mockResolvedValue('session-retry');
    mocks.persistMessage.mockResolvedValue(undefined);
    mocks.stopSession.mockResolvedValue(undefined);
    mocks.startTaskRunnerDO.mockResolvedValue(undefined);
    mocks.generateTaskTitle.mockResolvedValue('Retry task title');
    mocks.stopAgentSessionOnNode.mockResolvedValue(undefined);
    mocks.sendPromptToAgentOnNode.mockResolvedValue(undefined);
    mocks.cleanupTerminalTaskResources.mockResolvedValue(undefined);
  });

  describe.each([
    ['membership row deleted', null],
    ['membership removed', 'removed'],
    ['downgraded to viewer', 'viewer'],
  ])('actor with %s', (_label, memberRole) => {
    it('retry_subtask is rejected with no side effects', async () => {
      const { sqlite, env } = await createFixture(memberRole);
      try {
        const response = await handleRetrySubtask(1, { taskId: 'child-1' }, token(), env);

        expect(response.error?.message).toMatch(/no longer has 'task:write' access/);
        assertNoSideEffects(sqlite);
      } finally {
        sqlite.close();
      }
    });

    it('stop_subtask is rejected with no side effects', async () => {
      const { sqlite, env } = await createFixture(memberRole);
      try {
        const response = await handleStopSubtask(
          1,
          { taskId: 'child-1', reason: 'stop please' },
          token(),
          env
        );

        expect(response.error?.message).toMatch(/no longer has 'task:write' access/);
        assertNoSideEffects(sqlite);
      } finally {
        sqlite.close();
      }
    });
  });

  // Owner-path controls. Without these, the rejection assertions above are also
  // satisfied by the handlers being broken outright.
  describe.each([
    ['owner', 'owner'],
    ['maintainer', 'maintainer'],
  ])('authorized %s actor', (_label, memberRole) => {
    it('retry_subtask stops the child and starts a replacement', async () => {
      const { sqlite, env } = await createFixture(memberRole);
      try {
        const response = await handleRetrySubtask(1, { taskId: 'child-1' }, token(), env);

        expect(response.error).toBeUndefined();
        expect(mocks.stopAgentSessionOnNode).toHaveBeenCalledTimes(1);
        expect(mocks.startTaskRunnerDO).toHaveBeenCalledTimes(1);
        expect(childStatus(sqlite)).toBe('failed');
        expect(taskCount(sqlite)).toBe(3);
      } finally {
        sqlite.close();
      }
    });

    it('stop_subtask stops the child agent', async () => {
      const { sqlite, env } = await createFixture(memberRole);
      try {
        const response = await handleStopSubtask(1, { taskId: 'child-1' }, token(), env);

        expect(response.error).toBeUndefined();
        expect(mocks.stopAgentSessionOnNode).toHaveBeenCalledTimes(1);
      } finally {
        sqlite.close();
      }
    });
  });

  it('still enforces the parent-only boundary for an authorized actor', async () => {
    const { sqlite, env } = await createFixture('owner');
    try {
      // A live sibling that the caller did not dispatch.
      seedTask(sqlite, { id: 'other-1', parentTaskId: 'other-parent', status: 'in_progress' });

      const response = await handleRetrySubtask(1, { taskId: 'other-1' }, token(), env);

      expect(response.error?.message).toMatch(/direct parent/);
      expect(mocks.stopAgentSessionOnNode).not.toHaveBeenCalled();
      expect(mocks.startTaskRunnerDO).not.toHaveBeenCalled();
    } finally {
      sqlite.close();
    }
  });

  it('rejects an actor whose current membership is in another project', async () => {
    const { sqlite, env } = await createFixture('owner');
    try {
      // The actor is an owner of a DIFFERENT project. Their token still names
      // project-1, which is where the child lives.
      sqlite
        .prepare(`UPDATE project_members SET project_id = 'project-2' WHERE user_id = ?`)
        .run(ACTOR_ID);

      const response = await handleRetrySubtask(1, { taskId: 'child-1' }, token(), env);

      expect(response.error?.message).toMatch(/no longer has 'task:write' access/);
      assertNoSideEffects(sqlite);
    } finally {
      sqlite.close();
    }
  });
});
