import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const registerTaskWait = vi.hoisted(() => vi.fn());

vi.mock('../../../src/services/project-data', () => ({ registerTaskWait }));

import type { Env } from '../../../src/env';
import { handleWaitForSubtasks } from '../../../src/routes/mcp/task-wait-tools';
import { ORCHESTRATION_TOOLS } from '../../../src/routes/mcp/tool-definitions-orchestration-tools';
import type { McpTokenData } from '../../../src/services/mcp-token';
import { createSqliteD1 } from '../../helpers/sqlite-d1';

const tokenData: McpTokenData = {
  taskId: 'parent-1',
  projectId: 'project-1',
  userId: 'user-1',
  workspaceId: 'workspace-1',
  chatSessionId: 'session-1',
  createdAt: '2026-08-16T00:00:00.000Z',
};

function createEnv(rows: Array<Record<string, unknown>>): Env {
  const statement = {
    bind: vi.fn().mockReturnThis(),
    all: vi.fn().mockResolvedValue({ results: rows }),
  };
  return {
    DATABASE: { prepare: vi.fn(() => statement) },
    DURABLE_PROMPT_DELIVERY_ENABLED: 'true',
  } as unknown as Env;
}

function errorMessage(response: Awaited<ReturnType<typeof handleWaitForSubtasks>>): string {
  return response.error?.message ?? '';
}

describe('wait_for_subtasks MCP handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerTaskWait.mockResolvedValue({
      created: true,
      subscription: {
        id: 'wait-1',
        idempotencyKey: 'review-round-1',
        state: 'active',
        condition: 'all',
        wakeDeadline: Date.UTC(2026, 7, 17),
        children: [{ childTaskId: 'child-1' }, { childTaskId: 'child-2' }],
      },
    });
  });

  it('is advertised with the required child task IDs', () => {
    const definition = ORCHESTRATION_TOOLS.find((tool) => tool.name === 'wait_for_subtasks');
    expect(definition).toBeDefined();
    expect(definition!.inputSchema.required).toContain('taskIds');
  });

  it('registers a bounded durable wait for direct child tasks', async () => {
    const env = createEnv([
      {
        id: 'parent-1',
        status: 'in_progress',
        parent_task_id: null,
        chat_session_id: 'session-1',
      },
      {
        id: 'child-1',
        status: 'in_progress',
        parent_task_id: 'parent-1',
        chat_session_id: 'child-session-1',
      },
      {
        id: 'child-2',
        status: 'queued',
        parent_task_id: 'parent-1',
        chat_session_id: null,
      },
    ]);

    const response = await handleWaitForSubtasks(
      1,
      {
        taskIds: ['child-1', 'child-2'],
        waitKey: 'review-round-1',
        condition: 'all',
        wakeAfterSeconds: 60,
      },
      tokenData,
      env
    );

    expect(response.error).toBeUndefined();
    expect(registerTaskWait).toHaveBeenCalledWith(
      env,
      'project-1',
      expect.objectContaining({
        parentTaskId: 'parent-1',
        parentSessionId: 'session-1',
        idempotencyKey: 'review-round-1',
        condition: 'all',
        childTaskIds: ['child-1', 'child-2'],
      })
    );
    const result = response.result as { content: Array<{ text: string }> };
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      registered: true,
      waitId: 'wait-1',
      state: 'active',
    });
  });

  it('rejects a task outside the direct child lineage', async () => {
    const env = createEnv([
      {
        id: 'parent-1',
        status: 'in_progress',
        parent_task_id: null,
        chat_session_id: 'session-1',
      },
      {
        id: 'other-task',
        status: 'in_progress',
        parent_task_id: 'different-parent',
        chat_session_id: null,
      },
    ]);

    const response = await handleWaitForSubtasks(
      1,
      { taskIds: ['other-task'], waitKey: 'review-round-1' },
      tokenData,
      env
    );

    expect(errorMessage(response)).toContain('not a direct child');
    expect(registerTaskWait).not.toHaveBeenCalled();
  });

  it('rejects duplicates and waits beyond the configured maximum', async () => {
    const env = createEnv([]);

    const duplicateResponse = await handleWaitForSubtasks(
      1,
      { taskIds: ['child-1', 'child-1'], waitKey: 'review-round-1' },
      tokenData,
      env
    );
    expect(errorMessage(duplicateResponse)).toContain('unique');

    const overlongResponse = await handleWaitForSubtasks(
      2,
      {
        taskIds: ['child-1'],
        waitKey: 'review-round-1',
        wakeAfterSeconds: 24 * 60 * 60 + 1,
      },
      tokenData,
      env
    );
    expect(errorMessage(overlongResponse)).toContain('configured maximum');
  });

  it('rejects an unstable wait key and a token bound to another session', async () => {
    const rows = [
      {
        id: 'parent-1',
        status: 'in_progress',
        parent_task_id: null,
        chat_session_id: 'canonical-session',
      },
      {
        id: 'child-1',
        status: 'in_progress',
        parent_task_id: 'parent-1',
        chat_session_id: null,
      },
    ];
    expect(
      errorMessage(
        await handleWaitForSubtasks(
          1,
          { taskIds: ['child-1'], waitKey: 'contains spaces' },
          tokenData,
          createEnv(rows)
        )
      )
    ).toContain('waitKey');

    const mismatch = await handleWaitForSubtasks(
      2,
      { taskIds: ['child-1'], waitKey: 'review-round-1' },
      tokenData,
      createEnv(rows)
    );
    expect(errorMessage(mismatch)).toContain('does not match');
    expect(registerTaskWait).not.toHaveBeenCalled();
  });
});

