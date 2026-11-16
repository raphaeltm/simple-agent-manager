/**
 * Inbox slice E on a real SQL engine (`.claude/rules/28`, `.claude/rules/62`): failures are
 * produced by the real writers (`markTaskFailedIfNonTerminal`, `transitionTaskToTerminal`,
 * `syncTriggerExecutionStatus`), filed by the real cron steps, read through the real inbox list,
 * and fixed through the real answer path. Only the far edges are replaced: the agent prompt
 * delivery, the notification DO and the retry tool's task runner start.
 */
import {
  answerInboxItem,
  archiveInboxItem,
  getInboxItem,
  listInbox,
  type OperationContext,
} from '@simple-agent-manager/operations';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const edges = vi.hoisted(() => ({
  acceptPromptDelivery: vi.fn(),
  retrySubtask: vi.fn(),
  createNotification: vi.fn(),
}));
vi.mock('../../../src/services/project-data', async () => ({
  ...(await vi.importActual<typeof import('../../../src/services/project-data')>(
    '../../../src/services/project-data'
  )),
  acceptPromptDelivery: edges.acceptPromptDelivery,
}));
vi.mock('../../../src/durable-objects/sam-session/tools/retry-subtask', () => ({
  retrySubtask: edges.retrySubtask,
}));

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { createOperationPorts } from '../../../src/operation-ports';
import { runInboxAutomationErrorSweep } from '../../../src/services/inbox/automation-errors';
import { runInboxAskSweep } from '../../../src/services/inbox/sweep';
import {
  fileTaskFailure,
  runInboxSystemErrorSweep,
} from '../../../src/services/inbox/system-errors';
import { markTaskFailedIfNonTerminal } from '../../../src/services/task-failure';
import { syncTriggerExecutionStatus } from '../../../src/services/trigger-execution-sync';
import {
  applySqliteMigration,
  createAllSchemaTables,
  createSqliteD1,
} from '../../helpers/sqlite-d1';

const P1 = 'proj-1';
const P2 = 'proj-2';
const CANARY = 'ghp_CANARYsecretTOKEN0123456789';
let sqlite: Database.Database;
let env: Env;

function ctx(userId: string): OperationContext {
  return {
    env,
    ports: createOperationPorts(env),
    actor: { userId, via: 'web', scopes: new Set(['sam.read', 'sam.write']) },
    requestId: 'test',
  };
}

function insert(table: string, row: Record<string, unknown>) {
  const keys = Object.keys(row);
  sqlite
    .prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...Object.values(row));
}

function task(id: string, row: Record<string, unknown> = {}) {
  insert('tasks', {
    id,
    project_id: P1,
    user_id: 'owner',
    title: `Ship ${id}`,
    status: 'queued',
    chat_session_id: `chat-${id}`,
    updated_at: new Date().toISOString(),
    ...row,
  });
}

function errorAsks(projectId = P1) {
  return sqlite
    .prepare(`SELECT * FROM asks WHERE kind = 'error' AND project_id = ? ORDER BY created_at`)
    .all(projectId) as Record<string, unknown>[];
}

function taskItem(taskId: string) {
  return sqlite
    .prepare(`SELECT * FROM asks WHERE kind = 'error' AND source_task_id = ?`)
    .get(taskId) as Record<string, unknown> | undefined;
}

beforeEach(() => {
  edges.acceptPromptDelivery.mockReset().mockResolvedValue({ message: { id: 'd' } });
  edges.retrySubtask.mockReset();
  edges.createNotification.mockReset().mockResolvedValue({ id: 'n-1' });
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  // The shipped migrations, not the drizzle mirror: the partial indexes are under test too.
  sqlite.exec('DROP TABLE asks');
  for (const file of ['0245_asks.sql', '0247_asks_questions.sql', '0248_asks_system_errors.sql'])
    applySqliteMigration(sqlite, new URL(`../../../src/db/migrations/${file}`, import.meta.url));
  for (const id of ['owner', 'colleague', 'outsider'])
    insert('users', { id, email: `${id}@x.test`, name: id, role: 'user', status: 'active' });
  insert('projects', { id: P1, user_id: 'owner', name: 'One', repository: 'o/one' });
  insert('projects', { id: P2, user_id: 'outsider', name: 'Two', repository: 'o/two' });
  for (const [project, user, role] of [
    [P1, 'owner', 'owner'],
    [P1, 'colleague', 'maintainer'],
    [P2, 'outsider', 'owner'],
  ])
    insert('project_members', { project_id: project, user_id: user, role, status: 'active' });
  env = {
    DATABASE: createSqliteD1(sqlite),
    BASE_DOMAIN: 'example.test',
    DURABLE_PROMPT_DELIVERY_ENABLED: 'true',
    ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    NOTIFICATION: {
      idFromName: (name: string) => name,
      get: () => ({
        createNotification: edges.createNotification,
        claimNotificationDeduplication: vi.fn().mockResolvedValue(true),
      }),
    },
  } as unknown as Env;
});

