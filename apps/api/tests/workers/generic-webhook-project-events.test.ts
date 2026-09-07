import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../src/env';
import { createTriggerWebhookRoutes } from '../../src/routes/trigger-webhooks';
import * as projectDataService from '../../src/services/project-data';
import type { TriggerTaskSubmitter } from '../../src/services/trigger-admission';
import {
  generateWebhookToken,
  getWebhookTokenLastFour,
  hashWebhookToken,
} from '../../src/services/webhook-trigger-crypto';
import { seedInstallation, seedProject, seedUser } from './helpers/seed-d1';

const TEST_PREFIX = `generic-webhook-events-${Date.now()}`;
const testEnv = env as unknown as Env;
const ENCRYPTION_KEY = 'generic-webhook-worker-test-key';
const HEADER_CANARY = 'HEADER_BEARER_CANARY_DO_NOT_PERSIST';
const BODY_CANARY = 'BODY_SECRET_CANARY_DO_NOT_PERSIST';

function mutableEnv(): Env {
  const mutable = testEnv as Env & Record<string, unknown>;
  mutable.ENCRYPTION_KEY = ENCRYPTION_KEY;
  mutable.WEBHOOK_TRIGGERS_ENABLED = 'true';
  mutable.WEBHOOK_TRIGGER_RATE_LIMIT_PER_MINUTE = '1000';
  mutable.WEBHOOK_INVALID_TOKEN_RATE_LIMIT_PER_MINUTE = '1000';
  return mutable as Env;
}

async function seedWebhookTrigger(
  suffix: string,
  options: { filterMode?: string; filtersJson?: string } = {}
): Promise<{ token: string; projectId: string; triggerId: string }> {
  const userId = `${TEST_PREFIX}-${suffix}-user`;
  const installationId = `${TEST_PREFIX}-${suffix}-installation`;
  const projectId = `${TEST_PREFIX}-${suffix}-project`;
  const profileId = `${TEST_PREFIX}-${suffix}-profile`;
  const triggerId = `${TEST_PREFIX}-${suffix}-trigger`;
  const token = generateWebhookToken();
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
     VALUES (?, ?, ?, 'Webhook Agent', 'claude-code', 'auto', ?, ?)`
  )
    .bind(profileId, projectId, userId, now, now)
    .run();
  await env.DATABASE.prepare(
    `INSERT INTO triggers
       (id, project_id, user_id, name, status, source_type, skip_if_running,
        prompt_template, agent_profile_id, task_mode, max_concurrent, created_at, updated_at)
     VALUES (?, ?, ?, 'Webhook Trigger', 'active', 'webhook', 1, ?, ?, 'task', 1, ?, ?)`
  )
    .bind(
      triggerId,
      projectId,
      userId,
      'safe={{webhook.body.safe}} header={{webhook.headers.x-event-type}}',
      profileId,
      now,
      now
    )
    .run();
  await env.DATABASE.prepare(
    `INSERT INTO webhook_trigger_configs
       (trigger_id, token_hash, token_last_four, token_created_at, source_label,
        filter_mode, filters_json, included_headers_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', ?, ?, '["x-event-type"]', ?, ?)`
  )
    .bind(
      triggerId,
      await hashWebhookToken(token, ENCRYPTION_KEY),
      getWebhookTokenLastFour(token),
      now,
      options.filterMode ?? 'all',
      options.filtersJson ?? '[]',
      now,
      now
    )
    .run();

  return { token, projectId, triggerId };
}

function request(token: string, body: Record<string, unknown>, idempotencyKey: string): Request {
  return new Request('https://api.test.local/api/webhooks/ingest', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
      'x-event-type': `Bearer ${HEADER_CANARY}`,
    },
    body: JSON.stringify(body),
  });
}

function webhookApp(submitter: TriggerTaskSubmitter) {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/webhooks', createTriggerWebhookRoutes(submitter));
  return app;
}

