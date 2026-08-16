import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { AppError } from '../../src/middleware/error';
import { createSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';

const authState = vi.hoisted(() => ({ userId: 'user-project-a-member' }));
const mocks = vi.hoisted(() => ({
  log: {
    warn: vi.fn(),
  },
}));

vi.mock('../../src/middleware/auth', () => ({
  getAuth: () => ({ user: { id: authState.userId } }),
}));
vi.mock('../../src/lib/logger', () => ({ log: mocks.log }));

import { executionRoutes } from '../../src/routes/triggers/executions';

const PROJECT_A_ID = '01KZT_PROJECT_A_000000000001';
const PROJECT_B_ID = '01KZT_PROJECT_B_000000000001';
const TRIGGER_A_ID = '01KZT_TRIGGER_000000000000001';
const TRIGGER_B_ID = '01KZT_TRIGGER_000000000000002';
const EXECUTION_A_ID = '01KZT_EXECUTION_0000000000001';
const EXECUTION_B_ID = '01KZT_EXECUTION_0000000000002';
const STALE_EXECUTION_ID = '01KZT_EXECUTION_0000000000003';
const STALE_TRIGGER_RELATION_ID = '01KZT_EXECUTION_0000000000004';
const CREATED_AT = '2026-08-12T01:02:03.000Z';

const NOT_FOUND_RESPONSE = {
  error: 'NOT_FOUND',
  message: 'Trigger execution not found',
};

interface ExecutionFixture {
  id: string;
  triggerId: string;
  projectId: string;
  status?: string;
  renderedPrompt?: string;
  errorMessage?: string | null;
  sequenceNumber?: number;
}

function insertExecution(sqlite: Database.Database, fixture: ExecutionFixture): void {
  sqlite
    .prepare(
      `INSERT INTO trigger_executions
        (id, trigger_id, project_id, status, skip_reason, task_id, event_type,
         rendered_prompt, error_message, scheduled_at, started_at, completed_at,
         sequence_number, created_at)
       VALUES (?, ?, ?, ?, NULL, ?, 'manual', ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      fixture.id,
      fixture.triggerId,
      fixture.projectId,
      fixture.status ?? 'completed',
      `task-for-${fixture.id}`,
      fixture.renderedPrompt ?? `Rendered prompt for ${fixture.projectId}`,
      fixture.errorMessage ?? null,
      CREATED_AT,
      CREATED_AT,
      CREATED_AT,
      fixture.sequenceNumber ?? 1,
      CREATED_AT
    );
}

describe('trigger execution detail project authorization vertical slice', () => {
  let sqlite: Database.Database;
  let app: Hono<{ Bindings: Env }>;
  let env: Env;

  beforeEach(() => {
    authState.userId = 'user-project-a-member';
    mocks.log.warn.mockReset();
    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [
      schema.projects,
      schema.projectMembers,
      schema.triggers,
      schema.triggerExecutions,
    ]);

    sqlite.prepare('INSERT INTO projects (id) VALUES (?), (?)').run(PROJECT_A_ID, PROJECT_B_ID);
    sqlite
      .prepare(
        `INSERT INTO project_members
          (project_id, user_id, role, status, invited_by, removed_at, created_at, updated_at)
         VALUES (?, ?, 'viewer', 'active', NULL, NULL, ?, ?)`
      )
      .run(PROJECT_A_ID, authState.userId, CREATED_AT, CREATED_AT);
    sqlite
      .prepare(
        `INSERT INTO triggers
          (id, project_id, user_id, name, source_type, prompt_template, created_at, updated_at)
         VALUES (?, ?, 'owner-a', 'Project A trigger', 'cron', 'A template', ?, ?),
                (?, ?, 'owner-b', 'Project B trigger', 'cron', 'B template', ?, ?)`
      )
      .run(
        TRIGGER_A_ID,
        PROJECT_A_ID,
        CREATED_AT,
        CREATED_AT,
        TRIGGER_B_ID,
        PROJECT_B_ID,
        CREATED_AT,
        CREATED_AT
      );

    insertExecution(sqlite, {
      id: EXECUTION_A_ID,
      triggerId: TRIGGER_A_ID,
      projectId: PROJECT_A_ID,
      renderedPrompt: 'Authorized project prompt',
      sequenceNumber: 7,
    });
    insertExecution(sqlite, {
      id: EXECUTION_B_ID,
      triggerId: TRIGGER_B_ID,
      projectId: PROJECT_B_ID,
      status: 'failed',
      renderedPrompt: 'Foreign project secret prompt',
      errorMessage: 'Foreign project private failure metadata',
      sequenceNumber: 8,
    });
    // Simulate a stale/inconsistent audit row whose trigger ID is shaped like a valid
    // project-A relation but whose stored project boundary says it belongs elsewhere.
    insertExecution(sqlite, {
      id: STALE_EXECUTION_ID,
      triggerId: TRIGGER_A_ID,
      projectId: PROJECT_B_ID,
      renderedPrompt: 'Stale foreign prompt',
      sequenceNumber: 9,
    });
    // Invert the stale relation as well: the duplicated execution project appears
    // authorized, but the referenced trigger belongs to project B. Both stored
    // sides of the relationship must agree with the authorized route project.
    insertExecution(sqlite, {
      id: STALE_TRIGGER_RELATION_ID,
      triggerId: TRIGGER_B_ID,
      projectId: PROJECT_A_ID,
      renderedPrompt: 'Stale cross-project trigger prompt',
      sequenceNumber: 10,
    });

    env = { DATABASE: createSqliteD1(sqlite) } as Env;
    app = new Hono<{ Bindings: Env }>();
    app.onError((error, c) => {
      if (error instanceof AppError) {
        return c.json(error.toJSON(), error.statusCode as 404);
      }
      return c.json({ error: 'INTERNAL_ERROR', message: error.message }, 500);
    });
    app.route('/api/projects/:projectId/triggers', executionRoutes);
  });

  afterEach(() => sqlite.close());

  it('preserves the complete authorized execution detail response contract', async () => {
    const response = await app.request(
      `/api/projects/${PROJECT_A_ID}/triggers/${TRIGGER_A_ID}/executions/${EXECUTION_A_ID}`,
      { method: 'GET' },
      env
    );

    expect(response.status).toBe(200);
    expect(mocks.log.warn).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      id: EXECUTION_A_ID,
      triggerId: TRIGGER_A_ID,
      projectId: PROJECT_A_ID,
      status: 'completed',
      skipReason: null,
      taskId: `task-for-${EXECUTION_A_ID}`,
      eventType: 'manual',
      renderedPrompt: 'Authorized project prompt',
      errorMessage: null,
      scheduledAt: CREATED_AT,
      startedAt: CREATED_AT,
      completedAt: CREATED_AT,
      sequenceNumber: 7,
      createdAt: CREATED_AT,
    });
  });

  it('returns the non-disclosing 404 for a valid foreign trigger and execution pair', async () => {
    expect(EXECUTION_A_ID).toHaveLength(EXECUTION_B_ID.length);
    expect(TRIGGER_A_ID).toHaveLength(TRIGGER_B_ID.length);

    const response = await app.request(
      `/api/projects/${PROJECT_A_ID}/triggers/${TRIGGER_B_ID}/executions/${EXECUTION_B_ID}`,
      { method: 'GET' },
      env
    );

    expect(response.status).toBe(404);
    expect(mocks.log.warn).toHaveBeenCalledWith('trigger_execution.access_miss_rejected', {
      routeProjectId: PROJECT_A_ID,
      requestedTriggerId: TRIGGER_B_ID,
      requestedExecutionId: EXECUTION_B_ID,
      expectedRelationship: 'execution_and_trigger_belong_to_route_project',
      action: 'rejected',
    });
    await expect(response.json()).resolves.toEqual(NOT_FOUND_RESPONSE);
  });

  it.each([
    ['missing', TRIGGER_A_ID, '01KZT_EXECUTION_9999999999999'],
    ['stale execution-project mismatch', TRIGGER_A_ID, STALE_EXECUTION_ID],
    ['stale trigger-project mismatch', TRIGGER_B_ID, STALE_TRIGGER_RELATION_ID],
  ])('returns the same 404 for a %s execution record', async (_case, triggerId, executionId) => {
    const response = await app.request(
      `/api/projects/${PROJECT_A_ID}/triggers/${triggerId}/executions/${executionId}`,
      { method: 'GET' },
      env
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual(NOT_FOUND_RESPONSE);
  });
});