afterEach(() => {
  vi.restoreAllMocks();
  sqlite.close();
});

describe('failed tasks file one error item for their owner', () => {
  it('files a failed start through the real writer and the cron step, once', async () => {
    task('t-start');
    await markTaskFailedIfNonTerminal(
      env.DATABASE,
      't-start',
      'Task runner startup failed: hetzner API error (403): server limit reached'
    );

    const first = await runInboxSystemErrorSweep(env);
    expect(first.filed).toBe(1);
    const page = await listInbox(ctx('owner'), { projectId: P1 });
    expect(page.items).toHaveLength(1);
    const item = page.items[0]!;
    expect(item).toMatchObject({
      kind: 'error',
      store: 'ask',
      taskId: 't-start',
      sessionId: 'chat-t-start',
      title: "“Ship t-start” couldn't start",
      failureCount: 1,
      canAct: true,
      answerSpec: {
        type: 'actions',
        actions: [
          { id: 'retry', label: 'Retry' },
          { id: 'open_chat', label: 'Open chat' },
        ],
      },
    });
    // The body is the classifier's plain sentence (capacity), not the provider's error.
    expect(item.body).toMatch(/cloud provider refused to create a VM/);
    expect(edges.createNotification).toHaveBeenCalledTimes(1);
    expect(edges.createNotification.mock.calls[0]![1]).toMatchObject({
      type: 'error',
      actionUrl: `/projects/${P1}/inbox?item=${encodeURIComponent(item.ref)}`,
    });

    // A second tick finds nothing new: no duplicate, no second notification.
    const second = await runInboxSystemErrorSweep(env);
    expect(second.filed).toBe(0);
    expect(errorAsks()).toHaveLength(1);
    expect(edges.createNotification).toHaveBeenCalledTimes(1);
  });

  it('words a failure after the agent started as stopping before it finished', async () => {
    task('t-crash', { status: 'in_progress', started_at: new Date().toISOString() });
    await markTaskFailedIfNonTerminal(env.DATABASE, 't-crash', 'Agent process crashed (exit 137)');
    await runInboxSystemErrorSweep(env);
    expect(taskItem('t-crash')?.title).toBe('“Ship t-crash” stopped before it finished');
  });

  it('never puts the raw error, a token or a command line into the item', async () => {
    task('t-leak');
    await markTaskFailedIfNonTerminal(
      env.DATABASE,
      't-leak',
      `git clone https://x-access-token:${CANARY}@github.com/o/one failed: exit status 128`
    );
    await runInboxSystemErrorSweep(env);
    const page = await listInbox(ctx('owner'), { projectId: P1 });
    expect(page.items).toHaveLength(1);
    const single = await getInboxItem(ctx('owner'), { projectId: P1, ref: page.items[0]!.ref });
    const everything = JSON.stringify([
      page,
      single,
      errorAsks(),
      edges.createNotification.mock.calls,
    ]);
    expect(everything).not.toContain(CANARY);
    expect(everything).not.toContain('git clone');
    expect(everything).not.toContain('exit status');
  });

  it('files the VM-agent callback failure inline, and the sweep does not file it again', async () => {
    task('t-callback', { status: 'in_progress', started_at: new Date().toISOString() });
    await markTaskFailedIfNonTerminal(env.DATABASE, 't-callback', 'Agent prompt failed');
    const inline = await fileTaskFailure(env, P1, 't-callback');
    expect(inline?.created).toBe(true);
    expect((await runInboxSystemErrorSweep(env)).filed).toBe(0);
    expect(errorAsks()).toHaveLength(1);
    expect(errorAsks()[0]!.failure_count).toBe(1);
  });

  it('does not offer Retry to a task owner who cannot run the project owner’s retry', async () => {
    task('t-colleague', { user_id: 'colleague' });
    await markTaskFailedIfNonTerminal(env.DATABASE, 't-colleague', 'Session creation failed');
    await runInboxSystemErrorSweep(env);
    const [item] = (await listInbox(ctx('colleague'), { projectId: P1 })).items;
    expect(item?.answerSpec).toEqual({
      type: 'actions',
      actions: [{ id: 'open_chat', label: 'Open chat' }],
    });
  });
});

