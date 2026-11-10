/**
 * Agent model calls (Cloudflare-hosted models) on an installation with no Workers AI binding.
 *
 * - GET /api/agent-models/catalog through real Hono routing and the real global error handler.
 * - `list_ai_models` / `run_ai_model` services, and the MCP route that maps their errors.
 *
 * The catalog is cached in the isolate and in KV by a runtime that HAS Workers AI, so the
 * absent cases are driven off a cache that real traffic populated, and each is paired with a
 * control showing the same cache would have been served had the binding been present.
 */
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ userId: 'owner' }));

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireApproved: () => async (_c: unknown, next: () => Promise<void>) => next(),
  getUserId: () => auth.userId,
}));

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { handleAppError } from '../../../src/middleware/app-error-handler';
import { agentModelCatalogRoutes } from '../../../src/routes/agent-models';
import { resetAgentModelCatalogCacheForTests } from '../../../src/services/agent-models/catalog';
import { AgentModelCallError } from '../../../src/services/agent-models/errors';
import { listAgentModelsForAgent } from '../../../src/services/agent-models/list';
import { runAgentModelForAgent } from '../../../src/services/agent-models/run';
import {
  callMcpTool,
  createJsonKv,
  createMcpApp,
  seedActiveMcpWorkspace,
} from '../../helpers/mcp-route';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const PROJECT = 'proj-1';
const USER = 'user-1';
const WORKSPACE = 'ws-1';
const TOKEN = 'agent-token';
const CLEF_FLASH = '@cf/cloudflare/clef-flash';

