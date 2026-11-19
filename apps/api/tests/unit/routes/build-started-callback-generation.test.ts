/**
 * The build-started route against a real callback-JWT verifier and a real SQLite row.
 *
 * A restart starts a new attempt in one write: `reserveWorkspaceRestart` rotates
 * `workspaces.callback_generation` (#2598) and clears `build_started_at` (the per-attempt clock in
 * `workspace-creating-deadline.ts`). A build-started callback that the PREVIOUS attempt's VM agent
 * sends late carries the previous generation, so `verifyCallbackToken` must reject it before it
 * can stamp the new attempt's build start and hand it the build budget early. The current
 * attempt's token still records it.
 */
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { signCallbackToken } from '../../../src/services/jwt';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({ notify: vi.fn() }));
vi.mock('../../../src/services/task-runner-do', () => ({
  notifyTaskRunnerWorkspaceBuildStarted: mocks.notify,
}));

const WS = 'ws-1';
let keys: { privateKey: string; publicKey: string };
let sqlite: Database.Database;
let env: Env;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  keys = {
    privateKey: await exportPKCS8(pair.privateKey),
    publicKey: await exportSPKI(pair.publicKey),
  };
});

beforeEach(() => {
  mocks.notify.mockReset();
  mocks.notify.mockResolvedValue(undefined);
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema as unknown as Record<string, unknown>);
  env = {
    DATABASE: createSqliteD1(sqlite),
    BASE_DOMAIN: 'example.test',
    JWT_PRIVATE_KEY: keys.privateKey,
    JWT_PUBLIC_KEY: keys.publicKey,
  } as unknown as Env;
  sqlite
    .prepare(
      `INSERT INTO nodes (id, user_id, name, status, runtime) VALUES ('node-1', 'user-1', 'n', 'running', 'vm')`
    )
    .run();
  // The row as a restart leaves it: new attempt clock, build not started, generation rotated.
  sqlite
    .prepare(
      `INSERT INTO workspaces
         (id, user_id, node_id, project_id, name, status, created_at, creating_started_at,
          build_started_at, callback_generation)
       VALUES (?, 'user-1', 'node-1', 'project-1', 'ws', 'creating', ?, ?, NULL, 'gen-new')`
    )
    .run(WS, '2026-11-01T00:00:00.000Z', new Date().toISOString());
  sqlite
    .prepare(
      `INSERT INTO tasks (id, project_id, user_id, workspace_id) VALUES ('task-1', 'project-1', 'user-1', ?)`
    )
    .run(WS);
});

afterEach(() => sqlite.close());

async function postBuildStarted(token: string, requestEnv: Env = env): Promise<Response> {
  const { buildStartedCallbackRoute } =
    await import('../../../src/routes/projects/build-started-callback');
  const app = new Hono();
  app.route('/api/projects', buildStartedCallbackRoute);
  app.onError((err, c) =>
    err instanceof AppError
      ? c.json(err.toJSON(), err.statusCode as 401 | 403 | 410)
      : c.json({ error: String(err) }, 500)
  );
  return app.request(
    '/api/projects/project-1/tasks/task-1/build-started',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: WS }),
    },
    requestEnv
  );
}

function buildStartedAt(): string | null {
  return (
    sqlite.prepare('SELECT build_started_at FROM workspaces WHERE id = ?').get(WS) as {
      build_started_at: string | null;
    }
  ).build_started_at;
}

describe('build-started after a restart rotated the callback generation', () => {
  it("rejects the previous attempt's late signal and leaves the new attempt queued", async () => {
    const previousAttempt = await signCallbackToken(WS, env, { callbackGeneration: 'gen-old' });

    const response = await postBuildStarted(previousAttempt);

    expect(response.status).toBe(401);
    expect(buildStartedAt()).toBeNull();
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it('accepts that same token while its generation is still current, so the rotation is what rejects it', async () => {
    sqlite.prepare("UPDATE workspaces SET callback_generation = 'gen-old' WHERE id = ?").run(WS);
    const sameToken = await signCallbackToken(WS, env, { callbackGeneration: 'gen-old' });

    expect((await postBuildStarted(sameToken)).status).toBe(204);
    expect(buildStartedAt()).not.toBeNull();
  });

  it("records the current attempt's build start", async () => {
    const currentAttempt = await signCallbackToken(WS, env, { callbackGeneration: 'gen-new' });

    const response = await postBuildStarted(currentAttempt);

    expect(response.status).toBe(204);
    expect(Date.parse(buildStartedAt() ?? '')).toBeGreaterThan(Date.now() - 60_000);
    expect(mocks.notify).toHaveBeenCalledWith(env, 'task-1', WS);
  });

  it('rejects a previous-attempt callback when a restart rotates the generation after it authenticated', async () => {
    // The previous attempt is still current when its callback authenticates...
    sqlite.prepare("UPDATE workspaces SET callback_generation = 'gen-old' WHERE id = ?").run(WS);
    const previousAttempt = await signCallbackToken(WS, env, { callbackGeneration: 'gen-old' });
    let rotated = false;
    const database = new Proxy(env.DATABASE, {
      get(target, prop) {
        if (prop !== 'prepare') {
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return (query: string) => {
          // ...then a restart lands between authentication and the build-start write, in the
          // restart's own shape: new attempt clock, build start cleared, generation rotated.
          if (!rotated && query.includes('UPDATE workspaces SET build_started_at = ?')) {
            rotated = true;
            sqlite
              .prepare(
                `UPDATE workspaces SET creating_started_at = ?, build_started_at = NULL,
                   callback_generation = 'gen-new' WHERE id = ?`
              )
              .run(new Date().toISOString(), WS);
          }
          return target.prepare(query);
        };
      },
    });

    const response = await postBuildStarted(previousAttempt, { ...env, DATABASE: database });

    expect(rotated).toBe(true);
    expect(response.status).toBe(401);
    expect(buildStartedAt()).toBeNull();
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it('still records a legacy callback whose token and row carry no generation', async () => {
    sqlite.prepare('UPDATE workspaces SET callback_generation = NULL WHERE id = ?').run(WS);
    const legacy = await signCallbackToken(WS, env, { callbackGeneration: null });

    expect((await postBuildStarted(legacy)).status).toBe(204);
    expect(buildStartedAt()).not.toBeNull();
    expect(mocks.notify).toHaveBeenCalledOnce();
  });
});