describe('normal lifecycle endings never file an item', () => {
  // Each case runs beside a genuine failure in the same tick: the liveness control proves the
  // sweep ran and read both rows, so "no item" cannot mean "nothing happened".
  const cases: Array<[string, () => Promise<void>]> = [
    [
      'a parent stopping its child for retry',
      () => markTaskFailedIfNonTerminal(env.DATABASE, 'excluded', 'Stopped by parent for retry'),
    ],
    [
      'an expected human-input expiry',
      () =>
        markTaskFailedIfNonTerminal(
          env.DATABASE,
          'excluded',
          'Human input request expired after timeout'
        ),
    ],
    [
      'a person setting the task to failed themselves',
      () =>
        markTaskFailedIfNonTerminal(env.DATABASE, 'excluded', 'Task failed', undefined, {
          actorType: 'user',
          actorId: 'owner',
        }),
    ],
    [
      'a superseded session wake',
      () =>
        markTaskFailedIfNonTerminal(
          env.DATABASE,
          'excluded',
          'Task superseded by a later session wake'
        ),
    ],
    [
      'a lifecycle outcome with no error (transitionTaskToTerminal lifecycleOutcome)',
      async () => {
        sqlite
          .prepare(
            `UPDATE tasks SET status = 'failed', error_message = NULL, updated_at = ? WHERE id = 'excluded'`
          )
          .run(new Date().toISOString());
      },
    ],
    [
      'a cancellation',
      async () => {
        sqlite
          .prepare(`UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE id = 'excluded'`)
          .run(new Date().toISOString());
      },
    ],
    [
      'completion',
      async () => {
        sqlite
          .prepare(`UPDATE tasks SET status = 'completed', updated_at = ? WHERE id = 'excluded'`)
          .run(new Date().toISOString());
      },
    ],
  ];

  it.each(cases)('%s', async (_name, end) => {
    task('excluded', { status: 'in_progress', started_at: new Date().toISOString() });
    task('genuine');
    await end();
    await markTaskFailedIfNonTerminal(env.DATABASE, 'genuine', 'Task runner startup failed');

    const stats = await runInboxSystemErrorSweep(env);
    // Liveness: the genuine failure in the same tick was filed.
    expect(taskItem('genuine')).toBeDefined();
    expect(stats.filed).toBe(1);
    expect(taskItem('excluded')).toBeUndefined();
  });
});

