import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import {
  reconcileSamDispatch,
  type SamDispatchReservation,
  validateSamDispatchReservation,
} from '../../../src/services/sam-dispatch-reservation';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({ session: vi.fn(), runner: vi.fn() }));
vi.mock('../../../src/services/project-data', () => ({ getSession: mocks.session }));
vi.mock('../../../src/services/task-runner-do', () => ({ getTaskRunnerStatus: mocks.runner }));

describe('SAM dispatch receipt observation', () => {
  let sqlite: Database.Database;
  let env: Env;
  const reservation: SamDispatchReservation = {
    taskId: 'task-reserved',
    sessionId: 'session-reserved',
    initialMessageId: 'message-reserved',
    statusEventId: 'status-reserved',
  };
  beforeEach(() => {
    vi.resetAllMocks();
    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [schema.tasks, schema.taskStatusEvents]);
    env = { DATABASE: createSqliteD1(sqlite) } as Env;
    mocks.session.mockResolvedValue({
      id: reservation.sessionId,
      taskId: reservation.taskId,
      createdByUserId: 'owner',
    });
    mocks.runner.mockResolvedValue(null);
  });
  afterEach(() => sqlite.close());

  function seed(status = 'queued', step = 'node_selection') {
    sqlite
      .prepare(
        'INSERT INTO tasks (id,project_id,user_id,chat_session_id,status,execution_step,output_branch) VALUES (?,?,?,?,?,?,?)'
      )
      .run(
        reservation.taskId,
        'project',
        'owner',
        reservation.sessionId,
        status,
        step,
        'sam/branch'
      );
    sqlite
      .prepare('INSERT INTO task_status_events(id,task_id,actor_id) VALUES (?,?,?)')
      .run(reservation.statusEventId, reservation.taskId, 'owner');
  }

  it('allows a new reserved identity, but never resubmits a missing task during recovery', async () => {
    expect(await reconcileSamDispatch(env, 'owner', 'project', reservation)).toBeNull();
    await expect(
      reconcileSamDispatch(env, 'owner', 'project', {
        ...reservation,
        reconcileOnly: true,
      })
    ).rejects.toThrow('No work was replayed');
    expect(mocks.session).not.toHaveBeenCalled();
    expect(mocks.runner).not.toHaveBeenCalled();
  });

  it('reports exact VM admission after a lost acknowledgement without restarting it', async () => {
    seed();
    mocks.runner.mockResolvedValue({
      taskId: reservation.taskId,
      projectId: 'project',
      userId: 'owner',
      config: { chatSessionId: reservation.sessionId },
    });
    await expect(reconcileSamDispatch(env, 'owner', 'project', reservation)).resolves.toMatchObject(
      {
        taskId: reservation.taskId,
        sessionId: reservation.sessionId,
        status: 'queued',
        recovered: true,
        dispatchState: 'confirmed',
      }
    );
  });

  it.each([
    null,
    {
      taskId: 'other',
      projectId: 'project',
      userId: 'owner',
      config: { chatSessionId: 'session-reserved' },
    },
    {
      taskId: 'task-reserved',
      projectId: 'project',
      userId: 'other',
      config: { chatSessionId: 'session-reserved' },
    },
    {
      taskId: 'task-reserved',
      projectId: 'project',
      userId: 'owner',
      config: { chatSessionId: 'other' },
    },
  ])('retains uncertain admission for an absent or mismatched runner: %j', async (runner) => {
    seed();
    mocks.runner.mockResolvedValue(runner);
    expect(await reconcileSamDispatch(env, 'owner', 'project', reservation)).toMatchObject({
      dispatchState: 'uncertain',
    });
  });

  it('retains uncertainty when the runner observation fails', async () => {
    seed();
    mocks.runner.mockRejectedValue(new Error('RPC disconnected'));
    expect(await reconcileSamDispatch(env, 'owner', 'project', reservation)).toMatchObject({
      dispatchState: 'uncertain',
    });
  });

  it('does not treat persisted Instant IDs as evidence of a physical launch', async () => {
    seed('queued', 'instant_persistence');
    expect(await reconcileSamDispatch(env, 'owner', 'project', reservation)).toMatchObject({
      status: 'queued',
      dispatchState: 'uncertain',
    });
    expect(mocks.runner).not.toHaveBeenCalled();
  });

  it.each(['in_progress', 'completed', 'failed', 'cancelled'])(
    'reports the persisted %s outcome truthfully without a runner lookup',
    async (status) => {
      seed(status);
      expect(await reconcileSamDispatch(env, 'owner', 'project', reservation)).toMatchObject({
        status,
        dispatchState: 'confirmed',
      });
      expect(mocks.runner).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['user_id', 'other'],
    ['project_id', 'other'],
    ['chat_session_id', 'other'],
  ])('rejects mismatched task %s before reading a session', async (column, value) => {
    seed();
    sqlite.prepare(`UPDATE tasks SET ${column}=?`).run(value);
    await expect(reconcileSamDispatch(env, 'owner', 'project', reservation)).rejects.toThrow(
      'does not match'
    );
    expect(mocks.session).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { taskId: 'other', createdByUserId: 'owner' },
    { taskId: 'task-reserved', createdByUserId: 'other' },
  ])('rejects missing or foreign canonical session: %j', async (session) => {
    seed();
    mocks.session.mockResolvedValue(session);
    await expect(reconcileSamDispatch(env, 'owner', 'project', reservation)).rejects.toThrow(
      'reserved session'
    );
    expect(mocks.runner).not.toHaveBeenCalled();
  });

  it('requires the exact admitted status-event receipt', async () => {
    seed();
    sqlite.prepare('UPDATE task_status_events SET actor_id=?').run('other');
    await expect(reconcileSamDispatch(env, 'owner', 'project', reservation)).rejects.toThrow(
      'admission receipt'
    );
  });

  it('rejects identities from other adapters or malformed server reservations', () => {
    expect(() => validateSamDispatchReservation(reservation, 'connector')).toThrow('Invalid SAM');
    expect(() =>
      validateSamDispatchReservation({ ...reservation, taskId: '../other' }, 'sam')
    ).toThrow('Invalid SAM');
    expect(() => validateSamDispatchReservation(reservation, 'sam')).not.toThrow();
  });
});
