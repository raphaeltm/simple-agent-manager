/**
 * POST /api/workspaces/:id/agent-settings — the VM agent fetches the effective
 * model and permission mode here before starting every agent session (VM and
 * Instant runtimes alike).
 *
 * Resolution: project.agentDefaults[agentType] > user agent_settings > platform
 * default (DEFAULT_AGENT_PERMISSION_MODE). The route runs against a real SQLite
 * engine so the user_id/agent_type predicates are evaluated, not mocked. Only the
 * callback JWT check is stubbed; it has its own coverage.
 */
import { DEFAULT_AGENT_PERMISSION_MODE } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { runtimeRoutes } from '../../../src/routes/workspaces/runtime';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({
  verifyWorkspaceCallbackAuth: vi.fn(),
}));

vi.mock('../../../src/routes/workspaces/_helpers', async () => {
  const actual = await vi.importActual<typeof import('../../../src/routes/workspaces/_helpers')>(
    '../../../src/routes/workspaces/_helpers'
  );
  return {
    ...actual,
    verifyWorkspaceCallbackAuth: mocks.verifyWorkspaceCallbackAuth,
  };
});

const WORKSPACE_USER = 'user-workspace-owner';
const OTHER_USER = 'user-someone-else';
const PROJECT_ID = 'project-agent-settings';
const WORKSPACE_ID = 'ws-agent-settings';
const NODE_ID = 'node-agent-settings';

interface AgentSettingsCallbackBody {
  model: string | null;
  permissionMode: string | null;
}

describe('POST /api/workspaces/:id/agent-settings', () => {
  let sqlite: Database.Database;
  let env: Env;
  let app: Hono<{ Bindings: Env }>;

  function seedWorkspace(projectAgentDefaults: Record<string, unknown> | null): void {
    const now = '2026-10-04T00:00:00.000Z';
    sqlite
      .prepare(`INSERT INTO nodes (id, user_id, name, status) VALUES (?, ?, 'node', 'running')`)
      .run(NODE_ID, WORKSPACE_USER);
    sqlite
      .prepare(
        `INSERT INTO projects (id, user_id, name, repository, agent_defaults, created_at, updated_at)
         VALUES (?, ?, 'Project', 'acme/repo', ?, ?, ?)`
      )
      .run(
        PROJECT_ID,
        WORKSPACE_USER,
        projectAgentDefaults === null ? null : JSON.stringify(projectAgentDefaults),
        now,
        now
      );
    sqlite
      .prepare(
        `INSERT INTO workspaces (id, user_id, project_id, node_id, status)
         VALUES (?, ?, ?, ?, 'running')`
      )
      .run(WORKSPACE_ID, WORKSPACE_USER, PROJECT_ID, NODE_ID);
  }

  function seedUserSetting(
    userId: string,
    agentType: string,
    values: { model?: string | null; permissionMode?: string | null }
  ): void {
    sqlite
      .prepare(
        `INSERT INTO agent_settings (id, user_id, agent_type, model, permission_mode, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, 0)`
      )
      .run(
        `setting-${userId}-${agentType}`,
        userId,
        agentType,
        values.model ?? null,
        values.permissionMode ?? null
      );
  }

  async function fetchSettings(agentType: string): Promise<AgentSettingsCallbackBody> {
    const res = await app.request(
      `/api/workspaces/${WORKSPACE_ID}/agent-settings`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentType }),
      },
      env
    );
    expect(res.status).toBe(200);
    return (await res.json()) as AgentSettingsCallbackBody;
  }

  beforeEach(() => {
    mocks.verifyWorkspaceCallbackAuth.mockResolvedValue(undefined);
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    env = { DATABASE: createSqliteD1(sqlite) } as Env;

    app = new Hono<{ Bindings: Env }>();
    app.onError((err, c) =>
      err instanceof AppError
        ? c.json(err.toJSON(), err.statusCode as never)
        : c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500)
    );
    app.route('/api/workspaces', runtimeRoutes);
  });

  afterEach(() => {
    sqlite.close();
    vi.clearAllMocks();
  });

  it('defaults to bypassPermissions when nothing chooses a permission mode', async () => {
    seedWorkspace(null);

    const body = await fetchSettings('claude-code');

    expect(DEFAULT_AGENT_PERMISSION_MODE).toBe('bypassPermissions');
    expect(body.permissionMode).toBe('bypassPermissions');
    expect(body.model).toBeNull();
    expect(mocks.verifyWorkspaceCallbackAuth).toHaveBeenCalledOnce();
  });

  it('applies the default to every agent type, not only Claude Code', async () => {
    seedWorkspace(null);

    for (const agentType of ['openai-codex', 'opencode', 'google-gemini', 'mistral-vibe']) {
      expect((await fetchSettings(agentType)).permissionMode).toBe('bypassPermissions');
    }
  });

  it('defaults the permission mode when the saved user setting only sets a model', async () => {
    seedWorkspace(null);
    seedUserSetting(WORKSPACE_USER, 'claude-code', {
      model: 'claude-opus-5',
      permissionMode: null,
    });

    const body = await fetchSettings('claude-code');

    // The model proves the user row was read; only its empty mode falls through.
    expect(body.model).toBe('claude-opus-5');
    expect(body.permissionMode).toBe('bypassPermissions');
  });

  it("keeps the user's explicit permission mode", async () => {
    seedWorkspace(null);
    seedUserSetting(WORKSPACE_USER, 'claude-code', { permissionMode: 'plan' });

    expect((await fetchSettings('claude-code')).permissionMode).toBe('plan');
  });

  it("keeps an explicit Manual ('default') choice instead of treating it as unset", async () => {
    seedWorkspace(null);
    seedUserSetting(WORKSPACE_USER, 'claude-code', { permissionMode: 'default' });

    expect((await fetchSettings('claude-code')).permissionMode).toBe('default');
  });

  it("prefers the project's agent default over the user's setting", async () => {
    seedWorkspace({ 'claude-code': { permissionMode: 'acceptEdits' } });
    seedUserSetting(WORKSPACE_USER, 'claude-code', { permissionMode: 'plan' });

    expect((await fetchSettings('claude-code')).permissionMode).toBe('acceptEdits');
  });

  it("ignores another user's settings and the same user's settings for other agent types", async () => {
    seedWorkspace({ opencode: { permissionMode: 'plan' } });
    seedUserSetting(OTHER_USER, 'claude-code', { model: 'other-model', permissionMode: 'plan' });
    seedUserSetting(WORKSPACE_USER, 'openai-codex', { permissionMode: 'acceptEdits' });

    const body = await fetchSettings('claude-code');

    expect(body.model).toBeNull();
    expect(body.permissionMode).toBe('bypassPermissions');
  });
});
