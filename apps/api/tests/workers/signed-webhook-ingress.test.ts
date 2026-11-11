/**
 * Signed webhook intake in the Workers runtime, against real D1 with the real migration chain
 * (including 0235) and the real ProjectData Durable Object. The SQLite-backed integration suite
 * cannot show that the migration applies on top of production's schema, that `crypto.subtle`
 * verifies the way Node does, or that D1 reports the accept batch's row counts the way the queue
 * relies on.
 */
import { env } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { createSignedTriggerWebhookRoutes } from '../../src/routes/trigger-webhooks-signed';
import { CreateTriggerSchema } from '../../src/schemas/triggers';
import { invalidateAdminSettings } from '../../src/services/admin-settings';
import { generateEncryptionKey } from '../../src/services/encryption';
import type { TriggerTaskSubmitter } from '../../src/services/trigger-admission';
import { createTrigger } from '../../src/services/trigger-create';
import { syncTriggerExecutionStatus } from '../../src/services/trigger-execution-sync';
import { drainTriggerQueue } from '../../src/services/trigger-queue-drain';
import { setWebhookSigningSecret } from '../../src/services/webhook-signed-store';
import { readWebhookSetupStatus } from '../../src/services/webhook-trigger-setup';
import { SLACK_DOCS_EXAMPLE_SIGNING_VALUE } from '../helpers/slack-docs-example';
import { seedInstallation, seedProject, seedTask, seedUser } from './helpers/seed-d1';

const TEST_PREFIX = `signed-webhook-${Date.now()}`;
const SIGNING_SECRET = SLACK_DOCS_EXAMPLE_SIGNING_VALUE;
const CONTENT_CANARY = 'EVENT_CONTENT_CANARY_DO_NOT_LOG';

