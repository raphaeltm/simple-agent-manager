import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/env';
import { createTriggerWebhookRoutes } from '../../src/routes/trigger-webhooks';
import { runTriggerExecutionCleanup } from '../../src/scheduled/trigger-execution-cleanup';
import type { TriggerTaskSubmitter } from '../../src/services/trigger-admission';
import { TriggerTaskSubmissionPendingError } from '../../src/services/trigger-submission';
import { reconcileStaleWebhookDeliveries } from '../../src/services/webhook-delivery-reconciliation';
import {
  generateWebhookToken,
  getWebhookTokenLastFour,
  hashWebhookToken,
} from '../../src/services/webhook-trigger-crypto';
import {
  createWebhookDelivery,
  findWebhookTriggerByToken,
  listWebhookDeliveries,
  purgeExpiredWebhookDeliveries,
  rotateWebhookToken,
} from '../../src/services/webhook-trigger-store';
import { createMemoryKv, createSqliteD1 } from '../helpers/sqlite-d1';

const SCHEMA = `
CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE agent_profiles (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL);
CREATE TABLE triggers (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT NOT NULL,
  description TEXT, status TEXT NOT NULL DEFAULT 'active', source_type TEXT NOT NULL,
  cron_expression TEXT, cron_timezone TEXT DEFAULT 'UTC', skip_if_running INTEGER NOT NULL DEFAULT 1,
  prompt_template TEXT NOT NULL, agent_profile_id TEXT, skill_id TEXT, task_mode TEXT DEFAULT 'task',
  vm_size_override TEXT, max_concurrent INTEGER NOT NULL DEFAULT 1, last_triggered_at TEXT,
  trigger_count INTEGER NOT NULL DEFAULT 0, next_execution_sequence INTEGER NOT NULL DEFAULT 1,
  next_fire_at TEXT, credential_blocked_reason TEXT, credential_blocked_at TEXT,
  credential_blocked_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE trigger_executions (
  id TEXT PRIMARY KEY, trigger_id TEXT NOT NULL, project_id TEXT NOT NULL, status TEXT NOT NULL,
  skip_reason TEXT, task_id TEXT, event_type TEXT, rendered_prompt TEXT, error_message TEXT,
  scheduled_at TEXT, started_at TEXT, completed_at TEXT, sequence_number INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, trigger_execution_id TEXT UNIQUE, status TEXT NOT NULL DEFAULT 'queued',
  error_message TEXT, completed_at TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE webhook_trigger_configs (
  trigger_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, token_last_four TEXT NOT NULL,
  token_created_at TEXT NOT NULL, token_rotated_at TEXT, source_label TEXT,
  filter_mode TEXT NOT NULL DEFAULT 'all', filters_json TEXT NOT NULL DEFAULT '[]',
  included_headers_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY, trigger_id TEXT NOT NULL, idempotency_key_hash TEXT,
  request_fingerprint TEXT NOT NULL, outcome TEXT NOT NULL, http_status INTEGER NOT NULL,
  body_bytes INTEGER NOT NULL, processing_token TEXT, processing_heartbeat_at TEXT,
  execution_id TEXT, error_code TEXT, received_at TEXT NOT NULL, processed_at TEXT,
  expires_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_webhook_deliveries_trigger_idempotency
  ON webhook_deliveries(trigger_id, idempotency_key_hash)
  WHERE idempotency_key_hash IS NOT NULL;
`;

const ENCRYPTION_KEY = 'integration-test-webhook-hmac-key';
const TRIGGER_ID = 'trigger-webhook-1';

function rows<T>(sqlite: Database.Database, sql: string): T[] {
  return sqlite.prepare(sql).all() as T[];
}

function deliveryRequest(token: string, body: Record<string, unknown>, idempotencyKey: string) {
  return new Request('https://api.example.test/api/webhooks/ingest', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
      'X-Event-Type': 'deployment.failed',
    },
    body: JSON.stringify(body),
  });
}

function rawDeliveryRequest(
  token: string,
  body: BodyInit,
  options: { contentType?: string; idempotencyKey?: string } = {}
) {
  const headers = new Headers({ Authorization: `Bearer ${token}` });
  if (options.contentType !== undefined) headers.set('Content-Type', options.contentType);
  if (options.idempotencyKey !== undefined) {
    headers.set('Idempotency-Key', options.idempotencyKey);
  }
  return new Request('https://api.example.test/api/webhooks/ingest', {
    method: 'POST',
    headers,
    body,
  });
}

