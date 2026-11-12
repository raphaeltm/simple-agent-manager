/**
 * Setting up and reading a signed webhook automation through the mounted REST routes and the
 * MCP tools, on a real SQL engine: creation, the write-only signing secret, what reads return,
 * who may change what, and that both surfaces report the same setup state.
 */
import { createHmac } from 'node:crypto';

import Database from 'better-sqlite3';
import { Hono } from 'hono';
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

const authState = vi.hoisted(() => ({ userId: 'user' }));

vi.mock('../../src/middleware/auth', () => ({
  // Agent sign-in session guards: inert for these ordinary-session route tests.
  rejectAgentSignInSession: () => async (_c: unknown, next: () => Promise<void>) => next(),
  assertNotAgentSignInSession: () => undefined,
  getAuth: () => ({ user: { id: authState.userId } }),
}));
vi.mock('../../src/services/project-multiplayer', () => ({
  getProjectMultiplayerState: vi.fn().mockResolvedValue({ multiplayerActive: false }),
  clearProjectMultiplayerStateCache: vi.fn(),
}));
vi.mock('../../src/services/credential-attribution-health', () => ({
  buildCredentialAttributionForTriggers: vi.fn().mockResolvedValue(new Map()),
  clearCredentialAttributionHealthCache: vi.fn(),
}));
vi.mock('../../src/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createModuleLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { log } from '../../src/lib/logger';
import type { McpTokenData } from '../../src/routes/mcp/_helpers';
import { handleCreateTrigger, handleGetTrigger } from '../../src/routes/mcp/trigger-tools';
import { createSignedTriggerWebhookRoutes } from '../../src/routes/trigger-webhooks-signed';
import { crudRoutes } from '../../src/routes/triggers/crud';
import { webhookRoutes } from '../../src/routes/triggers/webhooks';
import { invalidateAdminSettings } from '../../src/services/admin-settings';
import { generateEncryptionKey } from '../../src/services/encryption';
import type { TriggerTaskSubmitter } from '../../src/services/trigger-admission';
import { SLACK_DOCS_EXAMPLE_SIGNING_VALUE } from '../helpers/slack-docs-example';

const SLACK_SECRET = SLACK_DOCS_EXAMPLE_SIGNING_VALUE;
const json = (body: unknown, method = 'POST') => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const token = (overrides: Partial<McpTokenData> = {}): McpTokenData => ({
  taskId: 'task',
  projectId: 'project',
  userId: 'user',
  workspaceId: 'ws',
  createdAt: '2026-11-11T00:00:00Z',
  ...overrides,
});
const toolContent = (result: { result?: unknown }) =>
  JSON.parse((result.result as { content: { text: string }[] }).content[0]!.text);

describe('signed webhook setup through REST and MCP', () => {
  let sqlite: Database.Database;
  let env: Env;
  let app: Hono<{ Bindings: Env }>;
  let submitter: ReturnType<typeof vi.fn<TriggerTaskSubmitter>>;

  const base = '/api/projects/project/triggers';
  const createViaRest = async (body: Record<string, unknown>) =>
    app.request(
      base,
      json({
        sourceType: 'webhook',
        agentProfileId: 'profile',
        promptTemplate: 'Slack: {{webhook.body.event.text}}',
        ...body,
      }),
      env
    );
  const slackConfig = { verification: { scheme: 'slack_v0' } };
  const putSecret = (triggerId: string, body: unknown, projectId = 'project') =>
    app.request(
      `/api/projects/${projectId}/triggers/${triggerId}/webhook/signing-secret`,
      json(body, 'PUT'),
      env
    );
  const storedSecretColumns = (triggerId: string) =>
    sqlite
      .prepare(
        `SELECT signing_secret_encrypted AS ciphertext, signing_secret_set_by AS setBy
           FROM webhook_trigger_configs WHERE trigger_id = ?`
      )
      .get(triggerId) as { ciphertext: string | null; setBy: string | null };

  function slackEvent(triggerId: string, body: Record<string, unknown>, secret = SLACK_SECRET) {
    const raw = JSON.stringify(body);
    const timestamp = String(Math.floor(Date.now() / 1000));
    return new Request(`https://api.example.test/api/webhooks/in/${triggerId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Slack-Request-Timestamp': timestamp,
        'X-Slack-Signature': `v0=${createHmac('sha256', secret)
          .update(`v0:${timestamp}:${raw}`)
          .digest('hex')}`,
      },
      body: raw,
    });
  }

  beforeEach(() => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    createDeclaredIndexes(sqlite, [
      schema.webhookDeliveries,
      schema.webhookTriggerConfigs,
      schema.triggers,
    ]);
    for (const id of ['user', 'viewer', 'outsider']) seedUser(sqlite, id);
    seedProjectWithMember(sqlite, { projectId: 'project', userId: 'user', role: 'owner' });
    seedProjectWithMember(sqlite, { projectId: 'other', userId: 'outsider', role: 'owner' });
    sqlite
      .prepare(
        `INSERT INTO project_members (project_id, user_id, role, status)
         VALUES ('project', 'viewer', 'viewer', 'active')`
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO agent_profiles (id, project_id, agent_type)
         VALUES ('profile', 'project', 'claude-code'), ('other-profile', 'other', 'claude-code')`
      )
      .run();
    authState.userId = 'user';
    vi.mocked(log.info).mockClear();
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
    submitter = vi.fn<TriggerTaskSubmitter>(async (_env, input) => {
      const taskId = `task-${input.triggerExecutionId}`;
      sqlite
        .prepare(
          `INSERT INTO tasks (id, project_id, user_id, status, chat_session_id, trigger_execution_id)
           VALUES (?, 'project', 'user', 'in_progress', ?, ?)`
        )
        .run(taskId, `session-${taskId}`, input.triggerExecutionId);
      return { taskId, sessionId: `session-${taskId}`, branchName: 'sam/slack' };
    });
    app = new Hono<{ Bindings: Env }>();
    app.onError((error, c) => {
      const appError = error as { statusCode?: number; error?: string; message?: string };
      if (appError.statusCode && appError.error) {
        return c.json(
          { error: appError.error, message: appError.message },
          appError.statusCode as 400
        );
      }
      return c.json({ error: 'INTERNAL_ERROR', message: error.message }, 500);
    });
    app.route('/api/projects/:projectId/triggers', crudRoutes);
    app.route('/api/projects/:projectId/triggers', webhookRoutes);
    app.route('/api/webhooks', createSignedTriggerWebhookRoutes(submitter));
  });

  afterEach(() => sqlite.close());

  describe('REST', () => {
    it('creates a Slack automation with its own address, no token, and a setup state', async () => {
      const response = await createViaRest({ name: 'Slack', webhookConfig: slackConfig });
      expect(response.status).toBe(201);
      const created = await response.json<Record<string, any>>();
      expect(created.webhookCredential).toBeUndefined();
      expect(created.webhookConfig).toMatchObject({
        verification: { scheme: 'slack_v0' },
        eventId: { path: 'event_id' },
        endpointUrl: `https://api.example.test/api/webhooks/in/${created.id}`,
        tokenLastFour: null,
        tokenCreatedAt: null,
        signingSecret: { set: false, setAt: null, setBy: null },
        setup: {
          state: 'needs_secret',
          secretEntryUrl: `https://app.example.test/projects/project/automation/trigger/${created.id}#signing-secret`,
          waiting: 0,
          lastRejection: null,
        },
      });
      expect(created.webhookConfig.filters).toEqual([
        { path: 'event.type', operator: 'equals', value: 'app_mention' },
        { path: 'event.bot_id', operator: 'notExists' },
      ]);
    });

    it('keeps a token automation exactly as it was', async () => {
      const response = await createViaRest({ name: 'Script', webhookConfig: {} });
      const created = await response.json<Record<string, any>>();
      expect(created.webhookCredential).toMatchObject({
        endpointUrl: 'https://api.example.test/api/webhooks/ingest',
        headerName: 'Authorization',
      });
      expect(created.webhookConfig).toMatchObject({
        verification: { scheme: 'sam_bearer' },
        eventId: null,
        endpointUrl: 'https://api.example.test/api/webhooks/ingest',
        signingSecret: null,
      });
      expect(created.webhookConfig.tokenLastFour).toHaveLength(4);
      expect(created.webhookConfig.setup).toBeUndefined();
    });

    it('saves the secret write-only and reports who saved it, never the value', async () => {
      const created = await (
        await createViaRest({ name: 'Slack', webhookConfig: slackConfig })
      ).json<{ id: string }>();
      const saved = await putSecret(created.id, { secret: `  ${SLACK_SECRET}\n` });
      expect(saved.status).toBe(200);
      expect(saved.headers.get('Cache-Control')).toBe('private, no-store');
      const savedBody = await saved.text();
      expect(JSON.parse(savedBody)).toMatchObject({ signingSecret: { set: true, setBy: 'user' } });

      const single = await (await app.request(`${base}/${created.id}`, undefined, env)).text();
      const list = await (await app.request(base, undefined, env)).text();
      expect(JSON.parse(single).webhookConfig).toMatchObject({
        signingSecret: { set: true, setBy: 'user' },
        setup: { state: 'waiting_for_first_request' },
      });
      // The list carries the configuration but not the per-automation setup read.
      expect(JSON.parse(list).triggers[0].webhookConfig.setup).toBeUndefined();
      for (const text of [
        savedBody,
        single,
        list,
        JSON.stringify(vi.mocked(log.info).mock.calls),
      ]) {
        expect(text).not.toContain(SLACK_SECRET);
      }
      expect(storedSecretColumns(created.id).ciphertext).not.toContain(SLACK_SECRET);
    });

    // Assembled at runtime so the source holds nothing shaped like a real credential.
    it.each([
      ['a Slack bot token', ['xoxb', '1234567890', 'abcdefghijklmnop'].join('-'), /Slack token/],
      ['a Slack app token', ['xapp', '1', 'A0123456789', '0123456789'].join('-'), /Slack token/],
      ['a SAM webhook token', `${['sam', 'wh'].join('_')}_${'a'.repeat(43)}`, /SAM webhook token/],
      ['a GitHub token', `${'ghp'}_${'a'.repeat(36)}`, /access token or API key/],
      ['a provider API key', `${'sk'}-proj-${'a'.repeat(40)}`, /access token or API key/],
      // Padding does not carry a pasted token or a blank value past the checks.
      ['a padded GitHub token', `  ${'ghp'}_${'a'.repeat(36)}  `, /access token or API key/],
      ['only spaces', ' '.repeat(12), /at least 8/],
      ['a URL', ['https:', '', 'example.test', 'services', 'T000', 'B000'].join('/'), /URL/],
      ['too short', 'short', /at least 8/],
      ['too long', 'x'.repeat(513), /at most 512/],
      ['not a string', 12345678, /must be a string/],
      ['missing', undefined, /must be a string/],
    ])('refuses %s without echoing it or storing anything', async (_label, value, message) => {
      const created = await (
        await createViaRest({ name: 'Slack', webhookConfig: slackConfig })
      ).json<{ id: string }>();
      const response = await putSecret(created.id, { secret: value });
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toMatch(message);
      if (typeof value === 'string') expect(text).not.toContain(value);
      expect(storedSecretColumns(created.id).ciphertext).toBeNull();
    });

    it('saves the secret exactly as sent through the route, surrounding spaces included', async () => {
      const created = await (
        await createViaRest({ name: 'Slack', webhookConfig: slackConfig })
      ).json<{ id: string }>();
      const padded = ` ${SLACK_SECRET} `;
      expect((await putSecret(created.id, { secret: padded })).status).toBe(200);
      const event = (id: string) => ({
        type: 'event_callback',
        event_id: id,
        event: { type: 'app_mention', text: 'hi', user: 'U1' },
      });
      // The trimmed key is not the saved key.
      const trimmed = await app.request(
        slackEvent(created.id, event('Ev-t'), SLACK_SECRET),
        undefined,
        env
      );
      expect(trimmed.status).toBe(401);
      // The exact bytes verify.
      const exact = await app.request(
        slackEvent(created.id, event('Ev-e'), padded),
        undefined,
        env
      );
      expect(exact.status).toBe(202);
    });

    it('lets a viewer read but not save the secret, and hides the automation from another project', async () => {
      const created = await (
        await createViaRest({ name: 'Slack', webhookConfig: slackConfig })
      ).json<{ id: string }>();

      authState.userId = 'viewer';
      expect((await app.request(`${base}/${created.id}`, undefined, env)).status).toBe(200);
      expect((await putSecret(created.id, { secret: SLACK_SECRET })).status).toBe(403);
      expect(storedSecretColumns(created.id).ciphertext).toBeNull();

      // An owner of another project, addressing this automation through their own project.
      authState.userId = 'outsider';
      expect((await putSecret(created.id, { secret: SLACK_SECRET }, 'other')).status).toBe(404);
      // Through the automation's real project they are not a member: not found, not forbidden.
      expect((await putSecret(created.id, { secret: SLACK_SECRET })).status).toBe(404);
      expect(
        (await app.request(`/api/projects/other/triggers/${created.id}`, undefined, env)).status
      ).toBe(404);
      expect(
        (
          await app.request(
            `/api/projects/other/triggers/${created.id}/webhook/deliveries`,
            undefined,
            env
          )
        ).status
      ).toBe(404);
      expect(storedSecretColumns(created.id).ciphertext).toBeNull();

      // Control: the owner's save works.
      authState.userId = 'user';
      expect((await putSecret(created.id, { secret: SLACK_SECRET })).status).toBe(200);
      expect(storedSecretColumns(created.id).setBy).toBe('user');
    });

    it('has no signing secret or token rotation on the wrong kind of automation', async () => {
      const bearer = await (
        await createViaRest({ name: 'Script', webhookConfig: {} })
      ).json<{ id: string }>();
      const signed = await (
        await createViaRest({ name: 'Slack', webhookConfig: slackConfig })
      ).json<{ id: string }>();
      const onBearer = await putSecret(bearer.id, { secret: SLACK_SECRET });
      expect(onBearer.status).toBe(400);
      expect(storedSecretColumns(bearer.id).ciphertext).toBeNull();
      const rotate = (id: string) =>
        app.request(`${base}/${id}/webhook/rotate`, { method: 'POST' }, env);
      expect((await rotate(signed.id)).status).toBe(404);
      expect((await rotate(bearer.id)).status).toBe(200);
    });

    it('fixes the scheme at creation but lets conditions and the event ID location change', async () => {
      const created = await (
        await createViaRest({ name: 'Slack', webhookConfig: slackConfig })
      ).json<{ id: string }>();
      const patch = (webhookConfig: unknown) =>
        app.request(`${base}/${created.id}`, json({ webhookConfig }, 'PATCH'), env);

      const changed = await patch({
        verification: { scheme: 'hmac_sha256_body', header: 'x-sig' },
      });
      expect(changed.status).toBe(400);
      expect(await changed.text()).toMatch(/cannot be changed/);
      expect((await patch({ verification: { scheme: 'sam_bearer' } })).status).toBe(400);

      const edited = await patch({
        verification: { scheme: 'slack_v0' },
        eventId: { path: 'event.client_msg_id' },
        filters: [{ path: 'event.type', operator: 'equals', value: 'message' }],
      });
      expect(edited.status).toBe(200);
      expect((await edited.json<Record<string, any>>()).webhookConfig).toMatchObject({
        verification: { scheme: 'slack_v0' },
        eventId: { path: 'event.client_msg_id' },
        filters: [{ path: 'event.type', operator: 'equals', value: 'message' }],
      });
    });

    it('validates the generic scheme: lowercased header names, a required event ID', async () => {
      const missing = await createViaRest({
        name: 'Hook',
        webhookConfig: { verification: { scheme: 'hmac_sha256_body', header: 'X-Signature' } },
      });
      expect(missing.status).toBe(400);
      expect(await missing.text()).toMatch(/eventId is required/);
      const invalidHeader = await createViaRest({
        name: 'Hook',
        webhookConfig: {
          verification: { scheme: 'hmac_sha256_body', header: 'bad header' },
          eventId: { header: 'x-id' },
        },
      });
      expect(invalidHeader.status).toBe(400);
      const ok = await createViaRest({
        name: 'Hook',
        webhookConfig: {
          verification: { scheme: 'hmac_sha256_body', header: 'X-Hub-Signature-256' },
          eventId: { header: 'X-GitHub-Delivery' },
        },
      });
      expect(ok.status).toBe(201);
      expect((await ok.json<Record<string, any>>()).webhookConfig).toMatchObject({
        verification: { scheme: 'hmac_sha256_body', header: 'x-hub-signature-256' },
        eventId: { header: 'x-github-delivery' },
      });
    });
  });

  describe('MCP', () => {
    const create = (params: Record<string, unknown>, tokenData = token()) =>
      handleCreateTrigger(
        '1',
        {
          name: 'Slack',
          sourceType: 'webhook',
          agentProfileId: 'profile',
          promptTemplate: 'Slack: {{webhook.body.event.text}}',
          webhookConfig: slackConfig,
          ...params,
        },
        tokenData,
        env
      );
    const get = (triggerId: string, tokenData = token()) =>
      handleGetTrigger('2', { triggerId }, tokenData, env);

    it('creates a signed webhook and hands back the address and secret link, with no credential or claim', async () => {
      const result = await create({});
      expect(result.error).toBeUndefined();
      const created = toolContent(result);
      expect(created.webhookClaim).toBeUndefined();
      expect(created.webhookConfig).toMatchObject({
        verification: { scheme: 'slack_v0' },
        endpointUrl: `https://api.example.test/api/webhooks/in/${created.id}`,
        signingSecret: { set: false },
        setup: {
          state: 'needs_secret',
          secretEntryUrl: `https://app.example.test/projects/project/automation/trigger/${created.id}#signing-secret`,
        },
      });
      expect(JSON.stringify(created)).not.toMatch(/sam_wh_|token_hash|tokenHash/);
    });

    it.each([
      ['secret', { secret: SLACK_SECRET }],
      ['signingSecret', { signingSecret: SLACK_SECRET }],
      ['webhookConfig.secret', { webhookConfig: { ...slackConfig, secret: SLACK_SECRET } }],
    ])('refuses a signing secret passed as %s and creates nothing', async (_label, params) => {
      const result = await create(params);
      expect(result.error?.code).toBe(-32602);
      expect(result.error?.message).toMatch(/Do not pass a signing secret/);
      expect(JSON.stringify(result)).not.toContain(SLACK_SECRET);
      expect(sqlite.prepare('SELECT COUNT(*) AS n FROM triggers').get()).toEqual({ n: 0 });
    });

    it('follows a setup from needs_secret through the address check, the first event and a refusal', async () => {
      const created = toolContent(await create({}));
      const id = created.id as string;
      expect(toolContent(await get(id)).webhookConfig.setup.state).toBe('needs_secret');

      // A person saves the secret on the page (REST); the agent sees it through MCP.
      expect((await putSecret(id, { secret: SLACK_SECRET })).status).toBe(200);
      expect(toolContent(await get(id)).webhookConfig).toMatchObject({
        signingSecret: { set: true, setBy: 'user' },
        setup: { state: 'waiting_for_first_request' },
      });

      await app.request(
        slackEvent(id, { type: 'url_verification', challenge: 'c' }),
        undefined,
        env
      );
      const afterChallenge = toolContent(await get(id));
      // Slack confirming the address is not an event: the connection is still unproven.
      expect(afterChallenge.webhookConfig.setup).toMatchObject({
        state: 'waiting_for_first_request',
        lastEventAt: null,
      });
      expect(afterChallenge.recentCalls).toMatchObject([{ outcome: 'challenge', httpStatus: 200 }]);

      const event = {
        type: 'event_callback',
        event_id: 'Ev-1',
        event: { type: 'app_mention', text: 'CONTENT_CANARY hello' },
      };
      await app.request(slackEvent(id, event), undefined, env);
      expect(submitter).toHaveBeenCalledTimes(1);
      const afterEvent = toolContent(await get(id));
      expect(afterEvent.recentCalls[0]).toMatchObject({ outcome: 'accepted' });
      expect(afterEvent.webhookConfig.setup.state).toBe('receiving');
      expect(afterEvent.webhookConfig.setup.lastEventAt).toBeTruthy();
      expect(afterEvent.recentCalls[0].executionId).toBeTruthy();

      await app.request(
        slackEvent(id, { ...event, event_id: 'Ev-2' }, 'rotated-away'),
        undefined,
        env
      );
      const afterRefusal = await get(id);
      const refused = toolContent(afterRefusal);
      expect(refused.webhookConfig.setup).toMatchObject({
        state: 'rejecting',
        lastRejection: { reason: 'invalid_signature' },
      });
      expect(refused.webhookConfig.setup.lastRejection.hint).toMatch(/signing secret/);
      // Configuration and call metadata only: no secret, and no event content.
      const text = JSON.stringify(afterRefusal);
      expect(text).not.toContain(SLACK_SECRET);
      expect(text).not.toContain('CONTENT_CANARY');
    });

    it('reads only automations in the caller project, with the same answer for missing and foreign IDs', async () => {
      const created = toolContent(await create({}));
      const foreign = await get(created.id, token({ projectId: 'other', userId: 'outsider' }));
      const missing = await get('01M00000000000000000000000');
      expect(foreign.error?.message).toBe('Trigger not found in this project');
      expect(missing.error?.message).toBe(foreign.error?.message);
      expect((await handleGetTrigger('3', {}, token(), env)).error?.code).toBe(-32602);
      // Owner control.
      expect(toolContent(await get(created.id)).id).toBe(created.id);
    });

    it('refuses a caller who is not a member of the project', async () => {
      const created = toolContent(await create({}));
      const result = await get(created.id, token({ userId: 'outsider' }));
      expect(result.error?.code).toBe(-32602);
      expect(JSON.stringify(result)).not.toContain('slack_v0');
    });

    it('reads a cron trigger without webhook fields', async () => {
      const cron = toolContent(
        await handleCreateTrigger(
          '1',
          { name: 'Daily', cronExpression: '0 9 * * *', promptTemplate: 'Review' },
          token(),
          env
        )
      );
      const read = toolContent(await get(cron.id));
      expect(read).toMatchObject({ sourceType: 'cron', cronExpression: '0 9 * * *' });
      expect(read.webhookConfig).toBeUndefined();
      expect(read.recentCalls).toBeUndefined();
    });
  });
});
