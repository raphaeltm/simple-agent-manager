import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { AppError } from '../../src/middleware/error';
import { handleGitHubWebhook } from '../../src/routes/github-webhook';
import { notifyFailedSweeps } from '../../src/scheduled/failed-sweep-notifications';
import {
  persistGitHubTriggerIntake,
  recoverGitHubTriggerDelivery,
  runGitHubTriggerRecovery,
} from '../../src/services/github-trigger-recovery';
import { handleGitHubProjectEventAdmission } from '../../src/services/github-project-event-producer';
import { TriggerTaskSubmissionPendingError } from '../../src/services/trigger-submission';
import { submitTriggeredTask } from '../../src/services/trigger-submit';
import { createAllSchemaTables, createSqliteD1WithBindLimit } from '../helpers/sqlite-d1';

// External task creation is the sole mocked trigger boundary. Signature, payload,
// scope, filters, dedup and real SQL admission/execution persistence all run.
vi.mock('../../src/services/trigger-submit', () => ({
  submitTriggeredTask: vi
    .fn()
    .mockResolvedValue({ taskId: 'task-new', sessionId: 'session-new', branchName: 'sam/new' }),
}));
vi.mock('../../src/services/github-project-event-producer', () => ({
  handleGitHubProjectEventAdmission: vi.fn().mockResolvedValue({}),
}));
vi.mock('../../src/scheduled/failed-sweep-notifications', () => ({
  notifyFailedSweeps: vi.fn().mockResolvedValue({ notifiedSweeps: 1, notificationsSent: 1 }),
}));
const SECRET = 'ephemeral-test-webhook-secret';
const payload = (event: 'issues' | 'issue_comment' | 'pull_request' | 'push' = 'issues') => ({
  ...(event === 'push' ? {} : { action: event === 'issue_comment' ? 'created' : 'opened' }),
  installation: { id: 12345 },
  repository: { id: 9876, full_name: 'Org/Repo', default_branch: 'main' },
  sender: { login: 'contributor', type: 'User' },
  ...(event === 'issues' || event === 'issue_comment'
    ? { issue: { number: 2320, title: 'Résumé 🐙 issue', body: null, labels: [{ name: 'bug' }] } }
    : {}),
  ...(event === 'issue_comment' ? { comment: { id: 55, body: '/sam please review' } } : {}),
  ...(event === 'pull_request'
    ? {
        pull_request: {
          number: 42,
          title: 'Review PR',
          body: null,
          draft: true,
          labels: [{ name: 'bug' }],
          head: { ref: 'feature/A', sha: 'abc123' },
          base: { ref: 'main', sha: 'base123' },
        },
      }
    : {}),
  ...(event === 'push'
    ? {
        ref: 'refs/heads/main',
        before: 'oldsha',
        after: 'newsha',
        head_commit: null,
        deleted: false,
      }
    : {}),
});