/**
 * The `project_id = ?` predicate in `handleWaitForSubtasks`'s lineage query is a
 * cross-tenant scoping guard. `createEnv()` above uses `bind: mockReturnThis()`,
 * which ignores its arguments — it therefore CANNOT prove that predicate filters
 * anything (.claude/rules/28: a `.where()`-ignoring mock is the query-layer twin
 * of a source-contract test). These tests run against a real SQL engine instead.
 *
 * Each attack case is paired with a same-project owner control, so "nothing
 * happened" cannot pass by the guard being broken outright. Verified
 * discriminating: deleting `AND project_id = ?` from the query makes the attack
 * case fail while the control still passes.
 */
describe('wait_for_subtasks cross-project scoping (real SQL)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerTaskWait.mockResolvedValue({
      created: true,
      subscription: {
        id: 'wait-1',
        idempotencyKey: 'review-round-1',
        state: 'active',
        condition: 'all',
        wakeDeadline: Date.UTC(2026, 7, 17),
        children: [{ childTaskId: 'child-same' }],
      },
    });
  });

  function createSqlEnv(): Env {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        status TEXT NOT NULL,
        parent_task_id TEXT,
        chat_session_id TEXT
      )
    `);
    const insert = sqlite.prepare(
      'INSERT INTO tasks (id, project_id, status, parent_task_id, chat_session_id) VALUES (?, ?, ?, ?, ?)'
    );
    // Caller's own parent task, in the caller's project.
    insert.run('parent-1', 'project-1', 'in_progress', null, 'session-1');
    // Legitimate same-project child (owner control).
    insert.run('child-same', 'project-1', 'in_progress', 'parent-1', null);
    // Victim child in ANOTHER project that nonetheless names the caller's task
    // as its parent — so only the project predicate can reject it.
    insert.run('child-foreign', 'project-2', 'in_progress', 'parent-1', null);
    return {
      DATABASE: createSqliteD1(sqlite),
      DURABLE_PROMPT_DELIVERY_ENABLED: 'true',
    } as unknown as Env;
  }

  it('accepts a same-project direct child (owner control)', async () => {
    const response = await handleWaitForSubtasks(
      1,
      { taskIds: ['child-same'], waitKey: 'review-round-1' },
      tokenData,
      createSqlEnv()
    );

    expect(response.error).toBeUndefined();
    expect(registerTaskWait).toHaveBeenCalledTimes(1);
  });

  it('rejects a child task that belongs to a different project', async () => {
    const response = await handleWaitForSubtasks(
      1,
      { taskIds: ['child-foreign'], waitKey: 'review-round-1' },
      tokenData,
      createSqlEnv()
    );

    expect(response.error).toBeDefined();
    expect(registerTaskWait).not.toHaveBeenCalled();
  });

  it('rejects the whole wait when a foreign-project child is mixed with a valid one', async () => {
    const response = await handleWaitForSubtasks(
      1,
      { taskIds: ['child-same', 'child-foreign'], waitKey: 'review-round-1' },
      tokenData,
      createSqlEnv()
    );

    expect(response.error).toBeDefined();
    expect(registerTaskWait).not.toHaveBeenCalled();
  });
});
