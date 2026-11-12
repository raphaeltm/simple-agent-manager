/**
 * Signed webhook automations, end to end on a real SQL engine: the public address, signature
 * checks, Slack's address check, provider event IDs as duplicate keys, conditions, and the
 * durable queue (commit before the 202, wait while busy, drain in order, refuse when full,
 * drop on expiry, recover after an interrupted start).
 *
 * Automations are created through the real `createTrigger`, secrets saved through the real
 * store function, and events enter through the real route, so a change to any of those is
 * seen here.
 */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import * as v from 'valibot';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { createTriggerWebhookRoutes } from '../../src/routes/trigger-webhooks';
import { createSignedTriggerWebhookRoutes } from '../../src/routes/trigger-webhooks-signed';
import { CreateTriggerSchema } from '../../src/schemas/triggers';
import { invalidateAdminSettings } from '../../src/services/admin-settings';
import { generateEncryptionKey } from '../../src/services/encryption';
import type { TriggerTaskSubmitter } from '../../src/services/trigger-admission';
import { createTrigger } from '../../src/services/trigger-create';
import { syncTriggerExecutionStatus } from '../../src/services/trigger-execution-sync';
import {
  drainTriggerQueue,
  drainTriggerQueueForTrigger,
} from '../../src/services/trigger-queue-drain';
import { setWebhookSigningSecret } from '../../src/services/webhook-signed-store';
import {
  fingerprintWebhookRequest,
  generateWebhookToken,
  hashWebhookIdempotencyKey,
  hashWebhookToken,
} from '../../src/services/webhook-trigger-crypto';
import { acceptWebhookTriggerExecution } from '../../src/services/webhook-trigger-queue';
import { readWebhookSetupStatus } from '../../src/services/webhook-trigger-setup';
import { createWebhookDelivery } from '../../src/services/webhook-trigger-store';
import { SLACK_DOCS_EXAMPLE_SIGNING_VALUE } from '../helpers/slack-docs-example';
import {
  createAllSchemaTables,
  createDeclaredIndexes,
  createMemoryKv,
  createSqliteD1,
} from '../helpers/sqlite-d1';
import { seedProjectWithMember, seedUser } from '../unit/routes/capacity-pool-test-seeds';

const SLACK_SECRET = SLACK_DOCS_EXAMPLE_SIGNING_VALUE;
const GITHUB_SECRET = "It's a Secret to Everybody";
const CANARY = 'SECURITY_CANARY_DO_NOT_PERSIST';

interface DeliveryRow {
  id: string;
  outcome: string;
  http_status: number;
  error_code: string | null;
  execution_id: string | null;
}
interface ExecutionRow {
  id: string;
  status: string;
  skip_reason: string | null;
  rendered_prompt: string | null;
  sequence_number: number;
  task_id: string | null;
}