describe('signed GitHub webhook → scoped trigger → actual admission', () => {
  let sqlite: Database.Database;
  let env: Env;
  let pending: Promise<unknown>[];
  const app = new Hono<{ Bindings: Env }>();
  app.onError((error, c) =>
    error instanceof AppError
      ? c.json(error.toJSON(), error.statusCode as 400)
      : c.json({ error: error.message }, 500)
  );
  app.post('/api/github/webhook', handleGitHubWebhook);
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(submitTriggeredTask)
      .mockReset()
      .mockResolvedValue({ taskId: 'task-new', sessionId: 'session-new', branchName: 'sam/new' });
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    sqlite.exec(
      'DROP TABLE github_trigger_inbox; ALTER TABLE trigger_executions DROP COLUMN github_delivery_id; ALTER TABLE trigger_executions DROP COLUMN submission_recorded_at; ALTER TABLE trigger_executions DROP COLUMN admission_snapshot_json;'
    );
    sqlite.exec(
      readFileSync(
        new URL('../../src/db/migrations/0195_github_trigger_recovery.sql', import.meta.url),
        'utf8'
      )
    );
    pending = [];
    env = {
      DATABASE: createSqliteD1WithBindLimit(sqlite, 100),
      GITHUB_WEBHOOK_SECRET: SECRET,
      TRIGGER_AUTO_PAUSE_AFTER_FAILURES: '3',
    } as Env;
    sqlite
      .prepare(
        "INSERT INTO github_installations (id, installation_id, external_installation_id) VALUES ('internal-link', 'legacy-value', '12345')"
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO projects (id, user_id, name, repository, installation_id, github_repo_id, status, repo_provider) VALUES ('project', 'user', 'Project', 'org/repo', 'internal-link', 9876, 'active', 'github')"
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO triggers (id, project_id, user_id, name, status, source_type, skip_if_running, max_concurrent, prompt_template, next_execution_sequence, trigger_count) VALUES ('trigger', 'project', 'user', 'Review', 'active', 'github', 1, 1, '{{github.title}} {{github.comment}} {{github.branch}} {{github.sha}}', 1, 0)"
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO github_trigger_configs (id, trigger_id, event_type, filters_json) VALUES ('config', 'trigger', 'issues', ?)"
      )
      .run(JSON.stringify({ actions: ['opened'], labels: ['bug'] }));
  });
  afterEach(() => {
    vi.useRealTimers();
    sqlite.close();
  });
  async function deliver(
    body: unknown,
    event = 'issues',
    id = 'delivery-1',
    signatureBody?: string
  ) {
    const raw = JSON.stringify(body);
    const signature = createHmac('sha256', SECRET)
      .update(signatureBody ?? raw)
      .digest('hex');
    const response = await app.request(
      '/api/github/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hub-Signature-256': `sha256=${signature}`,
          'X-GitHub-Event': event,
          'X-GitHub-Delivery': id,
        },
        body: raw,
      },
      env,
      {
        waitUntil: (promise: Promise<unknown>) => {
          pending.push(promise);
        },
        passThroughOnException: () => {},
      }
    );
    await Promise.all(pending);
    pending = [];
    return response;
  }
  it('recovers failure after claim through same-ID replay and scheduled retry', async () => {
    sqlite.prepare('ALTER TABLE projects RENAME TO projects_unavailable').run();
    expect((await deliver(payload())).status).toBe(200);
    expect(
      sqlite
        .prepare('SELECT decision FROM github_webhook_deliveries WHERE id = ?')
        .get('delivery-1')
    ).toEqual({ decision: 'error' });
    sqlite.prepare('ALTER TABLE projects_unavailable RENAME TO projects').run();
    expect((await deliver(payload())).status).toBe(200);
    expect(submitTriggeredTask).not.toHaveBeenCalled();
    sqlite.prepare("UPDATE github_trigger_inbox SET available_at = '2000-01-01'").run();
    await runGitHubTriggerRecovery(env);
    expect(submitTriggeredTask).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM trigger_executions').get()).toEqual({
      count: 1,
    });
  });
  it('returns non-success when durable intake storage fails before ACK', async () => {
    sqlite.prepare('ALTER TABLE github_trigger_inbox RENAME TO intake_unavailable').run();
    expect((await deliver(payload())).status).toBe(500);
    expect(handleGitHubProjectEventAdmission).toHaveBeenCalledOnce();
    expect(submitTriggeredTask).not.toHaveBeenCalled();
  });
  it('does not resurrect pre-upgrade claimed deliveries', async () => {
    sqlite
      .prepare(
        "INSERT INTO github_webhook_deliveries (id,event_type,decision,created_at) VALUES ('delivery-1','issues','error','2026-10-01')"
      )
      .run();
    await deliver(payload());
    expect(submitTriggeredTask).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM github_trigger_inbox').get()).toEqual({
      n: 0,
    });
  });
  it('recovers an ACKed intake after the worker dies before starting waitUntil', async () => {
    await persistGitHubTriggerIntake(env, {
      deliveryId: 'crash',
      eventType: 'issues',
      payload: payload(),
    });
    expect(submitTriggeredTask).not.toHaveBeenCalled();
    await runGitHubTriggerRecovery(env);
    expect(submitTriggeredTask).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare('SELECT state,payload_json FROM github_trigger_inbox').get()).toEqual({
      state: 'completed',
      payload_json: null,
    });
  });
  it('recovers expired processing leases and fences simultaneous recovery attempts', async () => {
    await persistGitHubTriggerIntake(env, {
      deliveryId: 'crash',
      eventType: 'issues',
      payload: payload(),
    });
    sqlite
      .prepare(
        "UPDATE github_trigger_inbox SET state='processing', attempts=1, lease_token='dead', lease_until='2000-01-01'"
      )
      .run();
    await Promise.all([
      recoverGitHubTriggerDelivery(env, 'crash'),
      recoverGitHubTriggerDelivery(env, 'crash'),
    ]);
    expect(submitTriggeredTask).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM trigger_executions').get()).toEqual({ n: 1 });
  });
  it('reuses the same execution and immutable prompt after submission failure', async () => {
    vi.mocked(submitTriggeredTask).mockRejectedValueOnce(
      new Error('synthetic before task creation')
    );
    await deliver(payload());
    const first = vi.mocked(submitTriggeredTask).mock.calls[0]![1];
    sqlite.prepare("UPDATE triggers SET prompt_template='changed',name='changed'").run();
    sqlite.prepare("UPDATE github_trigger_inbox SET available_at='2000-01-01'").run();
    await runGitHubTriggerRecovery(env);
    const retry = vi.mocked(submitTriggeredTask).mock.calls[1]![1];
    expect(retry).toEqual(first);
    expect(sqlite.prepare('SELECT status FROM trigger_executions').get()).toEqual({
      status: 'running',
    });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM trigger_executions').get()).toEqual({ n: 1 });
    expect(
      sqlite.prepare('SELECT next_execution_sequence,trigger_count FROM triggers').get()
    ).toEqual({ next_execution_sequence: 2, trigger_count: 1 });
  });
  it('does not resubmit a consequential task after a post-submit worker crash', async () => {
    await persistGitHubTriggerIntake(env, {
      deliveryId: 'crash',
      eventType: 'issues',
      payload: payload(),
    });
    let resumed!: () => void;
    const suspended = new Promise<void>((resolve) => {
      resumed = resolve;
    });
    let entered!: () => void;
    const boundary = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.mocked(submitTriggeredTask).mockImplementationOnce(async (_env, input) => {
      sqlite
        .prepare(
          "INSERT INTO tasks (id,trigger_execution_id,status,chat_session_id,output_branch) VALUES ('task-live',?,'in_progress','session','sam/live')"
        )
        .run(input.triggerExecutionId);
      entered();
      await suspended;
      return { taskId: 'task-live', sessionId: 'session', branchName: 'sam/live' };
    });
    const oldWorker = recoverGitHubTriggerDelivery(env, 'crash');
    await boundary;
    sqlite.prepare("UPDATE github_trigger_inbox SET lease_until='2000-01-01'").run();
    await recoverGitHubTriggerDelivery(env, 'crash');
    expect(submitTriggeredTask).toHaveBeenCalledTimes(1);
    resumed();
    await oldWorker;
    expect(sqlite.prepare('SELECT state,payload_json FROM github_trigger_inbox').get()).toEqual({
      state: 'completed',
      payload_json: null,
    });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM trigger_executions').get()).toEqual({ n: 1 });
  });
  it('does not let a stale failing claimant overwrite the winner execution', async () => {
    await persistGitHubTriggerIntake(env, {
      deliveryId: 'race',
      eventType: 'issues',
      payload: payload(),
    });
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const entry = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.mocked(submitTriggeredTask).mockImplementationOnce(async () => {
      entered();
      await barrier;
      throw new Error('late synthetic failure');
    });
    const oldWorker = recoverGitHubTriggerDelivery(env, 'race');
    await entry;
    sqlite.prepare("UPDATE github_trigger_inbox SET lease_until='2000-01-01'").run();
    await recoverGitHubTriggerDelivery(env, 'race');
    release();
    await oldWorker;
    expect(sqlite.prepare('SELECT state FROM github_trigger_inbox').get()).toEqual({
      state: 'completed',
    });
    expect(
      sqlite.prepare('SELECT status,task_id,completed_at FROM trigger_executions').get()
    ).toEqual({ status: 'running', task_id: 'task-new', completed_at: null });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM trigger_executions').get()).toEqual({ n: 1 });
  });
  it('fences old failure before the new claimant commits its task boundary', async () => {
    await persistGitHubTriggerIntake(env, {
      deliveryId: 'race-before-commit',
      eventType: 'issues',
      payload: payload(),
    });
    let releaseOld!: () => void,
      releaseNew!: () => void,
      enteredOld!: () => void,
      enteredNew!: () => void;
    const oldGate = new Promise<void>((r) => {
        releaseOld = r;
      }),
      newGate = new Promise<void>((r) => {
        releaseNew = r;
      });
    const oldEntered = new Promise<void>((r) => {
        enteredOld = r;
      }),
      newEntered = new Promise<void>((r) => {
        enteredNew = r;
      });
    vi.mocked(submitTriggeredTask)
      .mockImplementationOnce(async () => {
        enteredOld();
        await oldGate;
        throw new Error('old failure before winner task commit');
      })
      .mockImplementationOnce(async () => {
        enteredNew();
        await newGate;
        return { taskId: 'winner', sessionId: 'session', branchName: 'sam/winner' };
      });
    const oldWork = recoverGitHubTriggerDelivery(env, 'race-before-commit');
    await oldEntered;
    sqlite.prepare("UPDATE github_trigger_inbox SET lease_until='2000-01-01'").run();
    const newWork = recoverGitHubTriggerDelivery(env, 'race-before-commit');
    await newEntered;
    releaseOld();
    await oldWork;
    expect(
      sqlite.prepare('SELECT status,completed_at,error_message FROM trigger_executions').get()
    ).toEqual({ status: 'queued', completed_at: null, error_message: null });
    releaseNew();
    await newWork;
    expect(
      sqlite.prepare('SELECT status,task_id,completed_at FROM trigger_executions').get()
    ).toEqual({ status: 'running', task_id: 'winner', completed_at: null });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM trigger_executions').get()).toEqual({ n: 1 });
  });
  it('keeps unconfirmed startup pending and retries the same execution', async () => {
    vi.mocked(submitTriggeredTask).mockRejectedValueOnce(
      new TriggerTaskSubmissionPendingError({
        taskId: 'task-pending',
        sessionId: 'session',
        branchName: 'sam/pending',
      })
    );
    await deliver(payload());
    expect(sqlite.prepare('SELECT state FROM github_trigger_inbox').get()).toEqual({
      state: 'pending',
    });
    sqlite.prepare("UPDATE github_trigger_inbox SET available_at='2000-01-01'").run();
    await runGitHubTriggerRecovery(env);
    expect(vi.mocked(submitTriggeredTask).mock.calls[0]![1].triggerExecutionId).toBe(
      vi.mocked(submitTriggeredTask).mock.calls[1]![1].triggerExecutionId
    );
    expect(sqlite.prepare('SELECT state,payload_json FROM github_trigger_inbox').get()).toEqual({
      state: 'completed',
      payload_json: null,
    });
  });
  it('bounds retries with backoff, erases exhausted payloads and preserves dedup tombstones', async () => {
    env.GITHUB_TRIGGER_RECOVERY_MAX_ATTEMPTS = '2';
    sqlite.prepare('ALTER TABLE projects RENAME TO projects_unavailable').run();
    await deliver(payload());
    const first = sqlite
      .prepare('SELECT attempts,state,available_at FROM github_trigger_inbox')
      .get() as { attempts: number; state: string; available_at: string };
    expect(first.attempts).toBe(1);
    expect(first.state).toBe('pending');
    expect(Date.parse(first.available_at)).toBeGreaterThan(Date.now());
    await deliver(payload());
    expect(sqlite.prepare('SELECT attempts FROM github_trigger_inbox').get()).toEqual({
      attempts: 1,
    });
    sqlite.prepare("UPDATE github_trigger_inbox SET available_at='2000-01-01'").run();
    await runGitHubTriggerRecovery(env);
    expect(
      sqlite.prepare('SELECT attempts,state,payload_json FROM github_trigger_inbox').get()
    ).toEqual({ attempts: 2, state: 'exhausted', payload_json: null });
    sqlite.prepare('ALTER TABLE projects_unavailable RENAME TO projects').run();
    await deliver(payload());
    expect(submitTriggeredTask).not.toHaveBeenCalled();
  });
  it('expires payloads and purges only expired terminal tombstones in bounded batches', async () => {
    await persistGitHubTriggerIntake(env, {
      deliveryId: 'old',
      eventType: 'issues',
      payload: payload(),
    });
    sqlite.prepare("UPDATE github_trigger_inbox SET created_at='2000-01-01'").run();
    await runGitHubTriggerRecovery(env);
    expect(sqlite.prepare('SELECT state,payload_json FROM github_trigger_inbox').get()).toEqual({
      state: 'exhausted',
      payload_json: null,
    });
    sqlite.prepare("UPDATE github_trigger_inbox SET expires_at='2000-01-01'").run();
    const stats = await runGitHubTriggerRecovery(env);
    expect(stats.purged).toBe(1);
    expect(submitTriggeredTask).not.toHaveBeenCalled();
  });
  it('rejects oversized intake without storing an event or running a task', async () => {
    env.GITHUB_TRIGGER_RECOVERY_PAYLOAD_MAX_BYTES = '1';
    expect((await deliver(payload())).status).toBe(400);
    expect(handleGitHubProjectEventAdmission).toHaveBeenCalledOnce();
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM github_trigger_inbox').get()).toEqual({
      n: 0,
    });
    expect(submitTriggeredTask).not.toHaveBeenCalled();
  });
  it('does not repeat a successful first trigger when the second trigger fails', async () => {
    sqlite
      .prepare(
        "INSERT INTO triggers (id, project_id, user_id, name, status, source_type, skip_if_running, max_concurrent, prompt_template, next_execution_sequence, trigger_count) VALUES ('trigger2','project','user','second','active','github',1,1,'second',1,0)"
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO github_trigger_configs (id,trigger_id,event_type,filters_json) VALUES ('config2','trigger2','issues','{}')"
      )
      .run();
    vi.mocked(submitTriggeredTask)
      .mockImplementationOnce(async (_env, input) => {
        sqlite
          .prepare(
            "INSERT INTO tasks (id,trigger_execution_id,status) VALUES ('task-first',?,'completed')"
          )
          .run(input.triggerExecutionId);
        return { taskId: 'task-first', sessionId: 'session', branchName: 'sam/first' };
      })
      .mockRejectedValueOnce(new Error('synthetic second failure'));
    await deliver(payload());
    sqlite.prepare("UPDATE github_trigger_inbox SET available_at='2000-01-01'").run();
    await runGitHubTriggerRecovery(env);
    expect(submitTriggeredTask).toHaveBeenCalledTimes(3);
    expect(vi.mocked(submitTriggeredTask).mock.calls.map((call) => call[1].triggerId)).toEqual([
      'trigger',
      'trigger2',
      'trigger2',
    ]);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM trigger_executions').get()).toEqual({ n: 2 });
  });
  it('preserves the concurrency slot while failed intake remains recoverable', async () => {
    vi.mocked(submitTriggeredTask).mockRejectedValueOnce(new Error('synthetic failure'));
    await deliver(payload(), 'issues', 'A');
    await deliver(payload(), 'issues', 'B');
    expect(submitTriggeredTask).toHaveBeenCalledTimes(1);
    expect(
      sqlite
        .prepare("SELECT status,skip_reason FROM trigger_executions WHERE github_delivery_id='B'")
        .get()
    ).toEqual({ status: 'skipped', skip_reason: 'still_running' });
    sqlite.prepare("UPDATE github_trigger_inbox SET available_at='2000-01-01' WHERE id='A'").run();
    await runGitHubTriggerRecovery(env);
    expect(submitTriggeredTask).toHaveBeenCalledTimes(2);
    expect(vi.mocked(submitTriggeredTask).mock.calls[0]![1].triggerExecutionId).toBe(
      vi.mocked(submitTriggeredTask).mock.calls[1]![1].triggerExecutionId
    );
  });
  it('retries task boundary persistence after a submitted task without starting another task', async () => {
    const batch = env.DATABASE.batch.bind(env.DATABASE);
    const fault = vi
      .spyOn(env.DATABASE, 'batch')
      .mockImplementation(batch)
      .mockImplementationOnce(batch)
      .mockRejectedValueOnce(new Error('synthetic boundary write failure'));
    vi.mocked(submitTriggeredTask).mockImplementationOnce(async (_env, input) => {
      sqlite
        .prepare(
          "INSERT INTO tasks(id,status,trigger_execution_id,chat_session_id,output_branch) VALUES('task-live','in_progress',?,'session','sam/live')"
        )
        .run(input.triggerExecutionId);
      return { taskId: 'task-live', sessionId: 'session', branchName: 'sam/live' };
    });
    await deliver(payload());
    expect(sqlite.prepare('SELECT state FROM github_trigger_inbox').get()).toEqual({
      state: 'pending',
    });
    sqlite.prepare("UPDATE github_trigger_inbox SET available_at='2000-01-01'").run();
    await runGitHubTriggerRecovery(env);
    expect(submitTriggeredTask).toHaveBeenCalledTimes(1);
    expect(
      sqlite.prepare('SELECT task_id,submission_recorded_at FROM trigger_executions').get()
    ).toEqual({ task_id: 'task-live', submission_recorded_at: expect.any(String) });
    expect(sqlite.prepare('SELECT trigger_count FROM triggers').get()).toEqual({
      trigger_count: 1,
    });
    fault.mockRestore();
  });
  it('keeps intake retryable if the kill switch changes after its claim', async () => {
    const prepare = env.DATABASE.prepare.bind(env.DATABASE);
    const flag = vi.spyOn(env.DATABASE, 'prepare').mockImplementation((sql) => {
      if (sql.includes('INSERT OR IGNORE INTO github_webhook_deliveries'))
        env.GITHUB_TRIGGERS_ENABLED = 'false';
      return prepare(sql);
    });
    await deliver(payload());
    expect(submitTriggeredTask).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT state,payload_json FROM github_trigger_inbox').get()).toEqual({
      state: 'pending',
      payload_json: expect.any(String),
    });
    flag.mockRestore();
    env.GITHUB_TRIGGERS_ENABLED = 'true';
    sqlite.prepare("UPDATE github_trigger_inbox SET available_at='2000-01-01'").run();
    await runGitHubTriggerRecovery(env);
    expect(submitTriggeredTask).toHaveBeenCalledTimes(1);
  });
  it('obeys the GitHub kill switch after durable intake', async () => {
    await persistGitHubTriggerIntake(env, {
      deliveryId: 'switch',
      eventType: 'issues',
      payload: payload(),
    });
    env.GITHUB_TRIGGERS_ENABLED = 'false';
    await runGitHubTriggerRecovery(env);
    expect(submitTriggeredTask).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT state,attempts FROM github_trigger_inbox').get()).toEqual({
      state: 'pending',
      attempts: 0,
    });
    env.GITHUB_TRIGGERS_ENABLED = 'true';
    await runGitHubTriggerRecovery(env);
    expect(submitTriggeredTask).toHaveBeenCalledTimes(1);
  });
  it('exhausts a crashed final attempt after its lease expires', async () => {
    env.GITHUB_TRIGGER_RECOVERY_MAX_ATTEMPTS = '1';
    await persistGitHubTriggerIntake(env, {
      deliveryId: 'last',
      eventType: 'issues',
      payload: payload(),
    });
    sqlite
      .prepare(
        "UPDATE github_trigger_inbox SET state='processing',attempts=1,lease_token='dead',lease_until='2000-01-01'"
      )
      .run();
    await runGitHubTriggerRecovery(env);
    expect(sqlite.prepare('SELECT state,payload_json FROM github_trigger_inbox').get()).toEqual({
      state: 'exhausted',
      payload_json: null,
    });
    expect(submitTriggeredTask).not.toHaveBeenCalled();
  });
  it('backs off exponentially to the configured cap', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T00:00:00Z'));
    env.GITHUB_TRIGGER_RECOVERY_RETRY_BASE_MS = '1000';
    env.GITHUB_TRIGGER_RECOVERY_RETRY_MAX_MS = '2000';
    sqlite.prepare('ALTER TABLE projects RENAME TO projects_unavailable').run();
    await deliver(payload());
    for (const delay of [1000, 2000, 2000]) {
      const row = sqlite.prepare('SELECT available_at FROM github_trigger_inbox').get() as {
        available_at: string;
      };
      expect(Date.parse(row.available_at) - Date.now()).toBe(delay);
      vi.setSystemTime(new Date(row.available_at));
      await runGitHubTriggerRecovery(env);
    }
  });
  it('bounds recovery, expiry and purge with more rows than the configured batch', async () => {
    env.GITHUB_TRIGGER_RECOVERY_BATCH_SIZE = '1';
    for (const id of ['one', 'two', 'three'])
      await persistGitHubTriggerIntake(env, {
        deliveryId: id,
        eventType: 'issues',
        payload: payload(),
      });
    const recovered = await runGitHubTriggerRecovery(env);
    expect(recovered.selected).toBe(1);
    expect(
      sqlite.prepare("SELECT COUNT(*) AS n FROM github_trigger_inbox WHERE state='pending'").get()
    ).toEqual({ n: 2 });
    sqlite.prepare("UPDATE github_trigger_inbox SET created_at='2000-01-01'").run();
    const expired = await runGitHubTriggerRecovery(env);
    expect(expired.exhausted).toBe(1);
    sqlite.prepare("UPDATE github_trigger_inbox SET expires_at='2000-01-01'").run();
    const purged = await runGitHubTriggerRecovery(env);
    expect(purged.purged).toBe(1);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM github_trigger_inbox').get()).toEqual({
      n: 2,
    });
  });
  it('defers remaining background candidates at the wall budget without blocking cron', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T00:00:00Z'));
    env.GITHUB_TRIGGER_RECOVERY_MAX_WALL_TIME_MS = '10';
    await persistGitHubTriggerIntake(env, {
      deliveryId: 'one',
      eventType: 'issues',
      payload: payload(),
    });
    await persistGitHubTriggerIntake(env, {
      deliveryId: 'two',
      eventType: 'issues',
      payload: payload(),
    });
    let release!: () => void;
    const suspended = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const entry = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.mocked(submitTriggeredTask).mockImplementationOnce(async () => {
      entered();
      await suspended;
      vi.setSystemTime(new Date(Date.now() + 11));
      return { taskId: 'first', sessionId: 'session', branchName: 'sam/first' };
    });
    const work: Promise<unknown>[] = [];
    const queued = await runGitHubTriggerRecovery(env, (p) => {
      work.push(p);
    });
    expect('recoveryQueued' in queued && queued.recoveryQueued).toBe(2);
    await entry;
    expect(sqlite.prepare("SELECT state FROM github_trigger_inbox WHERE id='one'").get()).toEqual({
      state: 'processing',
    });
    release();
    await Promise.all(work);
    expect(sqlite.prepare("SELECT state FROM github_trigger_inbox WHERE id='two'").get()).toEqual({
      state: 'pending',
    });
    expect(submitTriggeredTask).toHaveBeenCalledTimes(1);
  });
  it('reaches valid work behind a saturated failing batch and expires null leases', async () => {
    env.GITHUB_TRIGGER_RECOVERY_BATCH_SIZE = '2';
    for (const id of ['bad1', 'bad2', 'good', 'null1', 'null2'])
      await persistGitHubTriggerIntake(env, {
        deliveryId: id,
        eventType: 'issues',
        payload: payload(),
      });
    sqlite
      .prepare(
        "UPDATE github_trigger_inbox SET payload_json='not-json' WHERE id IN ('bad1','bad2')"
      )
      .run();
    sqlite
      .prepare(
        "UPDATE github_trigger_inbox SET state='processing',lease_until=NULL WHERE id IN ('null1','null2')"
      )
      .run();
    await runGitHubTriggerRecovery(env);
    expect(submitTriggeredTask).not.toHaveBeenCalled();
    await runGitHubTriggerRecovery(env);
    expect(submitTriggeredTask).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare("SELECT state FROM github_trigger_inbox WHERE id='good'").get()).toEqual({
      state: 'completed',
    });
    sqlite
      .prepare(
        "UPDATE github_trigger_inbox SET created_at='2000-01-01' WHERE id IN ('null1','null2')"
      )
      .run();
    await runGitHubTriggerRecovery(env);
    expect(
      sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM github_trigger_inbox WHERE id IN ('null1','null2') AND state='exhausted' AND payload_json IS NULL"
        )
        .get()
    ).toEqual({ n: 2 });
    expect(notifyFailedSweeps).toHaveBeenCalledWith(env, ['github_trigger_recovery_exhausted']);
  });
  it('admits Unicode issues.opened and redelivery creates exactly one execution', async () => {
    expect((await deliver(payload())).status).toBe(200);
    expect((await deliver(payload())).status).toBe(200);
    expect(submitTriggeredTask).toHaveBeenCalledTimes(1);
    expect(submitTriggeredTask).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ renderedPrompt: expect.stringContaining('Résumé 🐙 issue') })
    );
    expect(sqlite.prepare('SELECT status, sequence_number FROM trigger_executions').all()).toEqual([
      { status: 'running', sequence_number: 1 },
    ]);
    expect(
      sqlite
        .prepare('SELECT decision FROM github_webhook_deliveries WHERE id = ?')
        .get('delivery-1')
    ).toEqual({ decision: 'matched' });
  });
  it.each(['issue_comment', 'pull_request', 'push'] as const)(
    'uses realistic %s payload through admission and context',
    async (event) => {
      const filters =
        event === 'push'
          ? { branches: ['main'] }
          : event === 'pull_request'
            ? { actions: ['opened'], branches: ['feature/A'], ignoreDrafts: false }
            : { actions: ['created'], commandPrefix: '/sam' };
      sqlite
        .prepare('UPDATE github_trigger_configs SET event_type = ?, filters_json = ?')
        .run(event, JSON.stringify(filters));
      expect((await deliver(payload(event), event)).status).toBe(200);
      expect(submitTriggeredTask).toHaveBeenCalledTimes(1);
      const input = vi.mocked(submitTriggeredTask).mock.calls[0]![1];
      expect(input.renderedPrompt).toContain(
        event === 'push'
          ? 'main newsha'
          : event === 'pull_request'
            ? 'feature/A abc123'
            : '/sam please review'
      );
    }
  );
  it('matches configured tag refs and deletion pushes without inventing an action', async () => {
    sqlite
      .prepare("UPDATE github_trigger_configs SET event_type = 'push', filters_json = ?")
      .run(JSON.stringify({ branches: ['refs/tags/v1'] }));
    const body = {
      ...payload('push'),
      ref: 'refs/tags/v1',
      after: '0000000000000000000000000000000000000000',
      deleted: true,
      head_commit: null,
    };
    await deliver(body, 'push');
    expect(submitTriggeredTask).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        renderedPrompt: expect.stringContaining(
          'refs/tags/v1 0000000000000000000000000000000000000000'
        ),
      })
    );
  });

  it.each([
    ['', 'delivery-valid'],
    ['issues', ''],
  ])('rejects signed deliveries missing event or delivery headers', async (event, id) => {
    expect((await deliver(payload(), event, id)).status).toBe(400);
    expect(submitTriggeredTask).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM github_webhook_deliveries').get()).toEqual(
      { count: 0 }
    );
  });

  it('rejects exact-body signature mismatch before dedup or admission', async () => {
    expect((await deliver(payload(), 'issues', 'tampered', '{}')).status).toBe(401);
    expect(submitTriggeredTask).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM github_webhook_deliveries').get()).toEqual(
      { count: 0 }
    );
  });
  it.each([
    'wrong-installation',
    'conflicting-repo-id',
    'inactive',
    'artifacts',
    'missing-installation',
    'missing-repo-id',
    'unsafe-id',
    'legacy-wrong-installation',
  ])('rejects scope %s', async (variant) => {
    const body = payload() as Record<string, unknown>;
    if (variant === 'wrong-installation' || variant === 'legacy-wrong-installation')
      body.installation = { id: 999 };
    if (variant === 'legacy-wrong-installation')
      sqlite.prepare('UPDATE projects SET github_repo_id = NULL').run();
    if (variant === 'conflicting-repo-id') body.repository = { id: 999, full_name: 'org/repo' };
    if (variant === 'inactive') sqlite.prepare("UPDATE projects SET status = 'detached'").run();
    if (variant === 'artifacts')
      sqlite.prepare("UPDATE projects SET repo_provider = 'artifacts'").run();
    if (variant === 'missing-installation') delete body.installation;
    if (variant === 'missing-repo-id') body.repository = { full_name: 'org/repo' };
    if (variant === 'unsafe-id') body.installation = { id: Number.MAX_SAFE_INTEGER + 1 };
    expect((await deliver(body)).status).toBe(200);
    expect(submitTriggeredTask).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM trigger_executions').get()).toEqual({
      count: 0,
    });
  });
  it('routes a renamed immutable repository and allows legacy name only within its installation', async () => {
    const body = payload();
    body.repository.full_name = 'org/renamed';
    await deliver(body);
    expect(submitTriggeredTask).toHaveBeenCalledTimes(1);
    sqlite.prepare('DELETE FROM trigger_executions').run();
    sqlite.prepare('UPDATE projects SET github_repo_id = NULL').run();
    await deliver(payload(), 'issues', 'legacy');
    expect(submitTriggeredTask).toHaveBeenCalledTimes(2);
  });
  it('filters incompatible actions and draft or case-mismatched source branches before admission', async () => {
    const body = payload();
    body.action = 'closed';
    await deliver(body);
    expect(submitTriggeredTask).not.toHaveBeenCalled();
    sqlite
      .prepare("UPDATE github_trigger_configs SET event_type = 'pull_request', filters_json = ?")
      .run(JSON.stringify({ branches: ['feature/a'], ignoreDrafts: false }));
    await deliver(payload('pull_request'), 'pull_request', 'branch');
    expect(submitTriggeredTask).not.toHaveBeenCalled();
    sqlite
      .prepare('UPDATE github_trigger_configs SET filters_json = ?')
      .run(JSON.stringify({ branches: ['feature/A'], ignoreDrafts: true }));
    await deliver(payload('pull_request'), 'pull_request', 'draft');
    expect(submitTriggeredTask).not.toHaveBeenCalled();
  });
});