function testEnv(): Env {
  const mutable = env as unknown as Env & Record<string, unknown>;
  mutable.ENCRYPTION_KEY ??= generateEncryptionKey();
  mutable.BASE_DOMAIN ??= 'test.local';
  mutable.WEBHOOK_TRIGGERS_ENABLED = 'true';
  mutable.WEBHOOK_TRIGGER_RATE_LIMIT_PER_MINUTE = '1000';
  mutable.WEBHOOK_INGRESS_RATE_LIMIT_PER_MINUTE = '1000';
  mutable.WEBHOOK_INVALID_TOKEN_RATE_LIMIT_PER_MINUTE = '1000';
  return mutable as Env;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function slackRequest(
  triggerId: string,
  body: Record<string, unknown>,
  secret = SIGNING_SECRET
): Promise<Request> {
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  return new Request(`https://api.test.local/api/webhooks/in/${triggerId}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': `v0=${await hmacHex(secret, `v0:${timestamp}:${raw}`)}`,
    },
    body: raw,
  });
}

const mention = (eventId: string, text: string) => ({
  type: 'event_callback',
  event_id: eventId,
  event: { type: 'app_mention', text, user: 'U1' },
});

async function seedSlackTrigger(suffix: string) {
  const testEnvironment = testEnv();
  const userId = `${TEST_PREFIX}-${suffix}-user`;
  const installationId = `${TEST_PREFIX}-${suffix}-installation`;
  const projectId = `${TEST_PREFIX}-${suffix}-project`;
  const profileId = `${TEST_PREFIX}-${suffix}-profile`;
  const now = new Date().toISOString();
  await seedUser(userId, { githubId: `${TEST_PREFIX}-${suffix}-gh` });
  await seedInstallation(installationId, userId, {
    installationIdValue: `${TEST_PREFIX}-${suffix}-external-installation`,
    accountName: `${TEST_PREFIX}-${suffix}-account`,
  });
  await seedProject(projectId, userId, installationId, {
    name: `${TEST_PREFIX}-${suffix} Project`,
    repository: `${TEST_PREFIX}/${suffix}`,
  });
  await env.DATABASE.prepare(
    `INSERT INTO agent_profiles
       (id, project_id, user_id, name, agent_type, effort, created_at, updated_at)
     VALUES (?, ?, ?, 'Slack Agent', 'claude-code', 'auto', ?, ?)`
  )
    .bind(profileId, projectId, userId, now, now)
    .run();
  const db = drizzle(testEnvironment.DATABASE, { schema });
  const { created, webhookToken, webhookClaim } = await createTrigger(
    db,
    testEnvironment,
    { id: projectId, maxTriggers: null },
    userId,
    v.parse(CreateTriggerSchema, {
      name: `Slack ${suffix}`,
      sourceType: 'webhook',
      agentProfileId: profileId,
      promptTemplate: 'Slack said: {{webhook.body.event.text}}',
      webhookConfig: { verification: { scheme: 'slack_v0' } },
    })
  );
  expect(webhookToken).toBeUndefined();
  expect(webhookClaim).toBeUndefined();

  const submitter = vi.fn<TriggerTaskSubmitter>(async (_env, input) => {
    const taskId = `${TEST_PREFIX}-task-${input.triggerExecutionId}`;
    await seedTask(taskId, projectId, userId, { status: 'in_progress' });
    await env.DATABASE.prepare('UPDATE tasks SET trigger_execution_id = ? WHERE id = ?')
      .bind(input.triggerExecutionId, taskId)
      .run();
    return { taskId, sessionId: `session-${taskId}`, branchName: 'sam/slack' };
  });
  const app = new Hono<{ Bindings: Env }>().route(
    '/api/webhooks',
    createSignedTriggerWebhookRoutes(submitter)
  );
  const send = async (body: Record<string, unknown>, secret?: string) =>
    app.request(await slackRequest(created.id, body, secret), undefined, testEnvironment);
  const executions = async () =>
    (
      await env.DATABASE.prepare(
        `SELECT id, status, rendered_prompt AS prompt, task_id AS taskId FROM trigger_executions
          WHERE trigger_id = ? ORDER BY sequence_number`
      )
        .bind(created.id)
        .all<{ id: string; status: string; prompt: string | null; taskId: string | null }>()
    ).results;
  const outcomes = async () =>
    (
      await env.DATABASE.prepare(
        `SELECT outcome, error_code AS reason FROM webhook_deliveries
          WHERE trigger_id = ? ORDER BY received_at, id`
      )
        .bind(created.id)
        .all<{ outcome: string; reason: string | null }>()
    ).results;
  return {
    testEnvironment,
    userId,
    projectId,
    trigger: created,
    submitter,
    send,
    executions,
    outcomes,
  };
}

describe('signed webhook intake on Workers with real D1', () => {
  it('applies migration 0235 and stores the Slack defaults', async () => {
    const { trigger } = await seedSlackTrigger('schema');
    const row = await env.DATABASE.prepare(
      `SELECT verification_scheme, event_id_source, event_id_key, filters_json,
              signing_secret_encrypted
         FROM webhook_trigger_configs WHERE trigger_id = ?`
    )
      .bind(trigger.id)
      .first<Record<string, string | null>>();
    expect(row).toMatchObject({
      verification_scheme: 'slack_v0',
      event_id_source: 'path',
      event_id_key: 'event_id',
      signing_secret_encrypted: null,
    });
    expect(JSON.parse(row?.filters_json ?? '[]')).toHaveLength(2);
  });

  it('verifies, answers the address check, queues, de-duplicates and drains', async () => {
    const { testEnvironment, userId, projectId, trigger, submitter, send, executions, outcomes } =
      await seedSlackTrigger('flow');

    // No secret yet.
    expect((await send(mention('Ev-early', 'too early'))).status).toBe(503);
    await setWebhookSigningSecret(testEnvironment, {
      projectId,
      triggerId: trigger.id,
      userId,
      secret: SIGNING_SECRET,
    });
    const stored = await env.DATABASE.prepare(
      'SELECT signing_secret_encrypted AS ciphertext FROM webhook_trigger_configs WHERE trigger_id = ?'
    )
      .bind(trigger.id)
      .first<{ ciphertext: string }>();
    expect(stored?.ciphertext).toBeTruthy();
    expect(stored?.ciphertext).not.toContain(SIGNING_SECRET);

    // Slack's address check: answered, nothing started.
    const challenge = await send({ type: 'url_verification', challenge: 'challenge-on-workers' });
    expect(challenge.status).toBe(200);
    expect(await challenge.text()).toBe('challenge-on-workers');
    expect(await executions()).toEqual([]);

    // A forged request is refused by the Workers crypto implementation too.
    expect((await send(mention('Ev-forged', 'forged'), 'wrong-secret')).status).toBe(401);
    expect(submitter).not.toHaveBeenCalled();

    // First event starts; the D1 batch reported the committed row.
    const first = await send(mention('Ev-1', `first ${CONTENT_CANARY}`));
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ accepted: true, queued: true });
    expect(submitter).toHaveBeenCalledTimes(1);
    expect(submitter.mock.calls[0]?.[1].renderedPrompt).toBe(`Slack said: first ${CONTENT_CANARY}`);

    // The provider's retry and a second event while the first run is busy.
    expect(await (await send(mention('Ev-1', `first ${CONTENT_CANARY}`))).json()).toMatchObject({
      duplicate: true,
    });
    expect(await (await send(mention('Ev-2', 'second'))).json()).toMatchObject({ queued: true });
    expect(submitter).toHaveBeenCalledTimes(1);
    let rows = await executions();
    expect(rows.map((row) => row.status)).toEqual(['running', 'waiting']);
    // The started run's queue copy is gone; the waiting event's is the only copy it has.
    expect(rows.map((row) => row.prompt)).toEqual([null, 'Slack said: second']);
    expect(await readWebhookSetupStatus(testEnvironment, trigger, true)).toMatchObject({
      state: 'receiving',
      waiting: 1,
      lastRejection: { reason: 'invalid_signature' },
    });

    // The first run finishes; the cron drain starts the second, once.
    await env.DATABASE.prepare(`UPDATE tasks SET status = 'completed' WHERE id = ?`)
      .bind(rows[0]?.taskId)
      .run();
    await syncTriggerExecutionStatus(env.DATABASE, rows[0]?.taskId ?? '', 'completed');
    await drainTriggerQueue(testEnvironment, submitter);
    await drainTriggerQueue(testEnvironment, submitter);
    expect(submitter).toHaveBeenCalledTimes(2);
    expect(submitter.mock.calls[1]?.[1].renderedPrompt).toBe('Slack said: second');
    rows = await executions();
    expect(rows.map((row) => [row.status, row.prompt])).toEqual([
      ['completed', null],
      ['running', null],
    ]);
    expect((await outcomes()).map((row) => row.outcome).sort()).toEqual([
      'accepted',
      'accepted',
      'challenge',
      'duplicate',
      'rejected',
      'rejected',
    ]);

    // Project events were recorded without event content, signatures or the secret.
    const events = await env.DATABASE.prepare(
      `SELECT event_type AS type, event_payload_json AS payload FROM project_event_source_outbox
        WHERE project_id = ?`
    )
      .bind(projectId)
      .all<{ type: string; payload: string }>();
    const types = events.results.map((event) => event.type);
    expect(types).toEqual(
      expect.arrayContaining(['webhook.challenge', 'webhook.rejected', 'webhook.accepted'])
    );
    const recorded = JSON.stringify(events.results);
    expect(recorded).not.toContain(CONTENT_CANARY);
    expect(recorded).not.toContain(SIGNING_SECRET);
    expect(recorded).not.toContain('v0=');
  });

  it('refuses with 429 when the line is full and takes the retry once there is room', async () => {
    const { testEnvironment, userId, projectId, trigger, submitter, send, executions } =
      await seedSlackTrigger('full');
    await setWebhookSigningSecret(testEnvironment, {
      projectId,
      triggerId: trigger.id,
      userId,
      secret: SIGNING_SECRET,
    });
    await env.DATABASE.prepare(
      `INSERT OR REPLACE INTO platform_settings (key, value, updated_at) VALUES (?, ?, ?)`
    )
      .bind('operations.webhookQueueMaxPending', '1', new Date().toISOString())
      .run();
    invalidateAdminSettings(testEnvironment);
    try {
      expect((await send(mention('Ev-1', 'runs'))).status).toBe(202);
      expect((await send(mention('Ev-2', 'waits'))).status).toBe(202);
      const refused = await send(mention('Ev-3', 'refused'));
      expect(refused.status).toBe(429);
      expect(refused.headers.get('Retry-After')).toBe('60');
      const rows = await executions();
      expect(rows.map((row) => row.status)).toEqual(['running', 'waiting']);

      await env.DATABASE.prepare(`UPDATE tasks SET status = 'completed' WHERE id = ?`)
        .bind(rows[0]?.taskId)
        .run();
      await syncTriggerExecutionStatus(env.DATABASE, rows[0]?.taskId ?? '', 'completed');
      await drainTriggerQueue(testEnvironment, submitter);
      const retried = await send(mention('Ev-3', 'refused'));
      expect(retried.status).toBe(202);
      expect(await retried.json()).toMatchObject({ accepted: true, queued: true });
      expect((await executions()).map((row) => row.status)).toEqual([
        'completed',
        'running',
        'waiting',
      ]);
    } finally {
      await env.DATABASE.prepare(`DELETE FROM platform_settings WHERE key = ?`)
        .bind('operations.webhookQueueMaxPending')
        .run();
      invalidateAdminSettings(testEnvironment);
    }
  });
});
