import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/env';
import { createMemoryKv, createSqliteD1 } from '../helpers/sqlite-d1';

const project = vi.hoisted(() => ({
  id: 'project-1',
  userId: 'user-1',
  name: 'Webhook Project',
  repository: 'sam/webhook-project',
  installationId: null,
  defaultBranch: 'main',
}));

vi.mock('../../src/middleware/auth', () => ({
  getAuth: () => ({ user: { id: 'user-1' } }),
}));

vi.mock('../../src/routes/task-project-auth', () => ({
  requireProjectTaskRead: vi.fn().mockResolvedValue(project),
  requireProjectTaskWrite: vi.fn().mockResolvedValue(project),
}));

vi.mock('../../src/services/project-multiplayer', () => ({
  getProjectMultiplayerState: vi.fn().mockResolvedValue({ multiplayerActive: false }),
}));

vi.mock('../../src/services/credential-attribution-health', () => ({
  buildCredentialAttributionForTriggers: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock('../../src/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { crudRoutes } from '../../src/routes/triggers/crud';
import { webhookRoutes } from '../../src/routes/triggers/webhooks';
import { generateWebhookToken, hashWebhookToken } from '../../src/services/webhook-trigger-crypto';

const SCHEMA = `
CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
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
  body_bytes INTEGER NOT NULL, execution_id TEXT, error_code TEXT, received_at TEXT NOT NULL,
  processed_at TEXT, expires_at TEXT NOT NULL
);
`;

describe('webhook trigger management vertical slice', () => {
  let sqlite: Database.Database;
  let env: Env;
  let app: Hono<{ Bindings: Env }>;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    sqlite.exec(SCHEMA);
    const now = '2026-07-13T12:00:00.000Z';
    const token = generateWebhookToken();
    sqlite.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').run(project.id, project.name);
    sqlite
      .prepare(
        `INSERT INTO triggers
          (id, project_id, user_id, name, description, status, source_type, prompt_template,
           agent_profile_id, created_at, updated_at)
         VALUES ('trigger-1', ?, 'user-1', 'Original name', NULL, 'active', 'webhook',
                 'Handle {{webhook.body.event.id}}', 'profile-1', ?, ?)`
      )
      .run(project.id, now, now);
    sqlite
      .prepare(
        `INSERT INTO webhook_trigger_configs
          (trigger_id, token_hash, token_last_four, token_created_at, source_label,
           filter_mode, filters_json, included_headers_json, created_at, updated_at)
         VALUES ('trigger-1', ?, ?, ?, 'source', 'all', '[]', '["x-event-type"]', ?, ?)`
      )
      .run(await hashWebhookToken(token, 'management-key'), token.slice(-4), now, now, now);
    env = {
      DATABASE: createSqliteD1(sqlite),
      KV: createMemoryKv(),
      ENCRYPTION_KEY: 'management-key',
      WEBHOOK_TRIGGER_MAX_SOURCE_LABEL_LENGTH: '6',
      WEBHOOK_DELIVERY_DEFAULT_PAGE_SIZE: '1',
      WEBHOOK_DELIVERY_MAX_PAGE_SIZE: '1',
    } as Env;
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
  });

  afterEach(() => sqlite.close());

  it('validates the effective webhook patch before atomically updating either table', async () => {
    const invalid = await app.request(
      '/api/projects/project-1/triggers/trigger-1',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Changed name', webhookConfig: { sourceLabel: 'too-long' } }),
      },
      env
    );

    expect(invalid.status).toBe(400);
    expect(sqlite.prepare('SELECT name FROM triggers WHERE id = ?').get('trigger-1')).toEqual({
      name: 'Original name',
    });
    expect(
      sqlite
        .prepare('SELECT source_label FROM webhook_trigger_configs WHERE trigger_id = ?')
        .get('trigger-1')
    ).toEqual({ source_label: 'source' });

    const valid = await app.request(
      '/api/projects/project-1/triggers/trigger-1',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Changed name', webhookConfig: { sourceLabel: 'valid' } }),
      },
      env
    );

    expect(valid.status).toBe(200);
    expect(sqlite.prepare('SELECT name FROM triggers WHERE id = ?').get('trigger-1')).toEqual({
      name: 'Changed name',
    });
    expect(
      sqlite
        .prepare('SELECT source_label FROM webhook_trigger_configs WHERE trigger_id = ?')
        .get('trigger-1')
    ).toEqual({ source_label: 'valid' });
  });

  it('previews payload rendering through the mounted management route', async () => {
    const response = await app.request(
      '/api/projects/project-1/triggers/trigger-1/webhook/preview',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          payload: { event: { id: 'evt-42' } },
          headers: { 'x-event-type': 'deployment.failed', authorization: 'secret' },
        }),
      },
      env
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      renderedPrompt: 'Handle evt-42',
      context: {
        webhook: {
          body: { event: { id: 'evt-42' } },
          headers: { 'x-event-type': 'deployment.failed' },
        },
      },
    });
  });

  it('rotates a credential with no-store semantics', async () => {
    const response = await app.request(
      '/api/projects/project-1/triggers/trigger-1/webhook/rotate',
      { method: 'POST' },
      env
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect((await response.json()).webhookCredential.token).toMatch(/^sam_wh_[A-Za-z0-9_-]{43}$/);
  });

  it('paginates equal timestamps with an opaque cursor and rejects malformed cursors', async () => {
    const receivedAt = '2026-07-13T12:30:00.000Z';
    for (const id of ['delivery-a', 'delivery-c', 'delivery-b']) {
      sqlite
        .prepare(
          `INSERT INTO webhook_deliveries
            (id, trigger_id, request_fingerprint, outcome, http_status, body_bytes,
             received_at, processed_at, expires_at)
           VALUES (?, 'trigger-1', ?, 'accepted', 202, 10, ?, ?, '2026-07-20T00:00:00.000Z')`
        )
        .run(id, id, receivedAt, receivedAt);
    }
    const path = '/api/projects/project-1/triggers/trigger-1/webhook/deliveries';
    const first = await app.request(`${path}?limit=99`, undefined, env);
    const firstBody = await first.json<{ deliveries: Array<{ id: string }>; nextCursor: string }>();
    const second = await app.request(
      `${path}?cursor=${encodeURIComponent(firstBody.nextCursor)}`,
      undefined,
      env
    );
    const secondBody = await second.json<{ deliveries: Array<{ id: string }> }>();

    expect(firstBody.deliveries.map((delivery) => delivery.id)).toEqual(['delivery-c']);
    expect(secondBody.deliveries.map((delivery) => delivery.id)).toEqual(['delivery-b']);
    expect((await app.request(`${path}?cursor=not-a-cursor`, undefined, env)).status).toBe(400);
  });
});
