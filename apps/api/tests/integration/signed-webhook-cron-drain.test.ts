/**
 * The recovery path for signed webhook events, through the real cron entry point and the
 * default task submitter: an event committed by a request whose worker died before the run
 * started is started by the next sweep, exactly once, on an installation where GitHub triggers
 * are not configured at all (the queue it shares was GitHub-only before signed webhooks).
 */
import { createHmac } from 'node:crypto';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import * as v from 'valibot';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import {
  createAllSchemaTables,
  createDeclaredIndexes,
  createMemoryKv,
  createSqliteD1,
} from '../helpers/sqlite-d1';
import { seedProjectWithMember, seedUser } from '../unit/routes/capacity-pool-test-seeds';

const submit = vi.hoisted(() => ({ impl: vi.fn() }));
vi.mock('../../src/services/trigger-submit', () => ({
  submitTriggeredTask: (...args: unknown[]) => submit.impl(...args),
}));

import { signedTriggerWebhookRoutes } from '../../src/routes/trigger-webhooks-signed';
import { CreateTriggerSchema } from '../../src/schemas/triggers';
import { invalidateAdminSettings } from '../../src/services/admin-settings';
import { generateEncryptionKey } from '../../src/services/encryption';
import { runGitHubTriggerRecovery } from '../../src/services/github-trigger-recovery';
import { areGitHubTriggersConfigured } from '../../src/services/platform-config';
import { createTrigger } from '../../src/services/trigger-create';
import { setWebhookSigningSecret } from '../../src/services/webhook-signed-store';
import { SLACK_DOCS_EXAMPLE_SIGNING_VALUE } from '../helpers/slack-docs-example';

const SECRET = SLACK_DOCS_EXAMPLE_SIGNING_VALUE;

describe('signed webhook queue recovery from the operations cron', () => {
  let sqlite: Database.Database;
  let env: Env;
  let triggerId: string;
  const app = new Hono<{ Bindings: Env }>().route('/api/webhooks', signedTriggerWebhookRoutes);

  const executions = () =>
    sqlite
      .prepare(
        'SELECT status, task_id, rendered_prompt FROM trigger_executions ORDER BY sequence_number'
      )
      .all() as Array<{ status: string; task_id: string | null; rendered_prompt: string | null }>;
  const outcomes = () =>
    (
      sqlite.prepare('SELECT outcome FROM webhook_deliveries ORDER BY received_at, id').all() as {
        outcome: string;
      }[]
    ).map((row) => row.outcome);

  function event(eventId: string, text: string) {
    const raw = JSON.stringify({
      type: 'event_callback',
      event_id: eventId,
      event: { type: 'app_mention', text },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    return new Request(`https://api.example.test/api/webhooks/in/${triggerId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Slack-Request-Timestamp': timestamp,
        'X-Slack-Signature': `v0=${createHmac('sha256', SECRET)
          .update(`v0:${timestamp}:${raw}`)
          .digest('hex')}`,
      },
      body: raw,
    });
  }

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    createDeclaredIndexes(sqlite, [schema.webhookDeliveries, schema.triggerExecutions]);
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
    } as unknown as Env;
    invalidateAdminSettings(env);
    submit.impl.mockReset();
    const db = drizzle(env.DATABASE, { schema });
    const created = await createTrigger(
      db,
      env,
      { id: 'project', maxTriggers: null },
      'user',
      v.parse(CreateTriggerSchema, {
        name: 'Slack',
        sourceType: 'webhook',
        agentProfileId: 'profile',
        promptTemplate: 'Slack said: {{webhook.body.event.text}}',
        webhookConfig: { verification: { scheme: 'slack_v0' } },
      })
    );
    triggerId = created.created.id;
    await setWebhookSigningSecret(env, {
      projectId: 'project',
      triggerId,
      userId: 'user',
      secret: SECRET,
    });
  });

  afterEach(() => sqlite.close());

  it('starts a committed event once from the sweep, with GitHub triggers unconfigured', async () => {
    expect(await areGitHubTriggersConfigured(env)).toBe(false);

    // The request commits the event; the run never starts because the worker dies.
    submit.impl.mockRejectedValue(new Error('worker restarted'));
    const response = await app.request(event('Ev-1', 'recover me'), undefined, env);
    expect(response.status).toBe(202);
    expect(executions()).toMatchObject([
      { status: 'queued', task_id: null, rendered_prompt: 'Slack said: recover me' },
    ]);
    expect(outcomes()).toEqual(['queued']);

    submit.impl.mockReset();
    submit.impl.mockImplementation(async (_env: Env, input: { triggerExecutionId: string }) => {
      const taskId = `task-${input.triggerExecutionId}`;
      sqlite
        .prepare(
          `INSERT INTO tasks (id, project_id, user_id, status, chat_session_id, trigger_execution_id)
           VALUES (?, 'project', 'user', 'in_progress', ?, ?)`
        )
        .run(taskId, `session-${taskId}`, input.triggerExecutionId);
      return { taskId, sessionId: `session-${taskId}`, branchName: 'sam/slack' };
    });

    await runGitHubTriggerRecovery(env);
    expect(submit.impl).toHaveBeenCalledTimes(1);
    expect(submit.impl.mock.calls[0]?.[1]).toMatchObject({
      renderedPrompt: 'Slack said: recover me',
      triggeredBy: 'webhook',
      projectId: 'project',
    });
    expect(executions()).toMatchObject([{ status: 'running', rendered_prompt: null }]);
    expect(outcomes()).toEqual(['accepted']);

    // Later sweeps do not start it again.
    await runGitHubTriggerRecovery(env);
    await runGitHubTriggerRecovery(env);
    expect(submit.impl).toHaveBeenCalledTimes(1);
  });

  it('leaves waiting webhook events alone while webhook triggers are switched off', async () => {
    submit.impl.mockRejectedValue(new Error('worker restarted'));
    await app.request(event('Ev-1', 'held'), undefined, env);
    submit.impl.mockReset();
    env.WEBHOOK_TRIGGERS_ENABLED = 'false';
    await runGitHubTriggerRecovery(env);
    expect(submit.impl).not.toHaveBeenCalled();
    expect(executions()).toMatchObject([{ status: 'queued' }]);
  });
});