async function persistedOutboxPayload(deliveryKey: string): Promise<string> {
  const row = await env.DATABASE.prepare(
    `SELECT event_payload_json
       FROM project_event_source_outbox
      WHERE delivery_key = ?
      LIMIT 1`
  )
    .bind(deliveryKey)
    .first<{ event_payload_json: string }>();
  return row?.event_payload_json ?? '';
}

async function persistedProjectEvent(projectId: string): Promise<string> {
  const status = await projectDataService.getProjectEventRecentStatus(testEnv, projectId);
  return JSON.stringify(status.events);
}

describe('generic webhook ProjectData event producer', () => {
  it('keeps webhook secrets out of D1 and ProjectData while preserving the submitted payload', async () => {
    const { token, projectId } = await seedWebhookTrigger('accepted');
    const submitted: string[] = [];
    const submitter: TriggerTaskSubmitter = async (_env, input) => {
      submitted.push(input.renderedPrompt);
      return {
        taskId: `${input.triggerExecutionId}-task`,
        sessionId: `${input.triggerExecutionId}-session`,
        branchName: 'sam/webhook-worker-test',
      };
    };

    const response = await webhookApp(submitter).request(
      request(
        token,
        {
          safe: 'visible-to-trigger',
          ...Object.fromEntries(
            Array.from({ length: 50 }, (_value, index) => [`safe_key_${index}`, 'x'.repeat(1024)])
          ),
          clientSecret: BODY_CANARY,
          privateKey: BODY_CANARY,
          authToken: BODY_CANARY,
          sessionId: BODY_CANARY,
          credentials: { apiKey: BODY_CANARY },
          '': BODY_CANARY,
          nested: { one: { two: { three: { token: BODY_CANARY } } } },
        },
        'accepted-delivery'
      ),
      undefined,
      mutableEnv()
    );
    const responseBody = await response.json<{ deliveryId: string }>();

    expect(response.status).toBe(202);
    expect(submitted).toEqual([`safe=visible-to-trigger header=Bearer ${HEADER_CANARY}`]);
    const outbox = await persistedOutboxPayload(`delivery:${responseBody.deliveryId}`);
    const event = await persistedProjectEvent(projectId);

    expect(`${outbox}${event}`).not.toContain(BODY_CANARY);
    expect(`${outbox}${event}`).not.toContain(HEADER_CANARY);
    expect(`${outbox}${event}`).not.toContain('clientSecret');
    expect(`${outbox}${event}`).not.toContain('privateKey');
    expect(`${outbox}${event}`).not.toContain('authToken');
    expect(`${outbox}${event}`).not.toContain('sessionId');
    expect(`${outbox}${event}`).toContain('bodyTopLevelKeyCount');
    expect(`${outbox}${event}`).toContain('redactedSensitiveKeyCount');
  });

  it('keeps filtered webhook payload secrets out of persisted events', async () => {
    const { token, projectId } = await seedWebhookTrigger('filtered', {
      filterMode: 'all',
      filtersJson: '[{"path":"body.environment","operator":"equals","value":"production"}]',
    });
    const submitter: TriggerTaskSubmitter = async () => {
      throw new Error('filtered request must not submit a task');
    };

    const response = await webhookApp(submitter).request(
      request(token, { environment: 'preview', token: BODY_CANARY }, 'filtered-delivery'),
      undefined,
      mutableEnv()
    );
    const responseBody = await response.json<{ deliveryId: string }>();

    expect(response.status).toBe(202);
    const outbox = await persistedOutboxPayload(`delivery:${responseBody.deliveryId}`);
    const event = await persistedProjectEvent(projectId);

    expect(`${outbox}${event}`).not.toContain(BODY_CANARY);
    expect(`${outbox}${event}`).not.toContain(HEADER_CANARY);
    expect(`${outbox}${event}`).toContain('webhook.filtered');
  });
});