describe('generic webhook ingress vertical slice', () => {
  let sqlite: Database.Database;
  let token: string;
  let env: Env;
  let taskRunnerStates: Map<string, unknown>;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    sqlite.exec(SCHEMA);
    taskRunnerStates = new Map();
    token = generateWebhookToken();
    const now = new Date().toISOString();
    sqlite
      .prepare('INSERT INTO projects (id, name) VALUES (?, ?)')
      .run('project-1', 'Delivery Project');
    sqlite
      .prepare('INSERT INTO agent_profiles (id, project_id, name) VALUES (?, ?, ?)')
      .run('profile-1', 'project-1', 'Webhook Agent');
    sqlite
      .prepare(
        `INSERT INTO triggers
          (id, project_id, user_id, name, description, status, source_type, skip_if_running,
           prompt_template, agent_profile_id, task_mode, max_concurrent, created_at, updated_at)
         VALUES (?, 'project-1', 'user-1', 'Deployment failures', 'Investigate failed deploys',
                 'active', 'webhook', 1, ?, 'profile-1', 'task', 1, ?, ?)`
      )
      .run(
        TRIGGER_ID,
        'Investigate deployment {{webhook.body.deployment.id}} ({{webhook.headers.x-event-type}})',
        now,
        now
      );
    sqlite
      .prepare(
        `INSERT INTO webhook_trigger_configs
          (trigger_id, token_hash, token_last_four, token_created_at, source_label,
           filter_mode, filters_json, included_headers_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'release-system', 'all', '[]', '["x-event-type"]', ?, ?)`
      )
      .run(
        TRIGGER_ID,
        await hashWebhookToken(token, ENCRYPTION_KEY),
        getWebhookTokenLastFour(token),
        now,
        now,
        now
      );
    env = {
      DATABASE: createSqliteD1(sqlite),
      KV: createMemoryKv(),
      ENCRYPTION_KEY,
      WEBHOOK_TRIGGERS_ENABLED: 'true',
      WEBHOOK_TRIGGER_RATE_LIMIT_PER_MINUTE: '100',
      WEBHOOK_INVALID_TOKEN_RATE_LIMIT_PER_MINUTE: '100',
      TASK_RUNNER: {
        idFromName: (taskId: string) => taskId,
        get: (taskId: string) => ({
          getStatus: async () => taskRunnerStates.get(taskId) ?? null,
          ensureStarted: async () => taskRunnerStates.has(taskId),
        }),
      },
    } as Env;
  });

  afterEach(() => sqlite.close());

  function appWith(submitter: TriggerTaskSubmitter) {
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/webhooks', createTriggerWebhookRoutes(submitter));
    return app;
  }

  it('carries an authenticated payload through delivery, admission, rendering, and submission', async () => {
    const submitter = vi.fn<TriggerTaskSubmitter>(async (_env, input) => ({
      taskId: `task-${input.triggerExecutionId}`,
      sessionId: `session-${input.triggerExecutionId}`,
      branchName: 'sam/deployment-failure',
    }));
    const response = await appWith(submitter).request(
      deliveryRequest(token, { deployment: { id: 'dep-42', status: 'failed' } }, 'delivery-42'),
      undefined,
      env
    );

    expect(response.status).toBe(202);
    const body = await response.json<{ accepted: boolean; executionId: string }>();
    expect(body.accepted).toBe(true);
    expect(submitter).toHaveBeenCalledOnce();
    expect(submitter.mock.calls[0]?.[1]).toMatchObject({
      triggerId: TRIGGER_ID,
      projectId: 'project-1',
      userId: 'user-1',
      triggeredBy: 'webhook',
      agentProfileId: 'profile-1',
    });
    expect(submitter.mock.calls[0]?.[1].renderedPrompt).toBe(
      'Investigate deployment dep-42 (deployment.failed)'
    );

    expect(
      rows<{ outcome: string; execution_id: string }>(
        sqlite,
        'SELECT outcome, execution_id FROM webhook_deliveries'
      )
    ).toEqual([{ outcome: 'accepted', execution_id: body.executionId }]);
    expect(
      rows<{ status: string; task_id: string; sequence_number: number }>(
        sqlite,
        'SELECT status, task_id, sequence_number FROM trigger_executions'
      )
    ).toEqual([{ status: 'running', task_id: `task-${body.executionId}`, sequence_number: 1 }]);
    expect(
      sqlite.prepare('SELECT trigger_count, next_execution_sequence FROM triggers').get()
    ).toEqual({
      trigger_count: 1,
      next_execution_sequence: 2,
    });
  });

  it('preserves JSON and blank source labels in the reported webhook prompt', async () => {
    const promptTemplate = `Take a look at the following information, received from a webhook:

---

Received At: {{webhook.receivedAt}}

Source: {{webhook.sourceLabel}}

Payload:
\`\`\`
{{webhook.payload}}
\`\`\`

Body:
\`\`\`
{{webhook.body}}
\`\`\`

Headers: {{webhook.headers}}

---

From that information, I'd like you to derive something interesting to append to the end of the project readme. Then push.`;
    sqlite
      .prepare('UPDATE triggers SET prompt_template = ? WHERE id = ?')
      .run(promptTemplate, TRIGGER_ID);
    sqlite
      .prepare(
        "UPDATE webhook_trigger_configs SET source_label = NULL, included_headers_json = '[]' WHERE trigger_id = ?"
      )
      .run(TRIGGER_ID);

    const submitter = vi.fn<TriggerTaskSubmitter>(async (_env, input) => ({
      taskId: `task-${input.triggerExecutionId}`,
      sessionId: `session-${input.triggerExecutionId}`,
      branchName: 'sam/reported-webhook',
    }));
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-14T14:37:45.437Z'));

    try {
      const response = await appWith(submitter).request(
        deliveryRequest(token, { event: { action: 'created' } }, 'reported-delivery'),
        undefined,
        env
      );

      expect(response.status).toBe(202);
      expect(submitter).toHaveBeenCalledOnce();
      const blankSource = '';
      const expectedPrompt = `Take a look at the following information, received from a webhook:

---

Received At: 2026-07-14T14:37:45.437Z

Source: ${blankSource}

Payload:
\`\`\`
{"event":{"action":"created"}}
\`\`\`

Body:
\`\`\`
{"event":{"action":"created"}}
\`\`\`

Headers: {}

---

From that information, I'd like you to derive something interesting to append to the end of the project readme. Then push.`;

      expect(submitter.mock.calls[0]?.[1].renderedPrompt).toBe(expectedPrompt);
      expect(sqlite.prepare('SELECT rendered_prompt FROM trigger_executions').get()).toEqual({
        rendered_prompt: expectedPrompt,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('records a duplicate audit entry without submitting a second execution', async () => {
    const submitter = vi.fn<TriggerTaskSubmitter>(async () => ({
      taskId: 'task-1',
      sessionId: 'session-1',
      branchName: 'sam/deployment-failure',
    }));
    const app = appWith(submitter);
    const payload = { deployment: { id: 'dep-duplicate', status: 'failed' } };

    const first = await app.request(deliveryRequest(token, payload, 'same-key'), undefined, env);
    const duplicate = await app.request(
      deliveryRequest(token, payload, 'same-key'),
      undefined,
      env
    );

    expect(first.status).toBe(202);
    expect(duplicate.status).toBe(202);
    expect(await duplicate.json()).toMatchObject({ accepted: true, duplicate: true });
    expect(submitter).toHaveBeenCalledOnce();
    expect(
      rows<{ outcome: string }>(
        sqlite,
        'SELECT outcome FROM webhook_deliveries ORDER BY received_at, id'
      )
        .map((row) => row.outcome)
        .sort()
    ).toEqual(['accepted', 'duplicate']);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM trigger_executions').get()).toEqual({
      count: 1,
    });
  });

  it('records filtered delivery metadata without reserving or submitting work', async () => {
    sqlite
      .prepare('UPDATE webhook_trigger_configs SET filters_json = ? WHERE trigger_id = ?')
      .run(
        JSON.stringify([{ path: 'deployment.status', operator: 'equals', value: 'failed' }]),
        TRIGGER_ID
      );
    const submitter = vi.fn<TriggerTaskSubmitter>();
    const response = await appWith(submitter).request(
      deliveryRequest(token, { deployment: { id: 'dep-pass', status: 'passed' } }, 'filtered'),
      undefined,
      env
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ accepted: true, filtered: true });
    expect(submitter).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT outcome, http_status FROM webhook_deliveries').get()).toEqual({
      outcome: 'filtered',
      http_status: 202,
    });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM trigger_executions').get()).toEqual({
      count: 0,
    });
  });

  it('uses uniform invalid-auth responses and persists no delivery', async () => {
    const submitter = vi.fn<TriggerTaskSubmitter>();
    const response = await appWith(submitter).request(
      deliveryRequest('sam_wh_unknown', { deployment: { id: 'dep-unknown' } }, 'invalid-auth'),
      undefined,
      env
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ accepted: false, message: 'Not found' });
    expect(submitter).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM webhook_deliveries').get()).toEqual({
      count: 0,
    });
  });

  it('hides disabled ingress and rejects invalid request envelopes before persistence', async () => {
    const submitter = vi.fn<TriggerTaskSubmitter>();
    const app = appWith(submitter);

    env.WEBHOOK_TRIGGERS_ENABLED = 'false';
    expect(
      (await app.request(deliveryRequest(token, { ok: true }, 'disabled'), undefined, env)).status
    ).toBe(404);
    env.WEBHOOK_TRIGGERS_ENABLED = 'true';

    const unsupported = await app.request(
      rawDeliveryRequest(token, '{}', { contentType: 'text/plain' }),
      undefined,
      env
    );
    expect(unsupported.status).toBe(415);

    const invalidJson = await app.request(
      rawDeliveryRequest(token, '["not-an-object"]', { contentType: 'application/json' }),
      undefined,
      env
    );
    expect(invalidJson.status).toBe(400);

    env.WEBHOOK_TRIGGER_MAX_BODY_BYTES = '8';
    const oversized = await app.request(
      rawDeliveryRequest(token, '{"too":"large"}', { contentType: 'application/json' }),
      undefined,
      env
    );
    expect(oversized.status).toBe(413);
    delete env.WEBHOOK_TRIGGER_MAX_BODY_BYTES;

    env.WEBHOOK_TRIGGER_MAX_IDEMPOTENCY_KEY_LENGTH = '4';
    const longIdempotencyKey = await app.request(
      deliveryRequest(token, { ok: true }, 'too-long'),
      undefined,
      env
    );
    expect(longIdempotencyKey.status).toBe(400);

    expect(submitter).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM webhook_deliveries').get()).toEqual({
      count: 0,
    });
  });

  it('returns a bounded retryable response when durable delivery persistence fails', async () => {
    const submitter = vi.fn<TriggerTaskSubmitter>();
    const database = env.DATABASE;
    env.DATABASE = {
      ...database,
      prepare: (sql: string) => {
        if (sql.includes('INSERT OR IGNORE INTO webhook_deliveries')) {
          throw new Error('D1 unavailable');
        }
        return database.prepare(sql);
      },
    } as D1Database;

    const response = await appWith(submitter).request(
      deliveryRequest(token, { deployment: { id: 'dep-d1-failure' } }, 'd1-failure'),
      undefined,
      env
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      accepted: false,
      message: 'Webhook could not be processed',
    });
    expect(submitter).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM webhook_deliveries').get()).toEqual({
      count: 0,
    });
  });

  it('records a configuration error when the target profile is missing', async () => {
    sqlite.prepare('UPDATE triggers SET agent_profile_id = NULL WHERE id = ?').run(TRIGGER_ID);
    const submitter = vi.fn<TriggerTaskSubmitter>();

    const response = await appWith(submitter).request(
      deliveryRequest(token, { deployment: { id: 'dep-unconfigured' } }, 'unconfigured'),
      undefined,
      env
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      accepted: false,
      message: 'Webhook trigger is not configured',
    });
    expect(submitter).not.toHaveBeenCalled();
    expect(
      sqlite.prepare('SELECT outcome, http_status, error_code FROM webhook_deliveries').get()
    ).toEqual({
      outcome: 'configuration_error',
      http_status: 503,
      error_code: 'missing_agent_profile',
    });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM trigger_executions').get()).toEqual({
      count: 0,
    });
  });

  it('audits inactive and rate-limited deliveries without extra submissions', async () => {
    const submitter = vi.fn<TriggerTaskSubmitter>(async () => ({
      taskId: 'task-active',
      sessionId: 'session-active',
      branchName: 'sam/active',
    }));
    const app = appWith(submitter);

    sqlite.prepare("UPDATE triggers SET status = 'paused' WHERE id = ?").run(TRIGGER_ID);
    const inactive = await app.request(
      deliveryRequest(token, { deployment: { id: 'dep-paused' } }, 'paused'),
      undefined,
      env
    );
    expect(inactive.status).toBe(202);
    expect(await inactive.json()).toMatchObject({ accepted: true, inactive: true });

    sqlite.prepare("UPDATE triggers SET status = 'active' WHERE id = ?").run(TRIGGER_ID);
    env.KV = createMemoryKv();
    env.WEBHOOK_TRIGGER_RATE_LIMIT_PER_MINUTE = '1';
    const accepted = await app.request(
      deliveryRequest(token, { deployment: { id: 'dep-active' } }, 'rate-first'),
      undefined,
      env
    );
    const limited = await app.request(
      deliveryRequest(token, { deployment: { id: 'dep-limited' } }, 'rate-second'),
      undefined,
      env
    );

    expect(accepted.status).toBe(202);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ accepted: false, message: 'Too many requests' });
    expect(submitter).toHaveBeenCalledOnce();
    expect(
      rows<{ outcome: string; error_code: string | null }>(
        sqlite,
        'SELECT outcome, error_code FROM webhook_deliveries ORDER BY received_at, id'
      )
    ).toEqual([
      { outcome: 'inactive', error_code: 'paused' },
      { outcome: 'accepted', error_code: null },
      { outcome: 'rate_limited', error_code: 'rate_limited' },
    ]);
  });

  it('does not consume an idempotency key while rate-limited', async () => {
    env.WEBHOOK_TRIGGER_RATE_LIMIT_PER_MINUTE = '1';
    sqlite
      .prepare('UPDATE triggers SET skip_if_running = 0, max_concurrent = 2 WHERE id = ?')
      .run(TRIGGER_ID);
    const submitter = vi.fn<TriggerTaskSubmitter>(async (_env, input) => ({
      taskId: `task-${input.triggerExecutionId}`,
      sessionId: `session-${input.triggerExecutionId}`,
      branchName: 'sam/rate-retry',
    }));
    const app = appWith(submitter);
    const retryBody = { deployment: { id: 'dep-rate-retry' } };

    expect(
      (
        await app.request(
          deliveryRequest(token, { deployment: { id: 'dep-rate-seed' } }, 'rate-seed'),
          undefined,
          env
        )
      ).status
    ).toBe(202);
    expect(
      (await app.request(deliveryRequest(token, retryBody, 'rate-retry'), undefined, env)).status
    ).toBe(429);

    env.KV = createMemoryKv();
    const retried = await app.request(
      deliveryRequest(token, retryBody, 'rate-retry'),
      undefined,
      env
    );
    expect(retried.status).toBe(202);
    expect(await retried.json()).toMatchObject({ accepted: true });
    expect(submitter).toHaveBeenCalledTimes(2);
    expect(
      sqlite
        .prepare("SELECT COUNT(*) AS count FROM webhook_deliveries WHERE outcome = 'rate_limited'")
        .get()
    ).toEqual({ count: 1 });
  });

  it('does not consume an idempotency key while configuration is invalid', async () => {
    sqlite.prepare('UPDATE triggers SET agent_profile_id = NULL WHERE id = ?').run(TRIGGER_ID);
    const submitter = vi.fn<TriggerTaskSubmitter>(async (_env, input) => ({
      taskId: `task-${input.triggerExecutionId}`,
      sessionId: `session-${input.triggerExecutionId}`,
      branchName: 'sam/config-retry',
    }));
    const app = appWith(submitter);
    const request = () =>
      deliveryRequest(token, { deployment: { id: 'dep-config-retry' } }, 'config-retry');

    expect((await app.request(request(), undefined, env)).status).toBe(503);
    sqlite
      .prepare('UPDATE triggers SET agent_profile_id = ? WHERE id = ?')
      .run('profile-1', TRIGGER_ID);
    const retried = await app.request(request(), undefined, env);

    expect(retried.status).toBe(202);
    expect(await retried.json()).toMatchObject({ accepted: true });
    expect(submitter).toHaveBeenCalledOnce();
    expect(
      rows<{ outcome: string }>(sqlite, 'SELECT outcome FROM webhook_deliveries').map(
        (row) => row.outcome
      )
    ).toEqual(expect.arrayContaining(['configuration_error', 'accepted']));
  });

  it('reserves one execution and records a monotonic skipped attempt under concurrency', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const submitter = vi.fn<TriggerTaskSubmitter>(async () => {
      await gate;
      return { taskId: 'task-1', sessionId: 'session-1', branchName: 'sam/deployment-failure' };
    });
    const app = appWith(submitter);
    const firstPromise = app.request(
      deliveryRequest(token, { deployment: { id: 'dep-a' } }, 'concurrent-a'),
      undefined,
      env
    );
    await vi.waitFor(() => expect(submitter).toHaveBeenCalledOnce());

    const second = await app.request(
      deliveryRequest(token, { deployment: { id: 'dep-b' } }, 'concurrent-b'),
      undefined,
      env
    );
    expect(await second.json()).toMatchObject({ accepted: true, skipped: 'still_running' });
    release();
    expect((await firstPromise).status).toBe(202);

    expect(submitter).toHaveBeenCalledOnce();
    expect(
      rows<{ status: string; skip_reason: string | null; sequence_number: number }>(
        sqlite,
        'SELECT status, skip_reason, sequence_number FROM trigger_executions ORDER BY sequence_number'
      )
    ).toEqual([
      { status: 'running', skip_reason: null, sequence_number: 1 },
      { status: 'skipped', skip_reason: 'still_running', sequence_number: 2 },
    ]);
  });

  it('enforces maxConcurrent when skipIfRunning is disabled', async () => {
    sqlite
      .prepare('UPDATE triggers SET skip_if_running = 0, max_concurrent = 1 WHERE id = ?')
      .run(TRIGGER_ID);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const submitter = vi.fn<TriggerTaskSubmitter>(async () => {
      await gate;
      return { taskId: 'task-max', sessionId: 'session-max', branchName: 'sam/max' };
    });
    const app = appWith(submitter);
    const firstPromise = app.request(
      deliveryRequest(token, { deployment: { id: 'dep-max-a' } }, 'max-a'),
      undefined,
      env
    );
    await vi.waitFor(() => expect(submitter).toHaveBeenCalledOnce());

    const second = await app.request(
      deliveryRequest(token, { deployment: { id: 'dep-max-b' } }, 'max-b'),
      undefined,
      env
    );
    expect(await second.json()).toMatchObject({ accepted: true, skipped: 'concurrent_limit' });
    release();
    expect((await firstPromise).status).toBe(202);

    expect(submitter).toHaveBeenCalledOnce();
    expect(
      rows<{ status: string; skip_reason: string | null; sequence_number: number }>(
        sqlite,
        'SELECT status, skip_reason, sequence_number FROM trigger_executions ORDER BY sequence_number'
      )
    ).toEqual([
      { status: 'running', skip_reason: null, sequence_number: 1 },
      { status: 'skipped', skip_reason: 'concurrent_limit', sequence_number: 2 },
    ]);
  });

  it('never resubmits a linked failed execution under the same idempotency key', async () => {
    const submitter = vi.fn<TriggerTaskSubmitter>(async () => {
      if (submitter.mock.calls.length === 1) throw new Error('TaskRunner unavailable');
      return { taskId: 'task-retry', sessionId: 'session-retry', branchName: 'sam/retry' };
    });
    const app = appWith(submitter);
    const requestBody = { deployment: { id: 'dep-fail' } };
    const response = await app.request(
      deliveryRequest(token, requestBody, 'submission-failure'),
      undefined,
      env
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      accepted: false,
      message: 'Webhook could not be processed',
    });
    expect(
      sqlite.prepare('SELECT outcome, http_status, error_code FROM webhook_deliveries').get()
    ).toEqual({
      outcome: 'internal_error',
      http_status: 503,
      error_code: 'submission_failed',
    });
    expect(sqlite.prepare('SELECT status, error_message FROM trigger_executions').get()).toEqual({
      status: 'failed',
      error_message: 'TaskRunner unavailable',
    });

    const retry = await app.request(
      deliveryRequest(token, requestBody, 'submission-failure'),
      undefined,
      env
    );
    expect(retry.status).toBe(503);
    expect(submitter).toHaveBeenCalledOnce();

    const newAttempt = await app.request(
      deliveryRequest(token, requestBody, 'submission-failure-new-attempt'),
      undefined,
      env
    );
    expect(newAttempt.status).toBe(202);
    expect(await newAttempt.json()).toMatchObject({ accepted: true });
    expect(submitter).toHaveBeenCalledTimes(2);
    expect(
      rows<{ status: string; sequence_number: number }>(
        sqlite,
        'SELECT status, sequence_number FROM trigger_executions ORDER BY sequence_number'
      )
    ).toEqual([
      { status: 'failed', sequence_number: 1 },
      { status: 'running', sequence_number: 2 },
    ]);
  });

  it('recovers the same key when processing fails after reservation but before submission', async () => {
    const database = env.DATABASE;
    let failLink = true;
    env.DATABASE = {
      ...database,
      prepare: (sql: string) => {
        if (failLink && sql.includes('UPDATE webhook_deliveries SET execution_id')) {
          failLink = false;
          throw new Error('D1 link unavailable');
        }
        return database.prepare(sql);
      },
    } as D1Database;
    const submitter = vi.fn<TriggerTaskSubmitter>(async (_env, input) => ({
      taskId: `task-${input.triggerExecutionId}`,
      sessionId: `session-${input.triggerExecutionId}`,
      branchName: 'sam/link-retry',
    }));
    const app = appWith(submitter);
    const request = () =>
      deliveryRequest(token, { deployment: { id: 'dep-link-retry' } }, 'link-retry');

    expect((await app.request(request(), undefined, env)).status).toBe(503);
    expect(submitter).not.toHaveBeenCalled();
    const retried = await app.request(request(), undefined, env);

    expect(retried.status).toBe(202);
    expect(submitter).toHaveBeenCalledOnce();
    expect(sqlite.prepare('SELECT outcome FROM webhook_deliveries').get()).toEqual({
      outcome: 'accepted',
    });
  });

  it('acknowledges a durable submission and repairs its processing audit on retry', async () => {
    const database = env.DATABASE;
    let failedFinalizations = 2;
    env.DATABASE = {
      ...database,
      prepare: (sql: string) => {
        if (
          failedFinalizations > 0 &&
          sql.includes('UPDATE webhook_deliveries') &&
          sql.includes('SET outcome = ?')
        ) {
          failedFinalizations -= 1;
          throw new Error('D1 finalization unavailable');
        }
        return database.prepare(sql);
      },
    } as D1Database;
    const submitter = vi.fn<TriggerTaskSubmitter>(async (_env, input) => {
      const taskId = `task-${input.triggerExecutionId}`;
      sqlite
        .prepare('INSERT INTO tasks (id, trigger_execution_id) VALUES (?, ?)')
        .run(taskId, input.triggerExecutionId);
      taskRunnerStates.set(taskId, { taskId, currentStep: 'node_selection' });
      return {
        taskId,
        sessionId: `session-${input.triggerExecutionId}`,
        branchName: 'sam/finalization-retry',
      };
    });
    const app = appWith(submitter);
    const request = () =>
      deliveryRequest(
        token,
        { deployment: { id: 'dep-finalization-retry' } },
        'finalization-retry'
      );

    expect((await app.request(request(), undefined, env)).status).toBe(202);
    expect(sqlite.prepare('SELECT outcome FROM webhook_deliveries').get()).toEqual({
      outcome: 'processing',
    });
    const retried = await app.request(request(), undefined, env);

    expect(retried.status).toBe(202);
    expect(await retried.json()).toMatchObject({
      accepted: true,
      duplicate: true,
      executionId: expect.any(String),
    });
    expect(submitter).toHaveBeenCalledOnce();
    expect(
      sqlite.prepare('SELECT outcome, execution_id FROM webhook_deliveries').get()
    ).toMatchObject({
      outcome: 'accepted',
      execution_id: expect.any(String),
    });
  });

  it('repairs a durable linked attempt from TaskRunner state without resubmitting', async () => {
    const submitter = vi.fn<TriggerTaskSubmitter>(async (_env, input) => {
      const taskId = `task-${input.triggerExecutionId}`;
      sqlite
        .prepare('INSERT INTO tasks (id, trigger_execution_id) VALUES (?, ?)')
        .run(taskId, input.triggerExecutionId);
      taskRunnerStates.set(taskId, { taskId, currentStep: 'node_selection' });
      return {
        taskId,
        sessionId: `session-${input.triggerExecutionId}`,
        branchName: 'sam/durable-repair',
      };
    });
    const app = appWith(submitter);
    const request = () =>
      deliveryRequest(token, { deployment: { id: 'dep-ambiguous' } }, 'ambiguous-submission');

    expect((await app.request(request(), undefined, env)).status).toBe(202);
    sqlite
      .prepare(
        `UPDATE webhook_deliveries
            SET outcome = 'internal_error', http_status = 503, error_code = 'submission_failed'
          WHERE id = (SELECT id FROM webhook_deliveries LIMIT 1)`
      )
      .run();
    expect(sqlite.prepare('SELECT outcome FROM webhook_deliveries').get()).toEqual({
      outcome: 'internal_error',
    });

    const retry = await app.request(request(), undefined, env);

    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({
      accepted: true,
      duplicate: true,
      executionId: expect.any(String),
    });
    expect(submitter).toHaveBeenCalledOnce();
    expect(sqlite.prepare('SELECT outcome FROM webhook_deliveries').get()).toEqual({
      outcome: 'accepted',
    });
    expect(sqlite.prepare('SELECT status FROM trigger_executions').get()).toEqual({
      status: 'running',
    });
    expect(sqlite.prepare('SELECT status FROM tasks').get()).toEqual({ status: 'queued' });
  });

  it('keeps an ambiguous TaskRunner start pending until durable state is observable', async () => {
    const submitter = vi.fn<TriggerTaskSubmitter>(async (_env, input) => {
      const taskId = `task-${input.triggerExecutionId}`;
      sqlite
        .prepare('INSERT INTO tasks (id, trigger_execution_id) VALUES (?, ?)')
        .run(taskId, input.triggerExecutionId);
      throw new TriggerTaskSubmissionPendingError({
        taskId,
        sessionId: `session-${input.triggerExecutionId}`,
        branchName: 'sam/pending-start',
      });
    });
    const app = appWith(submitter);
    const request = () =>
      deliveryRequest(token, { deployment: { id: 'dep-pending-start' } }, 'pending-start');

    const first = await app.request(request(), undefined, env);
    expect(first.status).toBe(503);
    expect(sqlite.prepare('SELECT outcome FROM webhook_deliveries').get()).toEqual({
      outcome: 'processing',
    });
    const execution = sqlite
      .prepare('SELECT id, status, task_id FROM trigger_executions')
      .get() as { id: string; status: string; task_id: string };
    expect(execution).toMatchObject({ status: 'running', task_id: `task-${execution.id}` });

    expect((await app.request(request(), undefined, env)).status).toBe(503);
    expect(submitter).toHaveBeenCalledOnce();

    taskRunnerStates.set(execution.task_id, {
      taskId: execution.task_id,
      currentStep: 'node_selection',
    });
    const repaired = await app.request(request(), undefined, env);
    expect(repaired.status).toBe(202);
    expect(await repaired.json()).toMatchObject({ accepted: true, duplicate: true });
    expect(submitter).toHaveBeenCalledOnce();
    expect(sqlite.prepare('SELECT outcome FROM webhook_deliveries').get()).toEqual({
      outcome: 'accepted',
    });
  });

  it('does not resubmit a linked failed task when delivery finalization was unavailable', async () => {
    const database = env.DATABASE;
    let failedFinalizations = 2;
    env.DATABASE = {
      ...database,
      prepare: (sql: string) => {
        if (
          failedFinalizations > 0 &&
          sql.includes('UPDATE webhook_deliveries') &&
          sql.includes('SET outcome = ?')
        ) {
          failedFinalizations -= 1;
          throw new Error('D1 finalization unavailable');
        }
        return database.prepare(sql);
      },
    } as D1Database;
    const submitter = vi.fn<TriggerTaskSubmitter>(async (_env, input) => {
      const taskId = `task-${input.triggerExecutionId}`;
      sqlite
        .prepare('INSERT INTO tasks (id, trigger_execution_id, status) VALUES (?, ?, ?)')
        .run(taskId, input.triggerExecutionId, 'failed');
      throw new Error('TaskRunner startup failed');
    });
    const app = appWith(submitter);
    const request = () =>
      deliveryRequest(token, { deployment: { id: 'dep-task-runner-retry' } }, 'task-runner-retry');

    expect((await app.request(request(), undefined, env)).status).toBe(503);
    expect(sqlite.prepare('SELECT outcome FROM webhook_deliveries').get()).toEqual({
      outcome: 'processing',
    });

    const retry = await app.request(request(), undefined, env);

    expect(retry.status).toBe(503);
    expect(submitter).toHaveBeenCalledOnce();
    expect(sqlite.prepare('SELECT outcome FROM webhook_deliveries').get()).toEqual({
      outcome: 'internal_error',
    });
    expect(rows<{ status: string }>(sqlite, 'SELECT status FROM tasks ORDER BY rowid')).toEqual([
      { status: 'failed' },
    ]);
  });

  it('does not retry a failed idempotency key with a different payload', async () => {
    const submitter = vi
      .fn<TriggerTaskSubmitter>()
      .mockRejectedValue(new Error('TaskRunner unavailable'));
    const app = appWith(submitter);

    expect(
      (
        await app.request(
          deliveryRequest(token, { deployment: { id: 'dep-original' } }, 'reused-key'),
          undefined,
          env
        )
      ).status
    ).toBe(503);
    const differentPayload = await app.request(
      deliveryRequest(token, { deployment: { id: 'dep-different' } }, 'reused-key'),
      undefined,
      env
    );

    expect(differentPayload.status).toBe(202);
    expect(await differentPayload.json()).toMatchObject({ accepted: true, duplicate: true });
    expect(submitter).toHaveBeenCalledOnce();
  });

  it('recovers an unsubmitted processing delivery after its lease expires', async () => {
    env.WEBHOOK_DELIVERY_PROCESSING_LEASE_SECONDS = '1';
    const original = await createWebhookDelivery(env, {
      triggerId: TRIGGER_ID,
      idempotencyKeyHash: 'lease-key',
      requestFingerprint: 'lease-fingerprint',
      bodyBytes: 12,
      receivedAt: new Date(Date.now() - 5_000).toISOString(),
    });
    const recovered = await createWebhookDelivery(env, {
      triggerId: TRIGGER_ID,
      idempotencyKeyHash: 'lease-key',
      requestFingerprint: 'lease-fingerprint',
      bodyBytes: 12,
      receivedAt: new Date().toISOString(),
    });

    expect(original).toMatchObject({ disposition: 'reserved', retry: false });
    expect(recovered).toMatchObject({ disposition: 'reserved', id: original.id, retry: true });
    expect(recovered).not.toMatchObject({ processingToken: original.processingToken });
  });

  it('does not reclaim an unlinked delivery when its observed heartbeat changes', async () => {
    env.WEBHOOK_DELIVERY_PROCESSING_LEASE_SECONDS = '1';
    const original = await createWebhookDelivery(env, {
      triggerId: TRIGGER_ID,
      idempotencyKeyHash: 'heartbeat-race-key',
      requestFingerprint: 'heartbeat-race-fingerprint',
      bodyBytes: 12,
      receivedAt: new Date(Date.now() - 5_000).toISOString(),
    });
    const database = env.DATABASE;
    let heartbeatChanged = false;
    env.DATABASE = {
      ...database,
      prepare: (sql: string) => {
        if (!heartbeatChanged && sql.includes('SET body_bytes = ?')) {
          heartbeatChanged = true;
          sqlite
            .prepare('UPDATE webhook_deliveries SET processing_heartbeat_at = ?')
            .run(new Date().toISOString());
        }
        return database.prepare(sql);
      },
    } as D1Database;

    const raced = await createWebhookDelivery(env, {
      triggerId: TRIGGER_ID,
      idempotencyKeyHash: 'heartbeat-race-key',
      requestFingerprint: 'heartbeat-race-fingerprint',
      bodyBytes: 12,
      receivedAt: new Date().toISOString(),
    });

    expect(original.disposition).toBe('reserved');
    expect(raced).toMatchObject({ disposition: 'in_flight', id: original.id });
    expect(sqlite.prepare('SELECT outcome FROM webhook_deliveries').get()).toEqual({
      outcome: 'processing',
    });
  });

  it('never takes over a linked delivery when its original owner resumes', async () => {
    env.WEBHOOK_DELIVERY_PROCESSING_LEASE_SECONDS = '1';
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    let durableSubmissions = 0;
    const submitter = vi.fn<TriggerTaskSubmitter>(async (_env, input) => {
      const taskId = `task-${input.triggerExecutionId}`;
      sqlite
        .prepare('INSERT INTO tasks (id, trigger_execution_id) VALUES (?, ?)')
        .run(taskId, input.triggerExecutionId);
      if (submitter.mock.calls.length === 1) {
        firstEntered();
        await firstGate;
      }
      taskRunnerStates.set(taskId, { taskId, currentStep: 'node_selection' });
      durableSubmissions += 1;
      return {
        taskId,
        sessionId: `session-${input.triggerExecutionId}`,
        branchName: 'sam/fenced-retry',
      };
    });
    const app = appWith(submitter);
    const request = () =>
      deliveryRequest(token, { deployment: { id: 'dep-fenced-retry' } }, 'fenced-retry');

    const originalResponse = app.request(request(), undefined, env);
    await firstStarted;
    sqlite
      .prepare('UPDATE webhook_deliveries SET processing_heartbeat_at = ?')
      .run(new Date(Date.now() - 5_000).toISOString());

    const takeover = await app.request(request(), undefined, env);
    releaseFirst();
    const original = await originalResponse;
    const repaired = await app.request(request(), undefined, env);

    expect(takeover.status).toBe(503);
    expect(original.status).toBe(202);
    expect(repaired.status).toBe(202);
    expect(await repaired.json()).toMatchObject({ accepted: true, duplicate: true });
    expect(submitter).toHaveBeenCalledOnce();
    expect(durableSubmissions).toBe(1);
    expect(sqlite.prepare('SELECT outcome FROM webhook_deliveries').get()).toEqual({
      outcome: 'accepted',
    });
    expect(rows<{ status: string }>(sqlite, 'SELECT status FROM tasks ORDER BY rowid')).toEqual([
      { status: 'queued' },
    ]);
  });

  it('fails a stale linked audit without mutating or resubmitting its task', async () => {
    env.WEBHOOK_DELIVERY_PROCESSING_LEASE_SECONDS = '1';
    const receivedAt = new Date(Date.now() - 5_000).toISOString();
    const original = await createWebhookDelivery(env, {
      triggerId: TRIGGER_ID,
      idempotencyKeyHash: 'orphaned-task-key',
      requestFingerprint: 'orphaned-task-fingerprint',
      bodyBytes: 12,
      receivedAt,
    });
    expect(original.disposition).toBe('reserved');
    if (original.disposition !== 'reserved') throw new Error('Expected reservation');
    sqlite
      .prepare(
        `INSERT INTO trigger_executions
          (id, trigger_id, project_id, status, sequence_number, created_at)
         VALUES ('execution-orphaned', ?, 'project-1', 'queued', 1, ?)`
      )
      .run(TRIGGER_ID, receivedAt);
    sqlite
      .prepare(
        `UPDATE webhook_deliveries SET execution_id = 'execution-orphaned'
          WHERE id = ? AND processing_token = ?`
      )
      .run(original.id, original.processingToken);
    sqlite
      .prepare(
        `INSERT INTO tasks (id, trigger_execution_id, status)
         VALUES ('task-orphaned', 'execution-orphaned', 'queued')`
      )
      .run();

    const recovered = await createWebhookDelivery(env, {
      triggerId: TRIGGER_ID,
      idempotencyKeyHash: 'orphaned-task-key',
      requestFingerprint: 'orphaned-task-fingerprint',
      bodyBytes: 12,
      receivedAt: new Date().toISOString(),
    });

    expect(recovered).toMatchObject({
      disposition: 'failed',
      id: original.id,
      executionId: 'execution-orphaned',
    });
    expect(sqlite.prepare("SELECT status FROM tasks WHERE id = 'task-orphaned'").get()).toEqual({
      status: 'queued',
    });
    expect(
      sqlite.prepare("SELECT status FROM trigger_executions WHERE id = 'execution-orphaned'").get()
    ).toEqual({ status: 'queued' });
    expect(
      sqlite.prepare('SELECT outcome FROM webhook_deliveries WHERE id = ?').get(original.id)
    ).toEqual({ outcome: 'internal_error' });
  });

  it('reconciles a stale no-key audit after TaskRunner starts durably', async () => {
    env.WEBHOOK_DELIVERY_PROCESSING_LEASE_SECONDS = '1';
    const receivedAt = new Date(Date.now() - 5_000).toISOString();
    const delivery = await createWebhookDelivery(env, {
      triggerId: TRIGGER_ID,
      idempotencyKeyHash: null,
      requestFingerprint: 'no-key-fingerprint',
      bodyBytes: 12,
      receivedAt,
    });
    expect(delivery.disposition).toBe('reserved');
    if (delivery.disposition !== 'reserved') throw new Error('Expected reservation');
    sqlite
      .prepare(
        `INSERT INTO trigger_executions
          (id, trigger_id, project_id, status, sequence_number, created_at)
         VALUES ('execution-no-key', ?, 'project-1', 'queued', 1, ?)`
      )
      .run(TRIGGER_ID, receivedAt);
    sqlite
      .prepare('UPDATE webhook_deliveries SET execution_id = ? WHERE id = ?')
      .run('execution-no-key', delivery.id);
    sqlite
      .prepare(
        `INSERT INTO tasks (id, trigger_execution_id, status)
         VALUES ('task-no-key', 'execution-no-key', 'queued')`
      )
      .run();
    taskRunnerStates.set('task-no-key', { taskId: 'task-no-key', currentStep: 'node_selection' });

    expect(await reconcileStaleWebhookDeliveries(env)).toBe(1);
    expect(
      sqlite.prepare('SELECT outcome, http_status, execution_id FROM webhook_deliveries').get()
    ).toEqual({ outcome: 'accepted', http_status: 202, execution_id: 'execution-no-key' });
  });

  it('fails only the stale delivery audit when no durable TaskRunner state exists', async () => {
    env.WEBHOOK_DELIVERY_PROCESSING_LEASE_SECONDS = '1';
    const receivedAt = new Date(Date.now() - 5_000).toISOString();
    const delivery = await createWebhookDelivery(env, {
      triggerId: TRIGGER_ID,
      idempotencyKeyHash: null,
      requestFingerprint: 'stale-audit-fingerprint',
      bodyBytes: 12,
      receivedAt,
    });
    expect(delivery.disposition).toBe('reserved');
    if (delivery.disposition !== 'reserved') throw new Error('Expected reservation');
    sqlite
      .prepare(
        `INSERT INTO trigger_executions
          (id, trigger_id, project_id, status, sequence_number, created_at)
         VALUES ('execution-stale-audit', ?, 'project-1', 'queued', 1, ?)`
      )
      .run(TRIGGER_ID, receivedAt);
    sqlite
      .prepare('UPDATE webhook_deliveries SET execution_id = ? WHERE id = ?')
      .run('execution-stale-audit', delivery.id);
    sqlite
      .prepare(
        `INSERT INTO tasks (id, trigger_execution_id, status)
         VALUES ('task-stale-audit', 'execution-stale-audit', 'queued')`
      )
      .run();

    expect(await reconcileStaleWebhookDeliveries(env)).toBe(1);
    expect(
      sqlite.prepare('SELECT outcome FROM webhook_deliveries WHERE id = ?').get(delivery.id)
    ).toEqual({ outcome: 'internal_error' });
    expect(
      sqlite
        .prepare("SELECT status FROM trigger_executions WHERE id = 'execution-stale-audit'")
        .get()
    ).toEqual({ status: 'queued' });
    expect(sqlite.prepare("SELECT status FROM tasks WHERE id = 'task-stale-audit'").get()).toEqual({
      status: 'queued',
    });
  });

  it('keeps generic cleanup from failing an execution with an active delivery lease', async () => {
    const createdAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const heartbeatAt = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO trigger_executions
          (id, trigger_id, project_id, status, task_id, sequence_number, created_at)
         VALUES ('execution-active-lease', ?, 'project-1', 'queued',
                 'task-active-lease', 1, ?)`
      )
      .run(TRIGGER_ID, createdAt);
    sqlite
      .prepare(
        `INSERT INTO tasks (id, trigger_execution_id, status)
         VALUES ('task-active-lease', 'execution-active-lease', 'queued')`
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO webhook_deliveries
          (id, trigger_id, request_fingerprint, outcome, http_status, body_bytes,
           processing_token, processing_heartbeat_at, execution_id, received_at, expires_at)
         VALUES ('delivery-active-lease', ?, 'active-lease-fingerprint', 'processing', 0, 12,
                 'active-lease-token', ?, 'execution-active-lease', ?, ?)`
      )
      .run(
        TRIGGER_ID,
        heartbeatAt,
        createdAt,
        new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      );
    taskRunnerStates.set('task-active-lease', {
      taskId: 'task-active-lease',
      currentStep: 'node_selection',
    });

    await runTriggerExecutionCleanup(env);

    expect(
      sqlite
        .prepare("SELECT status FROM trigger_executions WHERE id = 'execution-active-lease'")
        .get()
    ).toEqual({ status: 'queued' });
    expect(
      sqlite
        .prepare("SELECT outcome FROM webhook_deliveries WHERE id = 'delivery-active-lease'")
        .get()
    ).toEqual({ outcome: 'processing' });
  });

  it('uses a composite cursor so equal timestamps are never skipped', async () => {
    const receivedAt = '2026-07-13T12:00:00.000Z';
    const expiresAt = '2026-07-20T12:00:00.000Z';
    for (const id of ['delivery-a', 'delivery-c', 'delivery-b']) {
      sqlite
        .prepare(
          `INSERT INTO webhook_deliveries
            (id, trigger_id, request_fingerprint, outcome, http_status, body_bytes,
             received_at, processed_at, expires_at)
           VALUES (?, ?, ?, 'accepted', 202, 10, ?, ?, ?)`
        )
        .run(id, TRIGGER_ID, id, receivedAt, receivedAt, expiresAt);
    }

    const first = await listWebhookDeliveries(env, TRIGGER_ID, undefined, 2);
    const second = await listWebhookDeliveries(env, TRIGGER_ID, first.nextCursor ?? undefined, 2);

    expect(first.deliveries.map((delivery) => delivery.id)).toEqual(['delivery-c', 'delivery-b']);
    expect(second.deliveries.map((delivery) => delivery.id)).toEqual(['delivery-a']);
    expect(second.nextCursor).toBeNull();
  });

  it('bounds expired delivery cleanup per pass', async () => {
    env.WEBHOOK_DELIVERY_CLEANUP_BATCH_SIZE = '2';
    for (const id of ['expired-a', 'expired-b', 'expired-c']) {
      sqlite
        .prepare(
          `INSERT INTO webhook_deliveries
            (id, trigger_id, request_fingerprint, outcome, http_status, body_bytes,
             received_at, processed_at, expires_at)
           VALUES (?, ?, ?, 'accepted', 202, 10, ?, ?, ?)`
        )
        .run(
          id,
          TRIGGER_ID,
          id,
          '2026-07-01T00:00:00.000Z',
          '2026-07-01T00:00:00.000Z',
          '2026-07-02T00:00:00.000Z'
        );
    }

    expect(await purgeExpiredWebhookDeliveries(env)).toBe(2);
    expect(
      sqlite
        .prepare("SELECT COUNT(*) AS count FROM webhook_deliveries WHERE id LIKE 'expired-%'")
        .get()
    ).toEqual({ count: 1 });
  });

  it('rotates keyed token material and invalidates the old credential immediately', async () => {
    const rotated = await rotateWebhookToken(env, 'project-1', TRIGGER_ID);

    expect(rotated?.token).toMatch(/^sam_wh_/);
    expect(rotated?.token).not.toBe(token);
    expect(await findWebhookTriggerByToken(env, token)).toBeNull();
    expect(await findWebhookTriggerByToken(env, rotated!.token)).toMatchObject({
      trigger: { id: TRIGGER_ID, projectId: 'project-1' },
      config: { tokenLastFour: rotated!.tokenLastFour },
    });
    const stored = sqlite
      .prepare('SELECT token_hash, token_last_four, token_rotated_at FROM webhook_trigger_configs')
      .get() as Record<string, string>;
    expect(stored.token_hash).not.toContain(rotated!.token);
    expect(stored.token_last_four).toBe(rotated!.tokenLastFour);
    expect(stored.token_rotated_at).toBeTruthy();
  });
});
