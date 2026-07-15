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
  installationId: 'installation-1',
  defaultBranch: 'main',
}));

const authState = vi.hoisted(() => ({ userId: 'user-1' }));
const admissionState = vi.hoisted(() => ({ renderedPrompt: '' }));

vi.mock('../../src/middleware/auth', () => ({
  getAuth: () => ({ user: { id: authState.userId } }),
}));

vi.mock('../../src/services/trigger-admission', () => ({
  admitAndSubmitTriggerExecution: vi.fn(async (_env, input) => {
    admissionState.renderedPrompt = input.renderPrompt('execution-manual', 1);
    return {
      outcome: 'submitted',
      executionId: 'execution-manual',
      taskId: 'task-manual',
      sessionId: 'session-manual',
      branchName: 'sam/manual',
    };
  }),
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

import { actionRoutes } from '../../src/routes/triggers/actions';
import { crudRoutes } from '../../src/routes/triggers/crud';
import { webhookRoutes } from '../../src/routes/triggers/webhooks';
import { generateWebhookToken, hashWebhookToken } from '../../src/services/webhook-trigger-crypto';

const SCHEMA = `
CREATE TABLE users (id TEXT PRIMARY KEY);
CREATE TABLE github_installations (id TEXT PRIMARY KEY);
CREATE TABLE projects (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL,
  normalized_name TEXT NOT NULL, description TEXT,
  installation_id TEXT NOT NULL REFERENCES github_installations(id), repository TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main', repo_provider TEXT NOT NULL DEFAULT 'github',
  artifacts_repo_id TEXT, github_repo_id INTEGER, github_repo_node_id TEXT,
  default_vm_size TEXT, default_agent_type TEXT, default_workspace_profile TEXT,
  default_devcontainer_config_name TEXT, default_provider TEXT, default_location TEXT,
  agent_defaults TEXT, workspace_idle_timeout_ms INTEGER, node_idle_timeout_ms INTEGER,
  task_execution_timeout_ms INTEGER, max_concurrent_tasks INTEGER, max_dispatch_depth INTEGER,
  max_sub_tasks_per_task INTEGER, warm_node_timeout_ms INTEGER, max_workspaces_per_node INTEGER,
  node_cpu_threshold_percent INTEGER, node_memory_threshold_percent INTEGER,
  status TEXT NOT NULL DEFAULT 'active', last_activity_at TEXT,
  active_session_count INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL, status TEXT NOT NULL, invited_by TEXT REFERENCES users(id), removed_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, user_id)
);
CREATE TABLE agent_profiles (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL
);
CREATE TABLE triggers (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL,
  description TEXT, status TEXT NOT NULL DEFAULT 'active', source_type TEXT NOT NULL,
  cron_expression TEXT, cron_timezone TEXT DEFAULT 'UTC', skip_if_running INTEGER NOT NULL DEFAULT 1,
  prompt_template TEXT NOT NULL, agent_profile_id TEXT REFERENCES agent_profiles(id),
  skill_id TEXT, task_mode TEXT DEFAULT 'task',
  vm_size_override TEXT, max_concurrent INTEGER NOT NULL DEFAULT 1, last_triggered_at TEXT,
  trigger_count INTEGER NOT NULL DEFAULT 0, next_execution_sequence INTEGER NOT NULL DEFAULT 1,
  next_fire_at TEXT, credential_blocked_reason TEXT, credential_blocked_at TEXT,
  credential_blocked_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE webhook_trigger_configs (
  trigger_id TEXT PRIMARY KEY REFERENCES triggers(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE, token_last_four TEXT NOT NULL,
  token_created_at TEXT NOT NULL, token_rotated_at TEXT, source_label TEXT,
  filter_mode TEXT NOT NULL DEFAULT 'all', filters_json TEXT NOT NULL DEFAULT '[]',
  included_headers_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY, trigger_id TEXT NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
  idempotency_key_hash TEXT, request_fingerprint TEXT NOT NULL, outcome TEXT NOT NULL,
  http_status INTEGER NOT NULL, body_bytes INTEGER NOT NULL, processing_token TEXT,
  processing_heartbeat_at TEXT, execution_id TEXT, error_code TEXT, received_at TEXT NOT NULL,
  processed_at TEXT, expires_at TEXT NOT NULL
);
CREATE TABLE github_trigger_configs (
  id TEXT PRIMARY KEY, trigger_id TEXT NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL, filters_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
`;

describe('webhook trigger management vertical slice', () => {
  let sqlite: Database.Database;
  let env: Env;
  let app: Hono<{ Bindings: Env }>;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    sqlite.exec(SCHEMA);
    sqlite.pragma('foreign_keys = ON');
    authState.userId = 'user-1';
    admissionState.renderedPrompt = '';
    const now = '2026-07-13T12:00:00.000Z';
    const token = generateWebhookToken();
    sqlite.prepare("INSERT INTO users (id) VALUES ('user-1'), ('user-2')").run();
    sqlite.prepare("INSERT INTO github_installations (id) VALUES ('installation-1')").run();
    sqlite
      .prepare(
        `INSERT INTO projects
          (id, user_id, name, normalized_name, installation_id, repository, default_branch,
           created_by, created_at, updated_at)
         VALUES (?, 'user-1', ?, 'webhook-project', ?, ?, ?, 'user-1', ?, ?)`
      )
      .run(
        project.id,
        project.name,
        project.installationId,
        project.repository,
        project.defaultBranch,
        now,
        now
      );
    sqlite
      .prepare(
        `INSERT INTO project_members
          (project_id, user_id, role, status, created_at, updated_at)
         VALUES (?, 'user-1', 'owner', 'active', ?, ?),
                (?, 'user-2', 'viewer', 'active', ?, ?)`
      )
      .run(project.id, now, now, project.id, now, now);
    sqlite
      .prepare(
        "INSERT INTO agent_profiles (id, project_id, name) VALUES ('profile-1', ?, 'Default')"
      )
      .run(project.id);
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
      BASE_DOMAIN: 'example.com',
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
    app.route('/api/projects/:projectId/triggers', actionRoutes);
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

  it('renders the persisted source context through mounted test and run actions', async () => {
    const testResponse = await app.request(
      '/api/projects/project-1/triggers/trigger-1/test',
      { method: 'POST' },
      env
    );
    expect(testResponse.status).toBe(200);
    expect(await testResponse.json()).toMatchObject({
      context: { webhook: { sourceLabel: 'source', body: {}, headers: {} } },
    });

    const runResponse = await app.request(
      '/api/projects/project-1/triggers/trigger-1/run',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload: { event: { id: 'evt-run' } } }),
      },
      env
    );
    expect(runResponse.status).toBe(202);
    expect(admissionState.renderedPrompt).toBe('Handle evt-run');
  });

  it('enforces project member read and write capabilities on mounted routes', async () => {
    authState.userId = 'user-2';
    const path = '/api/projects/project-1/triggers/trigger-1/webhook';

    expect((await app.request(`${path}/deliveries`, undefined, env)).status).toBe(200);
    expect((await app.request(`${path}/rotate`, { method: 'POST' }, env)).status).toBe(403);
    expect(
      (
        await app.request(
          '/api/projects/project-1/triggers/trigger-1',
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Forbidden' }),
          },
          env
        )
      ).status
    ).toBe(403);
  });

  it('rotates a credential with no-store semantics', async () => {
    const response = await app.request(
      '/api/projects/project-1/triggers/trigger-1/webhook/rotate',
      { method: 'POST' },
      env
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    const body = await response.json();
    expect(body.webhookCredential.endpointUrl).toBe('https://api.example.com/api/webhooks/ingest');
    expect(body.webhookCredential.token).toMatch(/^sam_wh_[A-Za-z0-9_-]{43}$/);
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
