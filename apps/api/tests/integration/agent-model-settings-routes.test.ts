/**
 * Settings routes for agent model calls, through real Hono routing, real membership SQL and the
 * real validators: who may read and change a project's models and budget, and what is accepted.
 */
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ userId: 'owner' }));

vi.mock('../../src/middleware/auth', () => ({
  requireAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireApproved: () => async (_c: unknown, next: () => Promise<void>) => next(),
  getUserId: () => auth.userId,
}));

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { AppError } from '../../src/middleware/error';
import { agentModelCatalogRoutes, projectAgentModelRoutes } from '../../src/routes/agent-models';
import { resetAgentModelCatalogCacheForTests } from '../../src/services/agent-models/catalog';
import { createJsonKv } from '../helpers/mcp-route';
import { createAllSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';

const PROJECT = 'proj-1';
const CATALOG_ROWS = [
  {
    name: '@cf/cloudflare/clef',
    description: 'Decision model.',
    task: { name: 'Text Generation' },
    properties: [
      {
        property_id: 'price',
        value: [{ unit: 'per M input tokens', price: 0.24, currency: 'USD' }],
      },
    ],
  },
  {
    name: '@cf/meta/llama-3.2-1b-instruct',
    description: 'Small chat model.',
    task: { name: 'Text Generation' },
    properties: [],
  },
];

describe('agent model settings routes', () => {
  let sqlite: Database.Database;
  let env: Env;
  let app: Hono<{ Bindings: Env }>;
  let models: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetAgentModelCatalogCacheForTests();
    auth.userId = 'owner';
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema as unknown as Record<string, unknown>);
    sqlite
      .prepare(
        "INSERT INTO projects (id, name, user_id, updated_at) VALUES (?, 'P', 'owner', datetime('now'))"
      )
      .run(PROJECT);
    for (const [user, role] of [
      ['owner', 'owner'],
      ['admin', 'admin'],
      ['maintainer', 'maintainer'],
      ['viewer', 'viewer'],
    ]) {
      sqlite
        .prepare(
          "INSERT INTO project_members (project_id, user_id, role, status) VALUES (?, ?, ?, 'active')"
        )
        .run(PROJECT, user, role);
    }
    models = vi.fn(async () => CATALOG_ROWS);
    env = {
      DATABASE: createSqliteD1(sqlite),
      KV: createJsonKv(),
      AI: { models, run: vi.fn() },
    } as unknown as Env;
    app = new Hono<{ Bindings: Env }>();
    app.onError((err, c) => {
      if (err instanceof AppError) return c.json(err.toJSON(), err.statusCode as 400);
      return c.json({ error: 'INTERNAL_ERROR', message: String(err) }, 500);
    });
    app.route('/api/projects/:projectId/agent-models', projectAgentModelRoutes);
    app.route('/api/agent-models', agentModelCatalogRoutes);
  });

  afterEach(() => sqlite.close());

  const get = (path: string) => app.request(path, {}, env);
  const put = (body: unknown) =>
    app.request(
      `/api/projects/${PROJECT}/agent-models`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      env
    );

  it('serves the hosted catalog with SAM defaults to any signed-in user', async () => {
    const res = await get('/api/agent-models/catalog');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      models: Array<{ id: string; category: string }>;
      defaultModelIds: string[];
    };
    expect(body.models.map((model) => [model.id, model.category])).toEqual([
      ['@cf/cloudflare/clef', 'decision'],
      ['@cf/meta/llama-3.2-1b-instruct', 'text-generation'],
    ]);
    expect(body.defaultModelIds).toEqual(['@cf/cloudflare/clef']);
  });

  it('answers 503 when Cloudflare has never returned a catalog', async () => {
    models.mockRejectedValue(new Error('upstream down'));
    const res = await get('/api/agent-models/catalog');
    expect(res.status).toBe(503);
  });

  it('shows members the settings read-only and lets only owners and admins change them', async () => {
    auth.userId = 'viewer';
    const read = await get(`/api/projects/${PROJECT}/agent-models`);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      featureEnabled: true,
      models: null,
      effectiveSource: 'default',
      effectiveModelIds: ['@cf/cloudflare/clef'],
      monthlyBudgetUsd: null,
      effectiveMonthlyBudgetUsd: 5,
      maxMonthlyBudgetUsd: 50,
      canEdit: false,
      usage: { spentUsd: 0, callCount: 0 },
    });

    for (const user of ['viewer', 'maintainer']) {
      auth.userId = user;
      expect((await put({ models: [] })).status).toBe(403);
    }
    auth.userId = 'stranger';
    expect((await put({ models: [] })).status).toBe(404);
    expect(sqlite.prepare('SELECT agent_models_json AS models FROM projects').get()).toEqual({
      models: null,
    });

    auth.userId = 'admin';
    const res = await put({ models: ['@cf/meta/llama-3.2-1b-instruct'], monthlyBudgetUsd: 12.34 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      models: ['@cf/meta/llama-3.2-1b-instruct'],
      effectiveModelIds: ['@cf/meta/llama-3.2-1b-instruct'],
      effectiveSource: 'project',
      monthlyBudgetUsd: 12.34,
      effectiveMonthlyBudgetUsd: 12.34,
      canEdit: true,
    });
    expect(
      sqlite.prepare('SELECT agent_models_monthly_budget_cents AS cents FROM projects').get()
    ).toEqual({ cents: 1234 });
  });

  it('keeps fields that are omitted and resets fields sent as null', async () => {
    await put({ models: ['@cf/cloudflare/clef'], monthlyBudgetUsd: 3 });
    await put({ monthlyBudgetUsd: 4 });
    let body = (await (await get(`/api/projects/${PROJECT}/agent-models`)).json()) as {
      models: string[] | null;
      monthlyBudgetUsd: number | null;
    };
    expect(body).toMatchObject({ models: ['@cf/cloudflare/clef'], monthlyBudgetUsd: 4 });

    await put({ models: null, monthlyBudgetUsd: null });
    body = (await (await get(`/api/projects/${PROJECT}/agent-models`)).json()) as typeof body;
    expect(body).toMatchObject({ models: null, monthlyBudgetUsd: null });
  });

  it('rejects third-party model ids, negative budgets and budgets above the maximum', async () => {
    expect((await put({ models: ['openai/gpt-5'] })).status).toBe(400);
    expect((await put({ models: ['@cf/../../etc'] })).status).toBe(400);
    expect((await put({ monthlyBudgetUsd: -1 })).status).toBe(400);
    const tooHigh = await put({ monthlyBudgetUsd: 50.01 });
    expect(tooHigh.status).toBe(400);
    expect(((await tooHigh.json()) as { message: string }).message).toContain('at most $50.00');
    expect(
      sqlite
        .prepare(
          'SELECT agent_models_json AS models, agent_models_monthly_budget_cents AS cents FROM projects'
        )
        .get()
    ).toEqual({
      models: null,
      cents: null,
    });
  });
});