describe('error item tenancy', () => {
  beforeEach(async () => {
    task('t-own');
    await markTaskFailedIfNonTerminal(env.DATABASE, 't-own', 'Task runner startup failed');
    await runInboxSystemErrorSweep(env);
  });

  it('is visible to its assignee only', async () => {
    expect((await listInbox(ctx('owner'), { projectId: P1 })).items).toHaveLength(1);
    expect((await listInbox(ctx('colleague'), { projectId: P1 })).items).toHaveLength(0);
  });

  it('answers not-found to a foreign project and to a member who is not the assignee', async () => {
    const ref = `ask:${String(taskItem('t-own')!.id)}`;
    // Owner control.
    await expect(getInboxItem(ctx('owner'), { projectId: P1, ref })).resolves.toMatchObject({
      item: { ref },
    });
    // Attack: the item addressed through another project the attacker owns.
    await expect(getInboxItem(ctx('outsider'), { projectId: P2, ref })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(getInboxItem(ctx('colleague'), { projectId: P1, ref })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      answerInboxItem(ctx('outsider'), { projectId: P2, ref, action: 'retry' })
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(edges.retrySubtask).not.toHaveBeenCalled();
  });
});

describe('error item actions run the existing operations', () => {
  it('retries with the person’s authority and closes the item; a refusal leaves it open', async () => {
    task('t-retry');
    await markTaskFailedIfNonTerminal(env.DATABASE, 't-retry', 'Task runner startup failed');
    await runInboxSystemErrorSweep(env);
    const ref = `ask:${String(taskItem('t-retry')!.id)}`;

    edges.retrySubtask.mockResolvedValueOnce({ error: 'Task not found or not owned by you.' });
    await expect(
      answerInboxItem(ctx('owner'), { projectId: P1, ref, action: 'retry' })
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(taskItem('t-retry')!.status).toBe('open');

    edges.retrySubtask.mockResolvedValueOnce({ newTaskId: 't-retry-2' });
    await expect(
      answerInboxItem(ctx('owner'), { projectId: P1, ref, action: 'retry' })
    ).resolves.toEqual({ ref, outcome: 'retried', agentNotified: false });
    expect(edges.retrySubtask).toHaveBeenLastCalledWith(
      { taskId: 't-retry' },
      expect.objectContaining({ userId: 'owner' })
    );
    const closed = taskItem('t-retry')!;
    expect(closed).toMatchObject({
      status: 'done',
      dedupe_key: null,
      resolved_by_user_id: 'owner',
    });
    expect(closed.notified_at).not.toBeNull();
    // The original task is still failed: the next tick must not file it again.
    expect((await runInboxSystemErrorSweep(env)).filed).toBe(0);
    expect(errorAsks()).toHaveLength(1);
    // No agent was told anything: an error item has no filing agent.
    expect(edges.acceptPromptDelivery).not.toHaveBeenCalled();
  });

  it('refuses an action the item does not offer, and open_chat on the server', async () => {
    task('t-actions');
    await markTaskFailedIfNonTerminal(env.DATABASE, 't-actions', 'Task runner startup failed');
    await runInboxSystemErrorSweep(env);
    const ref = `ask:${String(taskItem('t-actions')!.id)}`;
    for (const action of ['resume', 'wake', 'open_chat'] as const) {
      await expect(
        answerInboxItem(ctx('owner'), { projectId: P1, ref, action })
      ).rejects.toMatchObject({ code: 'invalid_input' });
    }
    await expect(answerInboxItem(ctx('owner'), { projectId: P1, ref })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    expect(taskItem('t-actions')!.status).toBe('open');
  });

  it('archives without an agent notice, and the notice sweep leaves it alone', async () => {
    task('t-archive');
    await markTaskFailedIfNonTerminal(env.DATABASE, 't-archive', 'Task runner startup failed');
    await runInboxSystemErrorSweep(env);
    const ref = `ask:${String(taskItem('t-archive')!.id)}`;
    await expect(archiveInboxItem(ctx('owner'), { projectId: P1, ref })).resolves.toEqual({
      ref,
      outcome: 'archived',
      agentNotified: false,
    });
    expect(taskItem('t-archive')!.notified_at).not.toBeNull();
    await runInboxAskSweep(env, Date.now() + 120_000);
    expect(edges.acceptPromptDelivery).not.toHaveBeenCalled();
  });
});

describe('recovery closes the item by itself', () => {
  it('closes when the task leaves failed, and a later failure files a new item', async () => {
    task('t-again');
    await markTaskFailedIfNonTerminal(env.DATABASE, 't-again', 'Task runner startup failed');
    await runInboxSystemErrorSweep(env);
    const firstId = taskItem('t-again')!.id;

    // A person moves it back to ready and runs it (`task-status.ts` failed -> ready).
    sqlite
      .prepare(
        `UPDATE tasks SET status = 'ready', error_message = NULL, updated_at = ? WHERE id = 't-again'`
      )
      .run(new Date().toISOString());
    expect((await runInboxSystemErrorSweep(env)).closed).toBe(1);
    expect(sqlite.prepare('SELECT status, dedupe_key FROM asks WHERE id = ?').get(firstId)).toEqual(
      {
        status: 'done',
        dedupe_key: null,
      }
    );

    await new Promise((resolve) => setTimeout(resolve, 5));
    await markTaskFailedIfNonTerminal(env.DATABASE, 't-again', 'Session creation failed');
    expect((await runInboxSystemErrorSweep(env)).filed).toBe(1);
    expect(errorAsks().map((row) => row.status)).toEqual(['done', 'open']);
  });
});

describe('failing automations', () => {
  function trigger(id: string, row: Record<string, unknown> = {}) {
    insert('triggers', {
      id,
      project_id: P1,
      user_id: 'owner',
      name: `Nightly ${id}`,
      source_type: 'cron',
      status: 'active',
      cron_expression: '0 3 * * *',
      cron_timezone: 'UTC',
      prompt_template: 'Do it',
      ...row,
    });
  }

  let sequence = 0;
  async function run(triggerId: string, outcome: 'failed' | 'completed') {
    sequence += 1;
    const execId = `exec-${triggerId}-${sequence}`;
    const taskId = `task-${triggerId}-${sequence}`;
    insert('trigger_executions', {
      id: execId,
      trigger_id: triggerId,
      project_id: P1,
      status: 'running',
      sequence_number: sequence,
      scheduled_at: new Date().toISOString(),
    });
    task(taskId, { trigger_execution_id: execId, status: 'in_progress' });
    // The real writer every terminal task path calls.
    await syncTriggerExecutionStatus(
      env.DATABASE,
      taskId,
      outcome,
      outcome === 'failed' ? `Agent prompt failed: ${CANARY}` : undefined
    );
  }

  beforeEach(() => {
    sequence = 0;
  });

  it('files at the threshold (an admin setting, default 2), not below it', async () => {
    trigger('tr-two');
    trigger('tr-one');
    await run('tr-two', 'failed');
    await run('tr-two', 'failed');
    await run('tr-one', 'failed');

    const stats = await runInboxAutomationErrorSweep(env);
    expect(stats.filed).toBe(1);
    const [item] = (await listInbox(ctx('owner'), { projectId: P1 })).items;
    expect(item).toMatchObject({
      kind: 'error',
      title: 'Automation “Nightly tr-two” failed its last 2 runs',
      failureCount: 2,
      answerSpec: { type: 'acknowledge' },
      links: [{ kind: 'trigger', id: 'tr-two', label: 'Nightly tr-two' }],
    });
    expect(JSON.stringify(item)).not.toContain(CANARY);
    expect(edges.createNotification.mock.calls[0]![1]).toMatchObject({ type: 'cron_failure' });

    // A third failure updates the same item in place.
    await run('tr-two', 'failed');
    await runInboxAutomationErrorSweep(env);
    expect(errorAsks()).toHaveLength(1);
    expect(errorAsks()[0]!.failure_count).toBe(3);
    expect(edges.createNotification).toHaveBeenCalledTimes(1);
  });

  it('offers Resume when paused; resuming through the inbox reactivates and closes it', async () => {
    trigger('tr-paused');
    await run('tr-paused', 'failed');
    await run('tr-paused', 'failed');
    await run('tr-paused', 'failed');
    sqlite
      .prepare(`UPDATE triggers SET status = 'paused', next_fire_at = NULL WHERE id = 'tr-paused'`)
      .run();

    await runInboxAutomationErrorSweep(env);
    const [item] = (await listInbox(ctx('owner'), { projectId: P1 })).items;
    expect(item?.title).toBe('Automation “Nightly tr-paused” was paused after 3 failed runs');
    expect(item?.answerSpec).toEqual({
      type: 'actions',
      actions: [{ id: 'resume', label: 'Resume' }],
    });

    await expect(
      answerInboxItem(ctx('owner'), { projectId: P1, ref: item!.ref, action: 'resume' })
    ).resolves.toMatchObject({ outcome: 'resumed' });
    expect(sqlite.prepare(`SELECT status FROM triggers WHERE id = 'tr-paused'`).get()).toEqual({
      status: 'active',
    });
    expect(errorAsks()[0]).toMatchObject({ status: 'done', dedupe_key: null });
  });

  it('closes by itself after a clean run', async () => {
    trigger('tr-heal');
    await run('tr-heal', 'failed');
    await run('tr-heal', 'failed');
    await runInboxAutomationErrorSweep(env);
    expect(errorAsks()[0]!.status).toBe('open');

    await run('tr-heal', 'completed');
    expect((await runInboxAutomationErrorSweep(env)).closed).toBe(1);
    expect(errorAsks()[0]).toMatchObject({ status: 'done', dedupe_key: null });
  });
});