describe('signed webhook ingress vertical slice', () => {
  let sqlite: Database.Database;
  let env: Env;
  let slackTriggerId: string;
  let submitter: ReturnType<typeof vi.fn<TriggerTaskSubmitter>>;

  const deliveries = (triggerId = slackTriggerId) =>
    sqlite
      .prepare(
        `SELECT id, outcome, http_status, error_code, execution_id FROM webhook_deliveries
          WHERE trigger_id = ? ORDER BY rowid`
      )
      .all(triggerId) as DeliveryRow[];
  const executions = (triggerId = slackTriggerId) =>
    sqlite
      .prepare(
        `SELECT id, status, skip_reason, rendered_prompt, sequence_number, task_id
           FROM trigger_executions WHERE trigger_id = ? ORDER BY sequence_number`
      )
      .all(triggerId) as ExecutionRow[];
  const outcomes = (triggerId = slackTriggerId) => deliveries(triggerId).map((row) => row.outcome);
  const databaseDump = () =>
    JSON.stringify(
      ['webhook_deliveries', 'webhook_trigger_configs', 'project_event_source_outbox'].map(
        (table) => sqlite.prepare(`SELECT * FROM ${table}`).all()
      )
    );

  function app(submit: TriggerTaskSubmitter = submitter) {
    const hono = new Hono<{ Bindings: Env }>();
    hono.route('/api/webhooks', createTriggerWebhookRoutes(submit));
    hono.route('/api/webhooks', createSignedTriggerWebhookRoutes(submit));
    return hono;
  }

  async function createSigned(
    name: string,
    webhookConfig: Record<string, unknown>,
    extra: Record<string, unknown> = {}
  ) {
    const db = drizzle(env.DATABASE, { schema });
    const body = v.parse(CreateTriggerSchema, {
      name,
      sourceType: 'webhook',
      agentProfileId: 'profile',
      promptTemplate: 'Slack said: {{webhook.body.event.text}} ({{webhook.body.event_id}})',
      webhookConfig,
      ...extra,
    });
    const result = await createTrigger(db, env, { id: 'project', maxTriggers: null }, 'user', body);
    return result;
  }

  const saveSecret = (triggerId: string, secret: string) =>
    setWebhookSigningSecret(env, { projectId: 'project', triggerId, userId: 'user', secret });

  function slackRequest(
    body: Record<string, unknown> | string,
    options: {
      triggerId?: string;
      secret?: string;
      timestamp?: number;
      signature?: string | null;
      headers?: Record<string, string>;
    } = {}
  ) {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
    const headers = new Headers({
      'Content-Type': 'application/json',
      'X-Slack-Request-Timestamp': timestamp,
      ...options.headers,
    });
    const signature =
      options.signature === undefined
        ? `v0=${createHmac('sha256', options.secret ?? SLACK_SECRET)
            .update(`v0:${timestamp}:${raw}`)
            .digest('hex')}`
        : options.signature;
    if (signature !== null) headers.set('X-Slack-Signature', signature);
    return new Request(
      `https://api.example.test/api/webhooks/in/${options.triggerId ?? slackTriggerId}`,
      { method: 'POST', headers, body: raw }
    );
  }

  const mention = (eventId: string, text = 'hello there', event: Record<string, unknown> = {}) => ({
    type: 'event_callback',
    event_id: eventId,
    token: CANARY,
    event: { type: 'app_mention', text, user: 'U1', channel: 'C1', ts: '1.2', ...event },
  });

  const send = (request: Request, hono = app()) => hono.request(request, undefined, env);

  /** A run finishes: the task terminalizes and the real sync releases its run slot. */
  async function finishRun(executionId: string) {
    const taskId = `task-${executionId}`;
    sqlite.prepare(`UPDATE tasks SET status = 'completed' WHERE id = ?`).run(taskId);
    await syncTriggerExecutionStatus(env.DATABASE, taskId, 'completed');
  }

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    createDeclaredIndexes(sqlite, [
      schema.webhookDeliveries,
      schema.webhookTriggerConfigs,
      schema.triggerExecutions,
      schema.triggers,
    ]);
    seedUser(sqlite, 'user');
    seedProjectWithMember(sqlite, { projectId: 'project', userId: 'user', role: 'owner' });
    sqlite
      .prepare(`INSERT INTO agent_profiles (id, project_id, agent_type) VALUES (?, ?, ?)`)
      .run('profile', 'project', 'claude-code');
    env = {
      DATABASE: createSqliteD1(sqlite),
      KV: createMemoryKv(),
      ENCRYPTION_KEY: generateEncryptionKey(),
      BASE_DOMAIN: 'example.test',
      WEBHOOK_TRIGGER_RATE_LIMIT_PER_MINUTE: '1000',
      WEBHOOK_INGRESS_RATE_LIMIT_PER_MINUTE: '1000',
      WEBHOOK_INVALID_TOKEN_RATE_LIMIT_PER_MINUTE: '1000',
      PROJECT_DATA: {
        idFromName: (projectId: string) => projectId,
        get: () => ({
          ensureProjectId: async () => undefined,
          admitProjectEvent: async (input: { deliveryKey: string }) => ({
            outcome: 'created',
            event: { id: `event-${input.deliveryKey}`, state: 'recorded' },
            matches: [],
          }),
        }),
      },
      TASK_RUNNER: {
        idFromName: (taskId: string) => taskId,
        get: () => ({ getStatus: async () => null, ensureStarted: async () => false }),
      },
    } as unknown as Env;
    invalidateAdminSettings(env);
    submitter = vi.fn<TriggerTaskSubmitter>(async (_env, input) => {
      const taskId = `task-${input.triggerExecutionId}`;
      sqlite
        .prepare(
          `INSERT OR IGNORE INTO tasks (id, project_id, user_id, status, chat_session_id, trigger_execution_id)
           VALUES (?, 'project', 'user', 'in_progress', ?, ?)`
        )
        .run(taskId, `session-${taskId}`, input.triggerExecutionId);
      return { taskId, sessionId: `session-${taskId}`, branchName: 'sam/slack' };
    });
    const created = await createSigned('Slack mentions', { verification: { scheme: 'slack_v0' } });
    slackTriggerId = created.created.id;
    expect(created.webhookToken).toBeUndefined();
    expect(created.webhookClaim).toBeUndefined();
  });

  afterEach(() => {
    vi.useRealTimers();
    sqlite.close();
  });

  describe('setup and verification', () => {
    it('applies the Slack defaults at creation: event ID path and the mention-not-bot conditions', () => {
      const row = sqlite
        .prepare('SELECT * FROM webhook_trigger_configs WHERE trigger_id = ?')
        .get(slackTriggerId) as Record<string, string | null>;
      expect(row.verification_scheme).toBe('slack_v0');
      expect([row.event_id_source, row.event_id_key]).toEqual(['path', 'event_id']);
      expect(JSON.parse(row.filters_json ?? '[]')).toEqual([
        { path: 'event.type', operator: 'equals', value: 'app_mention' },
        { path: 'event.bot_id', operator: 'notExists' },
      ]);
      expect(row.signing_secret_encrypted).toBeNull();
    });

    it('refuses every call until a secret is saved, and starts nothing', async () => {
      const challenge = { type: 'url_verification', challenge: 'c-1', token: CANARY };
      const response = await send(slackRequest(challenge));
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain('c-1');
      expect(deliveries()).toMatchObject([
        { outcome: 'rejected', error_code: 'not_configured', http_status: 503 },
      ]);
      expect(executions()).toEqual([]);
      expect(submitter).not.toHaveBeenCalled();
    });

    it("answers Slack's address check with the challenge and creates no run", async () => {
      await saveSecret(slackTriggerId, SLACK_SECRET);
      const response = await send(
        slackRequest({ type: 'url_verification', challenge: 'challenge-value-42', token: CANARY })
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toContain('text/plain');
      expect(await response.text()).toBe('challenge-value-42');
      expect(deliveries()).toMatchObject([
        { outcome: 'challenge', http_status: 200, execution_id: null },
      ]);
      expect(executions()).toEqual([]);
      expect(sqlite.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 0 });
      expect(submitter).not.toHaveBeenCalled();
    });

    it('does not answer a challenge whose signature is wrong', async () => {
      await saveSecret(slackTriggerId, SLACK_SECRET);
      const response = await send(
        slackRequest(
          { type: 'url_verification', challenge: 'c-forged' },
          { secret: 'wrong-secret' }
        )
      );
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain('c-forged');
      expect(outcomes()).toEqual(['rejected']);
    });

    it('refuses forged, unsigned and stale requests, records one row per reason, and keeps no content', async () => {
      await saveSecret(slackTriggerId, SLACK_SECRET);
      const event = mention('Ev-forged', `please run ${CANARY}`);
      for (let attempt = 0; attempt < 5; attempt++) {
        const forged = await send(slackRequest(event, { secret: 'not-the-secret' }));
        expect(forged.status).toBe(401);
        expect(await forged.json()).toEqual({ accepted: false, message: 'Invalid signature' });
      }
      expect((await send(slackRequest(event, { signature: null }))).status).toBe(401);
      const stale = await send(
        slackRequest(event, { timestamp: Math.floor(Date.now() / 1000) - 301 })
      );
      expect(stale.status).toBe(401);
      expect(await stale.json()).toEqual({
        accepted: false,
        message: 'Request timestamp is outside the allowed window',
      });

      // Seven refused calls, two rows: a flood cannot grow the log.
      expect(
        deliveries()
          .map((row) => [row.outcome, row.error_code, row.http_status])
          .sort()
      ).toEqual([
        ['rejected', 'invalid_signature', 401],
        ['rejected', 'stale_timestamp', 401],
      ]);
      expect(executions()).toEqual([]);
      expect(submitter).not.toHaveBeenCalled();
      expect(databaseDump()).not.toContain(CANARY);
    });

    it('stores the signing secret only as ciphertext', async () => {
      await saveSecret(slackTriggerId, SLACK_SECRET);
      const dump = databaseDump();
      expect(dump).not.toContain(SLACK_SECRET);
      const row = sqlite
        .prepare(
          'SELECT signing_secret_encrypted, signing_secret_iv, signing_secret_set_by FROM webhook_trigger_configs'
        )
        .get() as Record<string, string>;
      expect(row.signing_secret_encrypted).toBeTruthy();
      expect(row.signing_secret_iv).toBeTruthy();
      expect(row.signing_secret_set_by).toBe('user');
    });

    it('answers an unknown address, a token automation, and the wrong door uniformly with 404', async () => {
      await saveSecret(slackTriggerId, SLACK_SECRET);
      expect((await send(slackRequest(mention('Ev-x'), { triggerId: 'no-such-id' }))).status).toBe(
        404
      );
      expect((await send(slackRequest(mention('Ev-x'), { triggerId: 'bad id!' }))).status).toBe(
        404
      );

      // A token automation is not served by the signed address.
      const bearer = await createSigned('Token webhook', {});
      expect(bearer.webhookToken?.token).toMatch(/^sam_wh_/);
      expect(
        (await send(slackRequest(mention('Ev-x'), { triggerId: bearer.created.id }))).status
      ).toBe(404);

      // And a signed automation is not served by the token address, even to someone holding
      // a token that hashes to its (never revealed) stored token hash.
      const token = generateWebhookToken();
      sqlite
        .prepare('UPDATE webhook_trigger_configs SET token_hash = ? WHERE trigger_id = ?')
        .run(await hashWebhookToken(token, env.ENCRYPTION_KEY), slackTriggerId);
      const viaIngest = await send(
        new Request('https://api.example.test/api/webhooks/ingest', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(mention('Ev-ingest')),
        })
      );
      expect(viaIngest.status).toBe(404);
      expect(executions()).toEqual([]);
      expect(submitter).not.toHaveBeenCalled();
    });

    it('refuses a verified body that is not a JSON object, and an oversized body', async () => {
      await saveSecret(slackTriggerId, SLACK_SECRET);
      const notJson = await send(slackRequest('payload=%7B%7D'));
      expect(notJson.status).toBe(400);
      expect(deliveries()).toMatchObject([{ outcome: 'rejected', error_code: 'invalid_body' }]);

      env.WEBHOOK_TRIGGER_MAX_BODY_BYTES = '64';
      const tooLarge = await send(slackRequest(mention('Ev-big', 'x'.repeat(200))));
      expect(tooLarge.status).toBe(413);
      expect(executions()).toEqual([]);
    });
  });

  describe('events', () => {
    beforeEach(async () => {
      await saveSecret(slackTriggerId, SLACK_SECRET);
    });

    it('starts exactly one run for a mention and none for the provider retry of the same event', async () => {
      const first = await send(slackRequest(mention('Ev-1', 'deploy the thing')));
      expect(first.status).toBe(202);
      const accepted = await first.json<{
        accepted: boolean;
        queued: boolean;
        executionId: string;
        deliveryId: string;
      }>();
      expect(accepted).toMatchObject({ accepted: true, queued: true });

      expect(submitter).toHaveBeenCalledTimes(1);
      expect(submitter.mock.calls[0]?.[1]).toMatchObject({
        triggerId: slackTriggerId,
        triggerExecutionId: accepted.executionId,
        projectId: 'project',
        userId: 'user',
        agentProfileId: 'profile',
        triggeredBy: 'webhook',
        renderedPrompt: 'Slack said: deploy the thing (Ev-1)',
      });
      // Once the run exists the queue's copy of the event content is removed.
      expect(executions()).toMatchObject([
        { id: accepted.executionId, status: 'running', rendered_prompt: null },
      ]);
      expect(deliveries()).toMatchObject([
        { id: accepted.deliveryId, outcome: 'accepted', execution_id: accepted.executionId },
      ]);

      // Slack retries with the same event ID and a retry header.
      for (const retry of ['1', '2', '3']) {
        const again = await send(
          slackRequest(mention('Ev-1', 'deploy the thing'), {
            headers: { 'X-Slack-Retry-Num': retry, 'X-Slack-Retry-Reason': 'http_timeout' },
          })
        );
        expect(again.status).toBe(202);
        expect(await again.json()).toMatchObject({ accepted: true, duplicate: true });
      }
      expect(submitter).toHaveBeenCalledTimes(1);
      expect(executions()).toHaveLength(1);
      expect(outcomes().filter((outcome) => outcome === 'duplicate')).toHaveLength(3);
      expect(databaseDump()).not.toContain(CANARY);
    });

    it("ignores the app's own messages and other event types (the loop guard)", async () => {
      const own = await send(slackRequest(mention('Ev-bot', 'I am a bot', { bot_id: 'B123' })));
      expect(await own.json()).toMatchObject({ accepted: true, filtered: true });
      const other = await send(
        slackRequest({ type: 'event_callback', event_id: 'Ev-msg', event: { type: 'message' } })
      );
      expect(await other.json()).toMatchObject({ accepted: true, filtered: true });
      expect(outcomes()).toEqual(['filtered', 'filtered']);
      expect(executions()).toEqual([]);
      expect(submitter).not.toHaveBeenCalled();
    });

    it.each([
      ['absent', {}],
      ['empty', { event_id: '  ' }],
      ['an object', { event_id: { id: 'Ev' } }],
      ['an array', { event_id: ['Ev'] }],
      ['oversized', { event_id: 'E'.repeat(201) }],
    ])('starts nothing when the event ID is %s, and says so', async (_label, idField) => {
      const withoutId: Record<string, unknown> = mention('unused');
      delete withoutId.event_id;
      const response = await send(slackRequest({ ...withoutId, ...idField }));
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ accepted: true, ignored: 'missing_event_id' });
      expect(deliveries()).toMatchObject([
        { outcome: 'rejected', error_code: 'missing_event_id', http_status: 202 },
      ]);
      expect(executions()).toEqual([]);
      expect(submitter).not.toHaveBeenCalled();
    });

    it('starts one run when the same event arrives twice at the same moment', async () => {
      const hono = app();
      const responses = await Promise.all(
        [1, 2, 3, 4].map(() => send(slackRequest(mention('Ev-race', 'only once')), hono))
      );
      // One request holds the event; the others see it in flight or as a duplicate.
      expect(responses.map((response) => response.status).sort()).toEqual(
        expect.arrayContaining([202])
      );
      for (const response of responses) expect([202, 503]).toContain(response.status);
      expect(executions()).toHaveLength(1);
      expect(submitter).toHaveBeenCalledTimes(1);
    });

    it('treats two different event IDs as two events', async () => {
      await send(slackRequest(mention('Ev-a', 'first')));
      await send(slackRequest(mention('Ev-b', 'second')));
      expect(executions()).toHaveLength(2);
    });

    it('reads as refusing when a refusal follows an accepted event in the same window', async () => {
      const setup = () =>
        readWebhookSetupStatus(env, { id: slackTriggerId, projectId: 'project' }, true);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-11T12:00:01Z'));
      expect((await setup()).state).toBe('waiting_for_first_request');

      await send(slackRequest(mention('Ev-r1'), { secret: 'wrong-secret' }));
      expect(await setup()).toMatchObject({
        state: 'rejecting',
        lastRejection: { reason: 'invalid_signature', at: '2026-11-11T12:00:01.000Z' },
      });

      vi.setSystemTime(new Date('2026-11-11T12:00:10Z'));
      await send(slackRequest(mention('Ev-ok')));
      expect(await setup()).toMatchObject({
        state: 'receiving',
        lastEventAt: '2026-11-11T12:00:10.000Z',
      });

      // Same rate-limit window, same reason: the existing row is reused, and it must still
      // count as the latest call.
      vi.setSystemTime(new Date('2026-11-11T12:00:20Z'));
      await send(slackRequest(mention('Ev-r2'), { secret: 'wrong-secret' }));
      const status = await setup();
      expect(status.state).toBe('rejecting');
      expect(status.lastRejection).toMatchObject({
        reason: 'invalid_signature',
        at: '2026-11-11T12:00:20.000Z',
      });
      expect(status.lastRejection?.hint).toMatch(/signing secret/);
      expect(outcomes().filter((outcome) => outcome === 'rejected')).toHaveLength(1);
      const rejectedEvents = () =>
        sqlite
          .prepare(
            `SELECT COUNT(*) AS n FROM project_event_source_outbox WHERE event_type = 'webhook.rejected'`
          )
          .get();
      // Anyone who knows the address can forge a signature, so a forged call can wake no
      // subscribed agent: it is in the call log and the status line only.
      expect(rejectedEvents()).toEqual({ n: 0 });

      // A refusal of a correctly signed call comes from whoever holds the secret: one project
      // event for the window, not one per call.
      vi.setSystemTime(new Date('2026-11-11T12:00:30Z'));
      const stale = Math.floor(Date.now() / 1000) - 3600;
      await send(slackRequest(mention('Ev-s1'), { timestamp: stale }));
      await send(slackRequest(mention('Ev-s2'), { timestamp: stale }));
      expect(rejectedEvents()).toEqual({ n: 1 });
    });

    it('records a call to a paused automation and queues nothing', async () => {
      sqlite.prepare(`UPDATE triggers SET status = 'paused' WHERE id = ?`).run(slackTriggerId);
      const response = await send(slackRequest(mention('Ev-paused')));
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({ accepted: true, inactive: true });
      expect(deliveries()).toMatchObject([{ outcome: 'inactive', error_code: 'paused' }]);
      expect(executions()).toEqual([]);
    });
  });

  describe('a second sender on the same core (HMAC over the raw body)', () => {
    let githubTriggerId: string;

    const githubRequest = (
      body: Record<string, unknown>,
      deliveryId: string | null,
      signature?: string
    ) => {
      const raw = JSON.stringify(body);
      const headers = new Headers({
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'issues',
        'X-Hub-Signature-256':
          signature ?? `sha256=${createHmac('sha256', GITHUB_SECRET).update(raw).digest('hex')}`,
      });
      if (deliveryId) headers.set('X-GitHub-Delivery', deliveryId);
      return new Request(`https://api.example.test/api/webhooks/in/${githubTriggerId}`, {
        method: 'POST',
        headers,
        body: raw,
      });
    };

    beforeEach(async () => {
      const created = await createSigned(
        'Repository webhook',
        {
          verification: { scheme: 'hmac_sha256_body', header: 'X-Hub-Signature-256' },
          eventId: { header: 'X-GitHub-Delivery' },
          includedHeaders: ['x-github-event'],
          filters: [{ path: 'action', operator: 'equals', value: 'opened' }],
        },
        { promptTemplate: '{{webhook.headers.x-github-event}}: {{webhook.body.issue.title}}' }
      );
      githubTriggerId = created.created.id;
      await saveSecret(githubTriggerId, GITHUB_SECRET);
    });

    it('stores the header names lowercased and needs no Slack defaults', () => {
      const row = sqlite
        .prepare('SELECT * FROM webhook_trigger_configs WHERE trigger_id = ?')
        .get(githubTriggerId) as Record<string, string | null>;
      expect(row.verification_scheme).toBe('hmac_sha256_body');
      expect(row.signature_header).toBe('x-hub-signature-256');
      expect([row.event_id_source, row.event_id_key]).toEqual(['header', 'x-github-delivery']);
    });

    it('verifies, de-duplicates on the delivery header, filters and starts a run', async () => {
      const opened = { action: 'opened', issue: { title: 'Crash on start' } };
      const first = await send(githubRequest(opened, 'gh-delivery-1'));
      expect(first.status).toBe(202);
      expect(submitter).toHaveBeenCalledTimes(1);
      expect(submitter.mock.calls[0]?.[1].renderedPrompt).toBe('issues: Crash on start');

      const redelivered = await send(githubRequest(opened, 'gh-delivery-1'));
      expect(await redelivered.json()).toMatchObject({ accepted: true, duplicate: true });
      const closed = await send(githubRequest({ action: 'closed', issue: {} }, 'gh-delivery-2'));
      expect(await closed.json()).toMatchObject({ accepted: true, filtered: true });
      expect(submitter).toHaveBeenCalledTimes(1);
      expect(outcomes(githubTriggerId)).toEqual(['accepted', 'duplicate', 'filtered']);
    });

    it('refuses a wrong signature and an event without the delivery header', async () => {
      const opened = { action: 'opened', issue: { title: 'x' } };
      const forged = await send(githubRequest(opened, 'gh-1', `sha256=${'0'.repeat(64)}`));
      expect(forged.status).toBe(401);
      const noId = await send(githubRequest(opened, null));
      expect(await noId.json()).toEqual({ accepted: true, ignored: 'missing_event_id' });
      expect(executions(githubTriggerId)).toEqual([]);
    });

    it("has no Slack behaviour: a url_verification body is an ordinary event, and Slack's signature is not accepted", async () => {
      const body = { type: 'url_verification', challenge: 'should-not-echo', action: 'opened' };
      const response = await send(githubRequest(body, 'gh-challenge'));
      expect(response.status).toBe(202);
      expect(await response.text()).not.toContain('should-not-echo');
      expect(outcomes(githubTriggerId)).toEqual(['accepted']);

      const slackSigned = await send(slackRequest(mention('Ev-9'), { triggerId: githubTriggerId }));
      expect(slackSigned.status).toBe(401);
    });

    it('does not start a second run when a captured request is replayed under a fresh ID', async () => {
      // The delivery header is outside what the sender signed, so anyone holding one signed
      // request could otherwise resend its body under a new ID for ever.
      const captured = { action: 'opened', issue: { title: 'Captured once' } };
      expect((await send(githubRequest(captured, 'delivery-1'))).status).toBe(202);
      expect(submitter).toHaveBeenCalledTimes(1);

      for (const forgedId of ['delivery-2', 'delivery-3']) {
        const replay = await send(githubRequest(captured, forgedId));
        expect(replay.status).toBe(202);
        expect(await replay.json()).toMatchObject({ accepted: true, duplicate: true });
      }
      expect(executions(githubTriggerId)).toHaveLength(1);
      expect(submitter).toHaveBeenCalledTimes(1);
      expect(outcomes(githubTriggerId)).toEqual(['accepted', 'duplicate', 'duplicate']);

      // Control: a different event under a different ID is still an event.
      const next = await send(
        githubRequest({ action: 'opened', issue: { title: 'A second issue' } }, 'delivery-4')
      );
      expect(await next.json()).toMatchObject({ accepted: true, queued: true });
      expect(executions(githubTriggerId)).toHaveLength(2);
    });

    it('still lets the sender retry an event that was refused for a full line', async () => {
      sqlite
        .prepare('INSERT INTO platform_settings(key,value,updated_at) VALUES(?,?,?)')
        .run('operations.webhookQueueMaxPending', '1', 'now');
      invalidateAdminSettings(env);
      const issue = (n: number) => ({ action: 'opened', issue: { title: `Issue ${n}` } });
      await send(githubRequest(issue(1), 'd-1'));
      await send(githubRequest(issue(2), 'd-2'));
      expect((await send(githubRequest(issue(3), 'd-3'))).status).toBe(429);

      await finishRun(executions(githubTriggerId)[0]!.id);
      await drainTriggerQueue(env, submitter);
      // Nothing was started for it, so the same body may come back, even under a new ID.
      const retried = await send(githubRequest(issue(3), 'd-3-retry'));
      expect(await retried.json()).toMatchObject({ accepted: true, queued: true });
    });

    it('accepts a base64 signature', async () => {
      const body = { action: 'opened', issue: { title: 'Base64' } };
      const signature = createHmac('sha256', GITHUB_SECRET)
        .update(JSON.stringify(body))
        .digest('base64');
      expect((await send(githubRequest(body, 'b64-1', signature))).status).toBe(202);
      expect(submitter).toHaveBeenCalledTimes(1);
    });

    it('never puts the signature header in the instructions, even from an old stored allowlist', async () => {
      await expect(
        createSigned('Leaky', {
          verification: { scheme: 'hmac_sha256_body', header: 'X-Hub-Signature-256' },
          eventId: { header: 'X-GitHub-Delivery' },
          includedHeaders: ['x-hub-signature-256'],
        })
      ).rejects.toThrow(/sensitive|signature header/);

      // A sender whose signature header has an innocent-looking name, and a stored allowlist
      // (written before the rule existed) that exports it.
      const acme = await createSigned(
        'Acme',
        {
          verification: { scheme: 'hmac_sha256_body', header: 'X-Acme-Digest' },
          eventId: { path: 'id' },
        },
        {
          promptTemplate:
            'digest=[{{webhook.headers.x-acme-digest}}] kind={{webhook.headers.x-kind}}',
        }
      );
      const acmeId = acme.created.id;
      await saveSecret(acmeId, GITHUB_SECRET);
      sqlite
        .prepare(
          `UPDATE webhook_trigger_configs SET included_headers_json = ? WHERE trigger_id = ?`
        )
        .run(JSON.stringify(['x-acme-digest', 'x-kind']), acmeId);
      const raw = JSON.stringify({ id: 'acme-1' });
      const digest = createHmac('sha256', GITHUB_SECRET).update(raw).digest('hex');
      const response = await send(
        new Request(`https://api.example.test/api/webhooks/in/${acmeId}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Acme-Digest': digest,
            'X-Kind': 'ping',
          },
          body: raw,
        })
      );
      expect(response.status).toBe(202);
      const prompt = submitter.mock.calls[0]?.[1].renderedPrompt ?? '';
      // Liveness: the allowlist is being applied; the signature just is not part of it.
      expect(prompt).toContain('kind=ping');
      expect(prompt).not.toContain(digest);
    });

    it('requires an event ID location for the generic scheme', async () => {
      await expect(
        createSigned('No event ID', {
          verification: { scheme: 'hmac_sha256_body', header: 'x-signature' },
        })
      ).rejects.toThrow(/eventId is required/);
      await expect(
        createSigned('Bearer with event ID', { eventId: { path: 'id' } })
      ).rejects.toThrow(/applies to signed schemes/);
    });
  });

  describe('durable queue', () => {
    beforeEach(async () => {
      await saveSecret(slackTriggerId, SLACK_SECRET);
    });

    it('holds a burst while the automation is busy and starts each event once, in order', async () => {
      const responses = [];
      for (const n of [1, 2, 3, 4]) {
        responses.push(await send(slackRequest(mention(`Ev-${n}`, `message ${n}`))));
      }
      expect(responses.map((response) => response.status)).toEqual([202, 202, 202, 202]);

      // One run at a time by default: the first started, three wait with their prompts stored.
      expect(submitter).toHaveBeenCalledTimes(1);
      expect(executions().map((row) => row.status)).toEqual([
        'running',
        'waiting',
        'waiting',
        'waiting',
      ]);
      expect(executions().map((row) => row.rendered_prompt)).toEqual([
        null,
        'Slack said: message 2 (Ev-2)',
        'Slack said: message 3 (Ev-3)',
        'Slack said: message 4 (Ev-4)',
      ]);
      expect(outcomes()).toEqual(['accepted', 'queued', 'queued', 'queued']);

      // Draining while the first run is still going starts nothing.
      await drainTriggerQueue(env, submitter);
      expect(submitter).toHaveBeenCalledTimes(1);

      for (const expected of [2, 3, 4]) {
        const running = executions().find((row) => row.status === 'running');
        expect(running).toBeDefined();
        await finishRun(running!.id);
        await drainTriggerQueue(env, submitter);
        expect(submitter).toHaveBeenCalledTimes(expected);
        expect(submitter.mock.calls[expected - 1]?.[1].renderedPrompt).toBe(
          `Slack said: message ${expected} (Ev-${expected})`
        );
      }
      expect(executions().map((row) => row.status)).toEqual([
        'completed',
        'completed',
        'completed',
        'running',
      ]);
      expect(outcomes()).toEqual(['accepted', 'accepted', 'accepted', 'accepted']);
      // Every event started exactly one run.
      expect(new Set(submitter.mock.calls.map((call) => call[1].triggerExecutionId)).size).toBe(4);
    });

    it('runs up to the concurrency limit at once when skip-if-running is off', async () => {
      sqlite
        .prepare('UPDATE triggers SET skip_if_running = 0, max_concurrent = 2 WHERE id = ?')
        .run(slackTriggerId);
      for (const n of [1, 2, 3]) await send(slackRequest(mention(`Ev-${n}`)));
      expect(executions().map((row) => row.status)).toEqual(['running', 'running', 'waiting']);
    });

    it('keeps a committed event when starting it fails, and the cron drain starts it once', async () => {
      // The request commits the event, then the worker dies while starting the run: nothing
      // after the commit takes effect.
      const dying = vi.fn<TriggerTaskSubmitter>(async () => {
        throw new Error('worker restarted');
      });
      const response = await send(slackRequest(mention('Ev-crash', 'survive this')), app(dying));
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({ accepted: true, queued: true });
      expect(dying).toHaveBeenCalledTimes(1);
      const [stored] = executions();
      expect(stored).toMatchObject({
        status: 'queued',
        task_id: null,
        rendered_prompt: 'Slack said: survive this (Ev-crash)',
      });
      expect(outcomes()).toEqual(['queued']);

      // The provider retries because it never saw an answer: still one event.
      const retry = await send(slackRequest(mention('Ev-crash', 'survive this')), app(dying));
      expect(await retry.json()).toMatchObject({ accepted: true, duplicate: true });

      await drainTriggerQueue(env, submitter);
      await drainTriggerQueue(env, submitter);
      expect(submitter).toHaveBeenCalledTimes(1);
      expect(submitter.mock.calls[0]?.[1]).toMatchObject({
        triggerExecutionId: stored!.id,
        renderedPrompt: 'Slack said: survive this (Ev-crash)',
      });
      expect(executions()).toMatchObject([
        { id: stored!.id, status: 'running', rendered_prompt: null },
      ]);
      expect(outcomes()).toEqual(['accepted', 'duplicate']);
    });

    it('commits the event even when no work runs after the response', async () => {
      // An execution context that never runs deferred work stands in for a dropped connection.
      const neverRuns = { waitUntil: () => undefined, passThroughOnException: () => undefined };
      const stalled = vi.fn<TriggerTaskSubmitter>(() => new Promise(() => undefined));
      const response = await app(stalled).request(
        slackRequest(mention('Ev-detached', 'still here')),
        undefined,
        env,
        neverRuns as unknown as ExecutionContext
      );
      expect(response.status).toBe(202);
      expect(executions()).toMatchObject([
        { rendered_prompt: 'Slack said: still here (Ev-detached)' },
      ]);
      expect(['waiting', 'queued']).toContain(executions()[0]?.status);
    });

    it('refuses with 429 when the line is full, without consuming the event ID', async () => {
      sqlite
        .prepare('INSERT INTO platform_settings(key,value,updated_at) VALUES(?,?,?)')
        .run('operations.webhookQueueMaxPending', '2', 'now');
      invalidateAdminSettings(env);

      for (const n of [1, 2, 3]) await send(slackRequest(mention(`Ev-${n}`, `message ${n}`)));
      expect(executions().map((row) => row.status)).toEqual(['running', 'waiting', 'waiting']);

      const refused = await send(slackRequest(mention('Ev-4', 'message 4')));
      expect(refused.status).toBe(429);
      expect(refused.headers.get('Retry-After')).toBe('60');
      expect(executions()).toHaveLength(3);
      expect(deliveries().at(-1)).toMatchObject({
        outcome: 'queue_full',
        http_status: 429,
        execution_id: null,
      });

      // Still full: the same event is refused again, in place.
      expect((await send(slackRequest(mention('Ev-4', 'message 4')))).status).toBe(429);
      expect(outcomes().filter((outcome) => outcome === 'queue_full')).toHaveLength(1);

      // A slot frees, one waiting event starts, and the sender's retry is now accepted.
      await finishRun(executions()[0]!.id);
      await drainTriggerQueue(env, submitter);
      const retried = await send(slackRequest(mention('Ev-4', 'message 4')));
      expect(retried.status).toBe(202);
      expect(await retried.json()).toMatchObject({ accepted: true, queued: true });
      expect(executions().map((row) => row.status)).toEqual([
        'completed',
        'running',
        'waiting',
        'waiting',
      ]);
      expect(outcomes()).not.toContain('queue_full');
    });

    it('drops an event that waited past its limit, visibly, and clears its stored content', async () => {
      sqlite
        .prepare('INSERT INTO platform_settings(key,value,updated_at) VALUES(?,?,?)')
        .run('operations.webhookQueueTtlSeconds', '60', 'now');
      invalidateAdminSettings(env);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-11T12:00:00Z'));

      await send(slackRequest(mention('Ev-1', 'runs')));
      await send(slackRequest(mention('Ev-2', 'waits too long')));
      expect(executions().map((row) => row.status)).toEqual(['running', 'waiting']);

      // Inside the limit nothing is dropped.
      vi.setSystemTime(new Date('2026-11-11T12:00:59Z'));
      await drainTriggerQueue(env, submitter);
      expect(executions()[1]).toMatchObject({ status: 'waiting' });

      vi.setSystemTime(new Date('2026-11-11T12:01:01Z'));
      await drainTriggerQueue(env, submitter);
      expect(executions()[1]).toMatchObject({
        status: 'dropped',
        skip_reason: 'queue_expired',
        rendered_prompt: null,
      });
      // Both calls arrived in the same frozen instant, so find the record by its execution.
      expect(deliveries().find((row) => row.execution_id === executions()[1]?.id)).toMatchObject({
        outcome: 'dropped',
        error_code: 'queue_expired',
      });
      // No run started for the dropped event.
      await finishRun(executions()[0]!.id);
      await drainTriggerQueue(env, submitter);
      expect(submitter).toHaveBeenCalledTimes(1);
    });

    it('leaves webhook events waiting while webhook triggers are switched off, and still expires them', async () => {
      await send(slackRequest(mention('Ev-1')));
      await send(slackRequest(mention('Ev-2')));
      await finishRun(executions()[0]!.id);
      await drainTriggerQueue(env, submitter, { includeGitHub: true, includeWebhooks: false });
      expect(executions()[1]).toMatchObject({ status: 'waiting' });
      expect(submitter).toHaveBeenCalledTimes(1);

      await drainTriggerQueue(env, submitter, { includeGitHub: false, includeWebhooks: true });
      expect(executions()[1]).toMatchObject({ status: 'running' });
    });

    it('keeps the token address behaving as before: busy means skipped, not queued', async () => {
      const bearer = await createSigned('Token webhook', {});
      const token = bearer.webhookToken!.token;
      const post = (key: string) =>
        send(
          new Request('https://api.example.test/api/webhooks/ingest', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
              'Idempotency-Key': key,
            },
            body: JSON.stringify({ event: { text: 'x' }, event_id: key }),
          })
        );
      expect(await (await post('k1')).json()).toMatchObject({ accepted: true });
      expect(await (await post('k2')).json()).toMatchObject({
        accepted: true,
        skipped: 'still_running',
      });
      expect(executions(bearer.created.id).map((row) => row.status)).toEqual([
        'running',
        'skipped',
      ]);
    });
  });

  describe('queue under pressure and review hardening', () => {
    beforeEach(async () => {
      await saveSecret(slackTriggerId, SLACK_SECRET);
    });

    const attempted = () =>
      (
        sqlite
          .prepare(
            `SELECT queue_attempted_at AS at FROM trigger_executions
              WHERE trigger_id = ? ORDER BY sequence_number`
          )
          .all(slackTriggerId) as Array<{ at: string | null }>
      ).map((row) => row.at !== null);

    it('takes a burst of simultaneous events without turning any away', async () => {
      const hono = app();
      const responses = await Promise.all(
        [1, 2, 3, 4, 5, 6, 7, 8].map((n) =>
          send(slackRequest(mention(`Ev-burst-${n}`, `burst ${n}`)), hono)
        )
      );
      expect(responses.map((response) => response.status)).toEqual(Array(8).fill(202));
      const rows = executions();
      expect(rows).toHaveLength(8);
      expect(new Set(rows.map((row) => row.sequence_number)).size).toBe(8);
      // Each prompt carries its own event; none was rendered for another's place in line.
      expect(new Set(rows.map((row) => row.rendered_prompt ?? 'started')).size).toBe(8);
      expect(submitter).toHaveBeenCalledTimes(1);
      expect(rows.filter((row) => row.status === 'waiting')).toHaveLength(7);
    });

    it('gives the place in line to whoever still holds the call, and to no one twice', async () => {
      const raw = JSON.stringify(mention('Ev-lease'));
      const trigger = (await drizzle(env.DATABASE, { schema }).query.triggers.findFirst({
        where: (table, { eq }) => eq(table.id, slackTriggerId),
      }))!;
      const reserved = await createWebhookDelivery(env, {
        triggerId: slackTriggerId,
        idempotencyKeyHash: await hashWebhookIdempotencyKey('Ev-lease', env.ENCRYPTION_KEY),
        requestFingerprint: await fingerprintWebhookRequest(raw, env.ENCRYPTION_KEY),
        bodyBytes: raw.length,
        receivedAt: new Date().toISOString(),
      });
      if (reserved.disposition !== 'reserved') throw new Error('expected a reservation');
      const accept = () =>
        acceptWebhookTriggerExecution(env, {
          trigger,
          delivery: { id: reserved.id, processingToken: reserved.processingToken },
          receivedAt: new Date().toISOString(),
          maxPending: 50,
          ttlSeconds: 3600,
          renderPrompt: (_id, sequence) => `event number ${sequence}`,
        });
      const first = await accept();
      expect(first).toMatchObject({ outcome: 'queued' });
      // The reservation was spent by the first accept.
      expect(await accept()).toEqual({ outcome: 'unavailable', reason: 'lease_lost' });
      expect(executions()).toHaveLength(1);
      // The prompt was rendered with the number the row actually got.
      expect(executions()[0]).toMatchObject({
        rendered_prompt: `event number ${executions()[0]!.sequence_number}`,
      });
      // A later event still sorts after it.
      await send(slackRequest(mention('Ev-after')));
      const [held, later] = executions();
      expect(later!.sequence_number).toBeGreaterThan(held!.sequence_number);
    });

    it('answers 503 while another request holds the event, and takes it over once that one is gone', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-11T12:00:00Z'));
      const event = mention('Ev-held', 'interrupted');
      const raw = JSON.stringify(event);
      // A request that reserved the event and then died before committing anything.
      const reserved = await createWebhookDelivery(env, {
        triggerId: slackTriggerId,
        idempotencyKeyHash: await hashWebhookIdempotencyKey('Ev-held', env.ENCRYPTION_KEY),
        requestFingerprint: await fingerprintWebhookRequest(raw, env.ENCRYPTION_KEY),
        bodyBytes: raw.length,
        receivedAt: new Date().toISOString(),
      });
      expect(reserved.disposition).toBe('reserved');

      const blocked = await send(slackRequest(event));
      expect(blocked.status).toBe(503);
      expect(executions()).toEqual([]);
      expect(submitter).not.toHaveBeenCalled();

      // The sender's retry arrives after the dead request's hold has lapsed.
      vi.setSystemTime(new Date('2026-11-11T13:00:00Z'));
      const retried = await send(slackRequest(event));
      expect(retried.status).toBe(202);
      expect(executions()).toHaveLength(1);
      expect(submitter).toHaveBeenCalledTimes(1);
      expect(await (await send(slackRequest(event))).json()).toMatchObject({ duplicate: true });
      expect(submitter).toHaveBeenCalledTimes(1);
    });

    it('starts the event at the head of the line when a newer one arrives after a slot frees', async () => {
      await send(slackRequest(mention('Ev-1', 'message 1')));
      await send(slackRequest(mention('Ev-2', 'message 2')));
      await finishRun(executions()[0]!.id);

      // No cron tick in between: the arriving event's own kick must not let it jump ahead.
      await send(slackRequest(mention('Ev-3', 'message 3')));
      expect(submitter).toHaveBeenCalledTimes(2);
      expect(submitter.mock.calls[1]?.[1].renderedPrompt).toBe('Slack said: message 2 (Ev-2)');
      expect(executions().map((row) => row.status)).toEqual(['completed', 'running', 'waiting']);
    });

    it('tries only the head of a waiting line, from the cron and from the per-automation kick', async () => {
      for (const n of [1, 2, 3, 4]) await send(slackRequest(mention(`Ev-${n}`)));
      sqlite.prepare('UPDATE trigger_executions SET queue_attempted_at = NULL').run();

      await drainTriggerQueue(env, submitter);
      // Row 1 is running; of the three waiting, only the first was worth a look.
      expect(attempted()).toEqual([false, true, false, false]);

      sqlite.prepare('UPDATE trigger_executions SET queue_attempted_at = NULL').run();
      await drainTriggerQueueForTrigger(env, slackTriggerId, 3, submitter);
      expect(attempted()).toEqual([false, true, false, false]);
      expect(submitter).toHaveBeenCalledTimes(1);
    });

    it('uses the indexes for the statements that run on every event and every tick', async () => {
      // The shared helper declares every index without its WHERE clause, which would hide
      // whether a partial index is usable. Rebuild this table's indexes from the migrations.
      for (const { name } of sqlite
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'trigger_executions' AND sql IS NOT NULL`
        )
        .all() as Array<{ name: string }>) {
        sqlite.exec(`DROP INDEX "${name}"`);
      }
      for (const file of [
        '0036_triggers.sql',
        '0195_github_trigger_recovery.sql',
        '0209_github_trigger_queue.sql',
        '0235_signed_webhook_triggers.sql',
      ]) {
        const sql = readFileSync(
          new URL(`../../src/db/migrations/${file}`, import.meta.url),
          'utf8'
        );
        for (const statement of sql.match(
          /CREATE (?:UNIQUE )?INDEX[^;]+ON trigger_executions[^;]*;/g
        ) ?? []) {
          sqlite.exec(statement);
        }
      }
      expect(
        sqlite
          .prepare(
            `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND tbl_name = 'trigger_executions' AND sql LIKE '%WHERE%'`
          )
          .get()
      ).toEqual({ n: 7 });
      // The same for the call log's partial index used by the cron repair.
      sqlite.exec('DROP INDEX "idx_webhook_deliveries_queued"');
      for (const statement of readFileSync(
        new URL('../../src/db/migrations/0235_signed_webhook_triggers.sql', import.meta.url),
        'utf8'
      ).match(/CREATE INDEX[^;]+ON webhook_deliveries[^;]*WHERE[^;]*;/g) ?? []) {
        sqlite.exec(statement);
      }

      const issued: string[] = [];
      const database = env.DATABASE;
      const prepare = database.prepare.bind(database);
      database.prepare = (sql: string) => {
        issued.push(sql);
        return prepare(sql);
      };
      await send(slackRequest(mention('Ev-1')));
      await send(slackRequest(mention('Ev-2')));
      await drainTriggerQueue(env, submitter);
      database.prepare = prepare;

      const plan = (fragment: string) => {
        const sql = issued.find((statement) => statement.includes(fragment));
        if (!sql) throw new Error(`no statement issued containing: ${fragment}`);
        const binds = Array.from({ length: sql.split('?').length - 1 }, () => 'x');
        return (
          sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...binds) as Array<{ detail: string }>
        )
          .map((row) => row.detail)
          .join('\n');
      };
      // Expiry, every tick.
      expect(plan("skip_reason='queue_expired',completed_at=?")).toContain(
        'idx_trigger_queue_expiry'
      );
      // Taking a place in line, every accepted event.
      expect(plan('RETURNING next_execution_sequence - 1')).toContain('idx_trigger_queue_waiting');
      // The per-automation kick.
      expect(plan("WHERE trigger_id=? AND status='waiting'")).toContain(
        'idx_trigger_queue_waiting'
      );
      // Finding heads of lines in the cron drain.
      expect(plan('older.sequence_number < q.sequence_number')).toContain(
        'idx_trigger_queue_waiting'
      );
      // The cron repair reads only rows that need it.
      expect(plan('SET task_id = (SELECT t.id FROM tasks t')).toContain(
        'idx_trigger_queue_webhook_prompts'
      );
      expect(plan("UPDATE github_webhook_deliveries SET decision='dropped'")).toContain(
        'idx_trigger_queue_expiry'
      );
      expect(plan('SET trigger_count = trigger_count + (SELECT COUNT(*)')).toContain(
        'idx_trigger_queue_webhook_prompts'
      );
      expect(plan('submission_recorded_at IS NOT NULL)) LIMIT ?')).toContain(
        'idx_trigger_queue_webhook_prompts'
      );
      expect(plan("WHERE outcome = 'queued' AND EXISTS")).toContain(
        'idx_webhook_deliveries_queued'
      );
    });

    it('keeps waiting events while the automation is paused, and starts them after a resume', async () => {
      for (const n of [1, 2, 3]) await send(slackRequest(mention(`Ev-${n}`, `message ${n}`)));
      sqlite.prepare(`UPDATE triggers SET status = 'paused' WHERE id = ?`).run(slackTriggerId);
      await finishRun(executions()[0]!.id);
      await drainTriggerQueue(env, submitter);

      // Nothing starts, nothing is lost, and the calls still read as waiting.
      expect(submitter).toHaveBeenCalledTimes(1);
      expect(executions().map((row) => [row.status, row.rendered_prompt])).toEqual([
        ['completed', null],
        ['waiting', 'Slack said: message 2 (Ev-2)'],
        ['waiting', 'Slack said: message 3 (Ev-3)'],
      ]);
      expect(outcomes()).toEqual(['accepted', 'queued', 'queued']);

      sqlite.prepare(`UPDATE triggers SET status = 'active' WHERE id = ?`).run(slackTriggerId);
      await drainTriggerQueue(env, submitter);
      expect(submitter).toHaveBeenCalledTimes(2);
      expect(submitter.mock.calls[1]?.[1].renderedPrompt).toBe('Slack said: message 2 (Ev-2)');
    });

    it('drops expired events for every source even while a source is switched off, and only clears webhook content', async () => {
      sqlite
        .prepare('INSERT INTO platform_settings(key,value,updated_at) VALUES(?,?,?)')
        .run('operations.webhookQueueTtlSeconds', '60', 'now');
      invalidateAdminSettings(env);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-11T12:00:00Z'));
      await send(slackRequest(mention('Ev-1')));
      await send(slackRequest(mention('Ev-2')));
      // A GitHub event waiting in the same queue.
      sqlite
        .prepare(
          `INSERT INTO trigger_executions
            (id, trigger_id, project_id, status, event_type, github_delivery_id, sequence_number,
             created_at, rendered_prompt, queue_expires_at)
           VALUES ('gh-row', ?, 'project', 'waiting', 'issues', 'gh-delivery', 99, ?, 'github prompt', ?)`
        )
        .run(slackTriggerId, '2026-11-11T12:00:00Z', '2026-11-11T12:01:00.000Z');

      vi.setSystemTime(new Date('2026-11-11T12:02:00Z'));
      await drainTriggerQueue(env, submitter, { includeGitHub: false, includeWebhooks: false });
      const rows = sqlite
        .prepare(
          `SELECT id, status, skip_reason, rendered_prompt FROM trigger_executions
            WHERE status = 'dropped' ORDER BY sequence_number`
        )
        .all() as Array<Record<string, string | null>>;
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ skip_reason: 'queue_expired', rendered_prompt: null });
      expect(rows[1]).toMatchObject({ id: 'gh-row', rendered_prompt: 'github prompt' });
      expect(outcomes().at(-1)).toBe('dropped');
      expect(submitter).toHaveBeenCalledTimes(1);
    });

    it('reads the timestamp tolerance from the admin setting', async () => {
      const at = (secondsAgo: number) =>
        send(
          slackRequest(mention(`Ev-age-${secondsAgo}`), {
            timestamp: Math.floor(Date.now() / 1000) - secondsAgo,
          })
        );
      // Default: 150 seconds old is fine.
      expect((await at(150)).status).toBe(202);
      sqlite
        .prepare('INSERT INTO platform_settings(key,value,updated_at) VALUES(?,?,?)')
        .run('operations.webhookSignatureToleranceSeconds', '60', 'now');
      invalidateAdminSettings(env);
      expect((await at(50)).status).toBe(202);
      expect((await at(70)).status).toBe(401);
      expect((await at(151)).status).toBe(401);
    });

    it('does not let forged calls use up the automation limit, and records a verified call over it', async () => {
      env.WEBHOOK_TRIGGER_RATE_LIMIT_PER_MINUTE = '2';
      for (let n = 0; n < 5; n++) {
        expect((await send(slackRequest(mention('Ev-x'), { secret: 'wrong' }))).status).toBe(401);
      }
      expect((await send(slackRequest(mention('Ev-1')))).status).toBe(202);
      expect((await send(slackRequest(mention('Ev-2')))).status).toBe(202);
      const limited = await send(slackRequest(mention('Ev-3')));
      expect(limited.status).toBe(429);
      expect(deliveries().at(-1)).toMatchObject({ outcome: 'rate_limited', http_status: 429 });
      expect(executions()).toHaveLength(2);
    });

    it('takes a signed event when the rate-limit counters cannot be read, and still refuses forgeries', async () => {
      const kv = env.KV;
      const get = vi.fn(async () => {
        throw new Error('KV GET failed');
      });
      env.KV = { ...kv, get } as unknown as KVNamespace;
      const valid = await send(slackRequest(mention('Ev-kv', 'counter down')));
      expect(valid.status).toBe(202);
      expect(await valid.json()).toMatchObject({ queued: true });
      expect(executions()).toHaveLength(1);
      expect(submitter).toHaveBeenCalledTimes(1);
      const forged = await send(slackRequest(mention('Ev-kv-f'), { secret: 'wrong-secret' }));
      expect(forged.status).toBe(401);
      expect(executions()).toHaveLength(1);
      // Every limiter on the path was actually consulted and failed.
      expect(get).toHaveBeenCalled();

      // Control: with healthy counters the per-caller limit still refuses.
      env.KV = kv;
      env.WEBHOOK_INGRESS_RATE_LIMIT_PER_MINUTE = '2';
      const statuses = [];
      for (const n of [1, 2, 3]) {
        statuses.push((await send(slackRequest(mention(`Ev-limit-${n}`)))).status);
      }
      expect(statuses).toEqual([202, 202, 429]);
    });

    it('damps a flood of calls to addresses that do not exist', async () => {
      env.WEBHOOK_INVALID_TOKEN_RATE_LIMIT_PER_MINUTE = '3';
      const unknown = () =>
        send(slackRequest(mention('Ev-1'), { triggerId: '01HZZZZZZZZZZZZZZZZZZZZZZZ' }));
      const statuses = [];
      for (let n = 0; n < 5; n++) statuses.push((await unknown()).status);
      expect(statuses.slice(0, 3)).toEqual([404, 404, 404]);
      expect(statuses.at(-1)).toBe(429);
    });

    it('refuses visibly when the stored secret cannot be read, and starts nothing', async () => {
      sqlite
        .prepare(
          `UPDATE webhook_trigger_configs SET signing_secret_encrypted = 'AAAA', signing_secret_iv = 'AAAA'
            WHERE trigger_id = ?`
        )
        .run(slackTriggerId);
      const response = await send(slackRequest(mention('Ev-1')));
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain(SLACK_SECRET);
      expect(deliveries()).toMatchObject([{ outcome: 'rejected', error_code: 'not_configured' }]);
      expect(submitter).not.toHaveBeenCalled();
      // Saving it again repairs the automation.
      await saveSecret(slackTriggerId, SLACK_SECRET);
      expect((await send(slackRequest(mention('Ev-1')))).status).toBe(202);
    });

    it('keeps automations apart: the same event ID is two events, and one secret does not open another', async () => {
      const other = await createSigned('Second Slack app', {
        verification: { scheme: 'slack_v0' },
      });
      const otherId = other.created.id;
      await saveSecret(otherId, 'a-different-signing-secret');

      await send(slackRequest(mention('Ev-shared')));
      const second = await send(
        slackRequest(mention('Ev-shared'), {
          triggerId: otherId,
          secret: 'a-different-signing-secret',
        })
      );
      expect(await second.json()).toMatchObject({ accepted: true, queued: true });
      expect(executions()).toHaveLength(1);
      expect(executions(otherId)).toHaveLength(1);

      // The first automation's secret does not verify a call to the second.
      const crossed = await send(slackRequest(mention('Ev-crossed'), { triggerId: otherId }));
      expect(crossed.status).toBe(401);
      expect(executions(otherId)).toHaveLength(1);
    });

    it('saves a secret only for a signed automation in the caller’s project', async () => {
      const columns = () =>
        sqlite
          .prepare(
            `SELECT trigger_id, signing_secret_encrypted, signing_secret_set_by FROM webhook_trigger_configs
              ORDER BY trigger_id`
          )
          .all();
      const before = columns();
      // The right automation, addressed through a project it does not belong to.
      expect(
        await setWebhookSigningSecret(env, {
          projectId: 'another-project',
          triggerId: slackTriggerId,
          userId: 'attacker',
          secret: 'attacker-chosen-secret',
        })
      ).toBeNull();
      // A token automation has no signing secret to set.
      const bearer = await createSigned('Token webhook', {});
      expect(
        await setWebhookSigningSecret(env, {
          projectId: 'project',
          triggerId: bearer.created.id,
          userId: 'user',
          secret: 'not-applicable-here',
        })
      ).toBeNull();
      expect(
        columns().filter((row) => (row as { trigger_id: string }).trigger_id === slackTriggerId)
      ).toEqual(before);
      // Owner control: the same call through the automation's own project works.
      expect(
        await setWebhookSigningSecret(env, {
          projectId: 'project',
          triggerId: slackTriggerId,
          userId: 'user',
          secret: 'owner-rotated-secret',
        })
      ).toMatchObject({ set: true });
      expect((await send(slackRequest(mention('Ev-old-secret')))).status).toBe(401);
      expect(
        (await send(slackRequest(mention('Ev-new'), { secret: 'owner-rotated-secret' }))).status
      ).toBe(202);
    });

    it('emits one project event per accepted event and none for provider retries', async () => {
      const count = (type: string) =>
        (
          sqlite
            .prepare(`SELECT COUNT(*) AS n FROM project_event_source_outbox WHERE event_type = ?`)
            .get(type) as { n: number }
        ).n;
      for (const n of [1, 2, 3]) await send(slackRequest(mention(`Ev-${n}`)));
      const accepted = count('webhook.accepted');
      expect(accepted).toBe(3);
      for (let retry = 0; retry < 3; retry++) await send(slackRequest(mention('Ev-2')));
      expect(count('webhook.accepted')).toBe(3);
      // Starting a waiting event later does not announce it a second time.
      await finishRun(executions()[0]!.id);
      await drainTriggerQueue(env, submitter);
      expect(count('webhook.accepted')).toBe(3);
    });
  });

  /**
   * Fault and ordering seams on the D1 binding. A statement is recognised by a fragment of its
   * SQL whether it runs alone or inside a batch; a failing batch rolls back, as D1's does.
   */
  function interceptD1(fragment: string, onMatch: () => Promise<void> | void) {
    type Statement = { bind: (...params: unknown[]) => Statement; run: () => Promise<unknown> };
    const database = env.DATABASE as unknown as {
      prepare: (sql: string) => Statement;
      batch: (items: object[]) => Promise<unknown>;
    };
    const prepare = database.prepare;
    const batch = database.batch;
    const sqlOf = new WeakMap<object, string>();
    const tag = (target: Statement, sql: string): Statement => {
      const tagged: Statement = sql.includes(fragment)
        ? {
            ...target,
            run: async () => {
              await onMatch();
              return target.run();
            },
          }
        : target;
      sqlOf.set(tagged, sql);
      return tagged;
    };
    database.prepare = (sql: string) => {
      const statement = prepare(sql);
      return { ...tag(statement, sql), bind: (...params) => tag(statement.bind(...params), sql) };
    };
    database.batch = async (items: object[]) => {
      if (items.some((item) => sqlOf.get(item)?.includes(fragment))) await onMatch();
      return batch(items);
    };
  }

  /** The first statement containing `fragment` fails; later ones run normally. */
  function failOnce(fragment: string) {
    const state = { fired: false };
    interceptD1(fragment, () => {
      if (state.fired) return;
      state.fired = true;
      throw new Error('injected D1 failure');
    });
    return state;
  }

  /** A webhook call record that says `queued` while its run has already settled. */
  const strandedCallRecords = () =>
    sqlite
      .prepare(
        `SELECT d.id FROM webhook_deliveries d JOIN trigger_executions e ON e.id = d.execution_id
          WHERE d.outcome = 'queued' AND (e.status = 'dropped' OR e.task_id IS NOT NULL)`
      )
      .all();

  describe('queue records survive a failure part way through, and ordering', () => {
    beforeEach(async () => {
      await saveSecret(slackTriggerId, SLACK_SECRET);
    });

    it('settles an expired event’s call record on the next tick when the repair failed', async () => {
      sqlite
        .prepare('INSERT INTO platform_settings(key,value,updated_at) VALUES(?,?,?)')
        .run('operations.webhookQueueTtlSeconds', '60', 'now');
      invalidateAdminSettings(env);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-11T12:00:00Z'));
      await send(slackRequest(mention('Ev-1', 'runs')));
      await send(slackRequest(mention('Ev-2', 'expires')));
      const waitingId = executions()[1]!.id;

      vi.setSystemTime(new Date('2026-11-11T12:02:00Z'));
      const fault = failOnce('UPDATE webhook_deliveries SET');
      await drainTriggerQueue(env, submitter);
      expect(fault.fired).toBe(true);
      // The expiry is its own step and committed; only the record's update failed.
      expect(executions()[1]).toMatchObject({ id: waitingId, status: 'dropped' });
      expect(strandedCallRecords()).toHaveLength(1);

      // The next tick's repair settles it.
      await drainTriggerQueue(env, submitter);
      expect(executions()[1]).toMatchObject({
        id: waitingId,
        status: 'dropped',
        skip_reason: 'queue_expired',
        rendered_prompt: null,
      });
      expect(deliveries().find((row) => row.execution_id === waitingId)).toMatchObject({
        outcome: 'dropped',
        error_code: 'queue_expired',
      });
      expect(strandedCallRecords()).toEqual([]);
      expect(submitter).toHaveBeenCalledTimes(1);
    });

    it('finishes a started run’s call record and clears its prompt on the next tick when the cleanup failed', async () => {
      const fault = failOnce('UPDATE webhook_deliveries SET');
      expect((await send(slackRequest(mention('Ev-1', 'started')))).status).toBe(202);
      expect(fault.fired).toBe(true);
      // The run started; only the bookkeeping after it was lost.
      const [started] = executions();
      expect(started).toMatchObject({ status: 'running', task_id: `task-${started!.id}` });
      expect(started!.rendered_prompt).toBe('Slack said: started (Ev-1)');
      expect(outcomes()).toEqual(['queued']);

      await drainTriggerQueue(env, submitter);
      expect(executions()[0]).toMatchObject({ status: 'running', rendered_prompt: null });
      expect(outcomes()).toEqual(['accepted']);
      expect(strandedCallRecords()).toEqual([]);
      // Repair is bookkeeping only: the event was not started a second time.
      expect(submitter).toHaveBeenCalledTimes(1);
    });

    it('links a run whose task boundary was never written on the execution, then finishes its record', async () => {
      const runCount = () =>
        sqlite
          .prepare('SELECT trigger_count, last_triggered_at FROM triggers WHERE id = ?')
          .get(slackTriggerId) as { trigger_count: number; last_triggered_at: string | null };
      const fault = failOnce('SET task_id = COALESCE(task_id, ?)');
      await send(slackRequest(mention('Ev-1', 'started')));
      expect(fault.fired).toBe(true);
      const [started] = executions();
      expect(started).toMatchObject({ status: 'running', task_id: null });
      expect(outcomes()).toEqual(['queued']);
      // The failed boundary write took the run's count and time with it.
      expect(runCount()).toEqual({ trigger_count: 0, last_triggered_at: null });

      await drainTriggerQueue(env, submitter);
      expect(executions()[0]).toMatchObject({
        status: 'running',
        task_id: `task-${started!.id}`,
        rendered_prompt: null,
      });
      expect(outcomes()).toEqual(['accepted']);
      expect(submitter).toHaveBeenCalledTimes(1);
      const startedAt = (
        sqlite
          .prepare('SELECT started_at FROM trigger_executions WHERE id = ?')
          .get(started!.id) as {
          started_at: string;
        }
      ).started_at;
      expect(runCount()).toEqual({ trigger_count: 1, last_triggered_at: startedAt });
      // Another tick does not count the run again.
      await drainTriggerQueue(env, submitter);
      expect(runCount().trigger_count).toBe(1);

      // A second event still waits behind the run, which still holds its slot.
      await send(slackRequest(mention('Ev-2', 'next')));
      expect(executions()[1]).toMatchObject({ status: 'waiting' });
      await finishRun(started!.id);
      await drainTriggerQueue(env, submitter);
      expect(submitter).toHaveBeenCalledTimes(2);
      // The second run went through the normal boundary write: counted once more, not twice.
      expect(runCount().trigger_count).toBe(2);
    });

    it('keeps a token webhook run’s prompt: only queued rows are repaired', async () => {
      const bearer = await createSigned('Token webhook', {});
      const token = bearer.webhookToken!.token;
      await send(
        new Request('https://api.example.test/api/webhooks/ingest', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': 'k1',
          },
          body: JSON.stringify({ event: { text: 'kept' }, event_id: 'k1' }),
        })
      );
      // And a signed event, the control: its prompt must go.
      await send(slackRequest(mention('Ev-1', 'cleared')));
      const [tokenRun] = executions(bearer.created.id);
      expect(tokenRun).toMatchObject({ status: 'running' });
      expect(tokenRun!.rendered_prompt).not.toBeNull();
      await finishRun(tokenRun!.id);

      await drainTriggerQueue(env, submitter);
      await drainTriggerQueue(env, submitter);
      expect(executions(bearer.created.id)[0]).toMatchObject({
        status: 'completed',
        rendered_prompt: tokenRun!.rendered_prompt,
      });
      expect(executions()[0]).toMatchObject({ status: 'running', rendered_prompt: null });
    });

    it('keeps a waiting event’s duplicate check for as long as it can wait', async () => {
      sqlite
        .prepare('INSERT INTO platform_settings(key,value,updated_at) VALUES(?,?,?)')
        .run('operations.webhookQueueTtlSeconds', String(20 * 86400), 'now');
      invalidateAdminSettings(env);
      await send(slackRequest(mention('Ev-1')));
      await send(slackRequest(mention('Ev-2', 'waits')));
      const record = sqlite
        .prepare(`SELECT received_at, expires_at FROM webhook_deliveries WHERE outcome = 'queued'`)
        .get() as { received_at: string; expires_at: string };
      const queueDeadline = (
        sqlite
          .prepare(`SELECT queue_expires_at FROM trigger_executions WHERE status = 'waiting'`)
          .get() as { queue_expires_at: string }
      ).queue_expires_at;
      // Past the 7-day call-log retention the record would have been purged mid-wait.
      expect(Date.parse(record.expires_at)).toBeGreaterThan(Date.parse(queueDeadline));
    });

    it('ordering: a call that took the lower number but committed second starts next, once, and never displaces a run', async () => {
      let release!: () => void;
      let reached!: () => void;
      const atCommit = new Promise<void>((resolve) => (reached = resolve));
      const gate = new Promise<void>((resolve) => (release = resolve));
      let paused = false;
      interceptD1('INSERT INTO trigger_executions', async () => {
        if (paused) return;
        paused = true;
        reached();
        await gate;
      });

      // A takes its number, then stalls before its commit.
      const first = send(slackRequest(mention('Ev-A', 'first')));
      await atCommit;
      // B arrives, commits behind A's number and starts: A is not in the line yet.
      expect((await send(slackRequest(mention('Ev-B', 'second')))).status).toBe(202);
      expect(submitter.mock.calls.map((call) => call[1].renderedPrompt)).toEqual([
        'Slack said: second (Ev-B)',
      ]);
      release();
      expect((await first).status).toBe(202);
      // C arrives after A was answered.
      await send(slackRequest(mention('Ev-C', 'third')));

      const rows = executions();
      expect(rows.map((row) => row.rendered_prompt ?? 'started')).toEqual([
        'Slack said: first (Ev-A)',
        'started',
        'Slack said: third (Ev-C)',
      ]);
      expect(rows.map((row) => row.status)).toEqual(['waiting', 'running', 'waiting']);

      // When B finishes, A (the lower number) goes next, then C.
      await finishRun(rows[1]!.id);
      await drainTriggerQueue(env, submitter);
      await finishRun(rows[0]!.id);
      await drainTriggerQueue(env, submitter);
      expect(submitter.mock.calls.map((call) => call[1].renderedPrompt)).toEqual([
        'Slack said: second (Ev-B)',
        'Slack said: first (Ev-A)',
        'Slack said: third (Ev-C)',
      ]);
      expect(outcomes()).toEqual(['accepted', 'accepted', 'accepted']);
    });
  });
});
