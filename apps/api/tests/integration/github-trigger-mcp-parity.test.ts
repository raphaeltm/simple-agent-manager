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

  it('creates via MCP, reads and updates via REST, reads updated configuration via MCP', async () => {
    const created = parse(await handleCreateTrigger('1', input, token, env));
    const read = await request(`/${created.id}`);
    expect(read.status).toBe(200);
    expect(((await read.json()) as { githubConfig: unknown }).githubConfig).toEqual(
      input.githubConfig
    );
    const config = { eventType: 'push', filters: { branches: ['main'] } };
    const updated = await request(`/${created.id}`, 'PATCH', { githubConfig: config });
    expect(updated.status).toBe(200);
    expect(((await updated.json()) as { githubConfig: unknown }).githubConfig).toEqual(config);
    const mcp = parse(await handleUpdateTrigger('2', { triggerId: created.id }, token, env));
    expect(mcp.githubConfig).toEqual(config);
    expect(mcp.nextFireAt).toBeNull();
  });
  it('creates via REST and updates via MCP', async () => {
    const response = await request('', 'POST', input);
    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: string; githubConfig: unknown };
    expect(created.githubConfig).toEqual(input.githubConfig);
    const config = { eventType: 'pull_request', filters: { ignoreDrafts: true } };
    expect(
      parse(
        await handleUpdateTrigger('2', { triggerId: created.id, githubConfig: config }, token, env)
      ).githubConfig
    ).toEqual(config);
    expect(
      ((await (await request(`/${created.id}`)).json()) as { githubConfig: unknown }).githubConfig
    ).toEqual(config);
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
      ).toEqual(config);
      corrupt();
      const repaired = await request(`/${created.id}`, 'PATCH', { githubConfig: config });
      expect(repaired.status).toBe(200);
      expect(((await repaired.json()) as { githubConfig: unknown }).githubConfig).toEqual(config);
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
    ).toEqual(input.githubConfig);
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