/** Rows in the shape Cloudflare's model search returns. */
const CATALOG_ROWS = [
  {
    name: CLEF_FLASH,
    description: 'Fast decision model.',
    task: { name: 'Text Generation' },
    properties: [
      {
        property_id: 'price',
        value: [{ unit: 'per M input tokens', price: 0.038, currency: 'USD' }],
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

describe('agent models without Workers AI', () => {
  let sqlite: Database.Database;
  let kv: KVNamespace;
  let models: ReturnType<typeof vi.fn>;
  let run: ReturnType<typeof vi.fn>;

  /** A Cloudflare runtime: Workers AI present. */
  const cloudflareEnv = (): Env =>
    ({
      DATABASE: createSqliteD1(sqlite),
      KV: kv,
      AI: { models, run },
    }) as unknown as Env;
  /** A Workers-compatible runtime with no AI binding, sharing the same KV namespace. */
  const selfHostedEnv = (): Env => ({ DATABASE: createSqliteD1(sqlite), KV: kv }) as unknown as Env;

  beforeEach(() => {
    resetAgentModelCatalogCacheForTests();
    auth.userId = 'owner';
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema as unknown as Record<string, unknown>);
    sqlite
      .prepare(
        "INSERT INTO projects (id, name, user_id, updated_at) VALUES (?, 'P', ?, datetime('now'))"
      )
      .run(PROJECT, USER);
    sqlite
      .prepare(
        "INSERT INTO project_members (project_id, user_id, role, status) VALUES (?, ?, 'owner', 'active')"
      )
      .run(PROJECT, USER);
    kv = createJsonKv();
    models = vi.fn(async () => CATALOG_ROWS);
    run = vi.fn();
  });

  afterEach(() => sqlite.close());

  describe('GET /api/agent-models/catalog', () => {
    const app = () => {
      const testApp = new Hono<{ Bindings: Env }>();
      testApp.onError(handleAppError);
      testApp.route('/api/agent-models', agentModelCatalogRoutes);
      return testApp;
    };
    const getCatalog = (env: Env) => app().request('/api/agent-models/catalog', {}, env);

    it('with Workers AI lists the hosted catalog (Cloudflare behaviour)', async () => {
      const res = await getCatalog(cloudflareEnv());
      const body = (await res.json()) as { models: Array<{ id: string }> };

      expect(res.status).toBe(200);
      expect(body.models.map((model) => model.id)).toContain(CLEF_FLASH);
      expect(models).toHaveBeenCalledTimes(1);
    });

    it('without Workers AI answers 404 FEATURE_UNAVAILABLE for workersAi, not a 503 retry hint', async () => {
      const res = await getCatalog(selfHostedEnv());

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: 'FEATURE_UNAVAILABLE',
        message: 'Agent model calls need Workers AI, which this installation does not have',
        details: { feature: 'workersAi' },
      });
    });

    it('does not serve a catalog cached in KV by a Workers AI runtime', async () => {
      // A runtime with Workers AI populates KV (and the isolate cache).
      expect((await getCatalog(cloudflareEnv())).status).toBe(200);
      expect(models).toHaveBeenCalledTimes(1);

      // Control: with the binding present, the cached copy IS served from KV without a refetch.
      resetAgentModelCatalogCacheForTests();
      const control = await getCatalog(cloudflareEnv());
      expect(control.status).toBe(200);
      expect(models).toHaveBeenCalledTimes(1);

      // Same KV, no binding: the cache must not answer, from KV or from the isolate.
      resetAgentModelCatalogCacheForTests();
      const fromKv = await getCatalog(selfHostedEnv());
      expect(fromKv.status).toBe(404);
      expect(JSON.stringify(await fromKv.json())).not.toContain(CLEF_FLASH);

      expect((await getCatalog(cloudflareEnv())).status).toBe(200); // repopulates the isolate cache
      const fromIsolate = await getCatalog(selfHostedEnv());
      expect(fromIsolate.status).toBe(404);
      expect(JSON.stringify(await fromIsolate.json())).not.toContain(CLEF_FLASH);
    });

    it('keeps Cloudflare upstream failures as 503 (a different, retryable condition)', async () => {
      models.mockRejectedValue(new Error('upstream down'));

      const res = await getCatalog(cloudflareEnv());

      expect(res.status).toBe(503);
    });
  });

  describe('list_ai_models / run_ai_model services', () => {
    const caller = { projectId: PROJECT, userId: USER };

    it('list with Workers AI returns the enabled models and the budget (Cloudflare behaviour)', async () => {
      const result = (await listAgentModelsForAgent(cloudflareEnv(), caller, {})) as {
        enabled: boolean;
        models: Array<{ id: string }>;
        budget: { limitUsd: number };
      };

      expect(result.enabled).toBe(true);
      expect(result.models.length).toBeGreaterThan(0);
      expect(result.budget.limitUsd).toBeGreaterThan(0);
    });

    it('list without Workers AI throws AgentModelCallError not_available', async () => {
      const failure = await listAgentModelsForAgent(selfHostedEnv(), caller, {}).then(
        () => null,
        (err: unknown) => err
      );

      expect(failure).toBeInstanceOf(AgentModelCallError);
      expect(failure).toMatchObject({ code: 'not_available' });
    });

    it('run without Workers AI throws not_available and calls no model', async () => {
      const failure = await runAgentModelForAgent(selfHostedEnv(), caller, {
        model: CLEF_FLASH,
        input: { text: 'hello' },
      }).then(
        () => null,
        (err: unknown) => err
      );

      expect(failure).toBeInstanceOf(AgentModelCallError);
      expect(failure).toMatchObject({ code: 'not_available' });
      expect(run).not.toHaveBeenCalled();
    });

    it('run with Workers AI gets past the catalog gate to the model lookup (control for the refusal above)', async () => {
      // An id outside the catalog fails at the next step, proving the catalog step succeeded.
      const failure = await runAgentModelForAgent(cloudflareEnv(), caller, {
        model: '@cf/meta/not-in-the-catalog',
        input: { text: 'hello' },
      }).then(
        () => null,
        (err: unknown) => err
      );

      expect(failure).toMatchObject({ code: 'unknown_model' });
    });
  });

  describe('through the MCP route', () => {
    let app: Hono;
    beforeAll(async () => {
      app = await createMcpApp();
    }, 60_000);

    async function seedToken() {
      sqlite
        .prepare(
          "INSERT INTO workspaces (id, project_id, user_id, node_id, status) VALUES (?, ?, ?, 'node-1', 'running')"
        )
        .run(WORKSPACE, PROJECT, USER);
      seedActiveMcpWorkspace(sqlite, { workspaceId: WORKSPACE, userId: USER, projectId: PROJECT });
      await kv.put(
        `mcp:${TOKEN}`,
        JSON.stringify({
          taskId: 'task-1',
          projectId: PROJECT,
          userId: USER,
          workspaceId: WORKSPACE,
          createdAt: new Date().toISOString(),
        })
      );
    }

    it('list_ai_models reports reason not_available as a non-retryable refusal without Workers AI', async () => {
      await seedToken();

      const response = await callMcpTool(app, selfHostedEnv(), TOKEN, 'list_ai_models', {});

      expect(response.result).toBeUndefined();
      expect(response.error).toMatchObject({
        code: -32602, // invalid params: retrying cannot help, unlike catalog_unavailable (internal)
        data: { reason: 'not_available' },
      });
    });

    it('list_ai_models succeeds through the same route when Workers AI is present', async () => {
      await seedToken();

      const response = await callMcpTool(app, cloudflareEnv(), TOKEN, 'list_ai_models', {});

      expect(response.error).toBeUndefined();
      expect(response.result?.content[0]?.text).toContain(CLEF_FLASH);
    });
  });
});
