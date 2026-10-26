import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { AppError } from '../../src/middleware/error';
import { handleCreateTrigger, handleUpdateTrigger } from '../../src/routes/mcp/trigger-tools';
import { crudRoutes } from '../../src/routes/triggers/crud';
import { createAllSchemaTables, createSqliteD1WithBindLimit } from '../helpers/sqlite-d1';
import { seedProjectWithMember, seedUser } from '../unit/routes/capacity-pool-test-seeds';

vi.mock('../../src/middleware/auth', () => ({ getAuth: () => ({ user: { id: 'user' } }) }));
vi.mock('../../src/services/project-multiplayer', () => ({
  getProjectMultiplayerState: vi.fn().mockResolvedValue({ multiplayerActive: false }),
  clearProjectMultiplayerStateCache: vi.fn(),
}));
vi.mock('../../src/services/credential-attribution-health', () => ({
  buildCredentialAttributionForTriggers: vi.fn().mockResolvedValue(new Map()),
  clearCredentialAttributionHealthCache: vi.fn(),
}));

const token = {
  taskId: 'task',
  projectId: 'project',
  userId: 'user',
  workspaceId: 'ws',
  createdAt: '2026-10-07T00:00:00Z',
};
const input = {
  name: 'GitHub',
  sourceType: 'github',
  githubConfig: {
    eventType: 'issue_comment',
    filters: { actions: ['created'], commandPrefix: '/sam', bodyContains: 'please' },
  },
  promptTemplate: 'Review {{github.comment}}',
};

describe('GitHub REST/MCP configuration parity', () => {
  let sqlite: Database.Database;
  let env: Env;
  const app = new Hono<{ Bindings: Env }>();
  app.onError((error, c) =>
    error instanceof AppError
      ? c.json(error.toJSON(), error.statusCode as 400)
      : c.json({ error: error.message }, 500)
  );
  app.route('/projects/:projectId/triggers', crudRoutes);
  beforeEach(() => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    seedUser(sqlite, 'user');
    seedProjectWithMember(sqlite, { projectId: 'project', userId: 'user', role: 'owner' });
    env = { DATABASE: createSqliteD1WithBindLimit(sqlite, 100) } as Env;
  });
  afterEach(() => sqlite.close());
  const request = (path: string, method = 'GET', body?: unknown) =>
    app.request(
      `/projects/project/triggers${path}`,
      {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      env
    );
  const parse = (response: Awaited<ReturnType<typeof handleCreateTrigger>>) =>
    JSON.parse((response.result as { content: { text: string }[] }).content[0].text);

  it('roundtrips review events and complete structured filters through REST and MCP', async () => {
    const githubConfig = {
      eventType: 'pull_request_review',
      filters: {
        actions: ['submitted'],
        actors: ['alice'],
        ignoreBots: true,
        authorAssociation: ['MEMBER'],
        commentContains: '/sam',
        isPullRequest: true,
        reviewStates: ['changes_requested'],
      },
    };
    const body = {
      ...input,
      githubConfig,
      maxConcurrent: 3,
      skipIfRunning: false,
      description: 'Review burst',
    };
    const rest = await request('', 'POST', body);
    expect(rest.status).toBe(201);
    expect(await rest.json()).toMatchObject({
      githubConfig,
      maxConcurrent: 3,
      skipIfRunning: false,
      description: 'Review burst',
    });
    const mcp = parse(
      await handleCreateTrigger('review', { ...body, name: 'MCP review' }, token, env)
    );
    expect(mcp).toMatchObject({ githubConfig, maxConcurrent: 3, skipIfRunning: false });
    const invalid = {
      ...body,
      githubConfig: {
        ...githubConfig,
        filters: { ...githubConfig.filters, authorAssociation: ['ADMIN'] },
      },
    };
    expect((await request('', 'POST', invalid)).status).toBe(400);
    expect(
      (await handleCreateTrigger('invalid-association', invalid, token, env)).error
    ).toBeDefined();
  });

  it('rejects incompatible actions through both REST and MCP without changing existing config', async () => {
    const invalid = {
      ...input,
      githubConfig: { eventType: 'issues', filters: { actions: ['created'] } },
    };
    expect((await request('', 'POST', invalid)).status).toBe(400);
    expect((await handleCreateTrigger('invalid', invalid, token, env)).error).toBeDefined();
    const created = parse(await handleCreateTrigger('valid', input, token, env));
    expect(
      (await request(`/${created.id}`, 'PATCH', { githubConfig: invalid.githubConfig })).status
    ).toBe(400);
    expect(
      (
        await handleUpdateTrigger(
          'invalid-update',
          { triggerId: created.id, githubConfig: invalid.githubConfig },
          token,
          env
        )
      ).error
    ).toBeDefined();
    expect(
      ((await (await request(`/${created.id}`)).json()) as { githubConfig: unknown }).githubConfig
    ).toMatchObject(input.githubConfig);
    expect(
      (
        await request(`/${created.id}`, 'PATCH', {
          githubConfig: { eventType: 'push', filters: { actions: ['opened'] } },
        })
      ).status
    ).toBe(400);
  });

  it('resets auto-pause boundary only on an actual resume in REST and MCP', async () => {
    const created = parse(await handleCreateTrigger('valid', input, token, env));
    sqlite.prepare('UPDATE triggers SET next_execution_sequence = 7').run();
    await request(`/${created.id}`, 'PATCH', { status: 'paused' });
    expect((await request(`/${created.id}`, 'PATCH', { status: 'active' })).status).toBe(200);
    expect(
      sqlite
        .prepare('SELECT auto_pause_reset_sequence AS boundary FROM triggers WHERE id = ?')
        .get(created.id)
    ).toEqual({ boundary: 7 });
    sqlite.prepare('UPDATE triggers SET next_execution_sequence = 8').run();
    await handleUpdateTrigger(
      'still-active',
      { triggerId: created.id, status: 'active' },
      token,
      env
    );
    expect(
      sqlite
        .prepare('SELECT auto_pause_reset_sequence AS boundary FROM triggers WHERE id = ?')
        .get(created.id)
    ).toEqual({ boundary: 7 });
    await handleUpdateTrigger('pause', { triggerId: created.id, status: 'paused' }, token, env);
    expect(
      (await handleUpdateTrigger('resume', { triggerId: created.id, status: 'active' }, token, env))
        .error
    ).toBeUndefined();
    expect(
      sqlite
        .prepare('SELECT auto_pause_reset_sequence AS boundary FROM triggers WHERE id = ?')
        .get(created.id)
    ).toEqual({ boundary: 8 });
  });

  it('creates via MCP, reads and updates via REST, reads updated configuration via MCP', async () => {
    const created = parse(await handleCreateTrigger('1', input, token, env));
    const read = await request(`/${created.id}`);
    expect(read.status).toBe(200);
    expect(((await read.json()) as { githubConfig: unknown }).githubConfig).toMatchObject(
      input.githubConfig
    );
    const config = { eventType: 'push', filters: { branches: ['main'] } };
    const updated = await request(`/${created.id}`, 'PATCH', { githubConfig: config });
    expect(updated.status).toBe(200);
    expect(((await updated.json()) as { githubConfig: unknown }).githubConfig).toMatchObject(config);
    const mcp = parse(await handleUpdateTrigger('2', { triggerId: created.id }, token, env));
    expect(mcp.githubConfig).toMatchObject(config);
    expect(mcp.nextFireAt).toBeNull();
  });
  it('creates via REST and updates via MCP', async () => {
    const response = await request('', 'POST', input);
    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: string; githubConfig: unknown };
    expect(created.githubConfig).toMatchObject(input.githubConfig);
    const config = { eventType: 'pull_request', filters: { ignoreDrafts: true } };
    expect(
      parse(
        await handleUpdateTrigger('2', { triggerId: created.id, githubConfig: config }, token, env)
      ).githubConfig
    ).toMatchObject(config);
    expect(
      ((await (await request(`/${created.id}`)).json()) as { githubConfig: unknown }).githubConfig
    ).toMatchObject(config);
  });
  it('allows metadata reads and updates without a stored config but rejects replacement', async () => {
    const created = parse(await handleCreateTrigger('1', input, token, env));
    sqlite.prepare('DELETE FROM github_trigger_configs WHERE trigger_id = ?').run(created.id);
    expect(
      parse(await handleUpdateTrigger('2', { triggerId: created.id }, token, env)).githubConfig
    ).toBeUndefined();
    expect(
      parse(await handleUpdateTrigger('3', { triggerId: created.id, name: 'Renamed' }, token, env))
        .name
    ).toBe('Renamed');
    expect(
      (
        await handleUpdateTrigger(
          '4',
          { triggerId: created.id, githubConfig: input.githubConfig },
          token,
          env
        )
      ).error?.message
    ).toContain('GitHub trigger configuration');
    expect(
      (await request(`/${created.id}`, 'PATCH', { githubConfig: input.githubConfig })).status
    ).toBe(404);
  });
  it.each(['not-json', '{"labels":42}'])(
    'reads and repairs malformed stored filters %s',
    async (filters) => {
      const created = parse(await handleCreateTrigger('1', input, token, env));
      const corrupt = () =>
        sqlite
          .prepare('UPDATE github_trigger_configs SET filters_json = ? WHERE trigger_id = ?')
          .run(filters, created.id);
      corrupt();
      expect(
        parse(await handleUpdateTrigger('2', { triggerId: created.id }, token, env)).githubConfig
          .filters
      ).toEqual({});
      expect(
        parse(
          await handleUpdateTrigger('3', { triggerId: created.id, name: 'Renamed' }, token, env)
        ).githubConfig.filters
      ).toEqual({});
      const config = { eventType: 'push', filters: { branches: ['main'] } };
      expect(
        parse(
          await handleUpdateTrigger(
            '4',
            { triggerId: created.id, githubConfig: config },
            token,
            env
          )
        ).githubConfig
      ).toMatchObject(config);
      corrupt();
      const repaired = await request(`/${created.id}`, 'PATCH', { githubConfig: config });
      expect(repaired.status).toBe(200);
      expect(((await repaired.json()) as { githubConfig: unknown }).githubConfig).toMatchObject(config);
    }
  );
  it('rejects source-mismatched and malformed REST updates without changing the config', async () => {
    const created = parse(await handleCreateTrigger('1', input, token, env));
    for (const body of [
      { cronExpression: '0 9 * * *' },
      { githubConfig: { eventType: 'unknown' } },
      { githubConfig: { eventType: 'issues', filters: { labels: 42 } } },
    ]) {
      expect((await request(`/${created.id}`, 'PATCH', body)).status).toBe(400);
    }
    expect(
      ((await (await request(`/${created.id}`)).json()) as { githubConfig: unknown }).githubConfig
    ).toMatchObject(input.githubConfig);
    const cron = await request('', 'POST', {
      name: 'Cron',
      sourceType: 'cron',
      cronExpression: '0 9 * * *',
      promptTemplate: 'Review',
    });
    expect(cron.status).toBe(201);
    const row = (await cron.json()) as { id: string };
    expect(
      (await request(`/${row.id}`, 'PATCH', { githubConfig: input.githubConfig })).status
    ).toBe(400);
  });
});
