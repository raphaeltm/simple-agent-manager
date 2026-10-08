import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../src/env';
import { handleAppError } from '../../src/middleware/app-error-handler';
import { sessionSnapshotRoutes } from '../../src/routes/workspaces/session-snapshots';
import { signCallbackToken } from '../../src/services/jwt';
import { seedNode, seedUser, seedWorkspace } from './helpers/seed-d1';

describe('snapshot prepare HTTP conflicts', () => {
  it.each([
    { sleepStatus: 'stopping', status: 'pending', race: false },
    { sleepStatus: 'sleeping', status: 'pending', race: false },
    { sleepStatus: 'preparing', status: 'pending', race: true },
    { sleepStatus: 'preparing', status: 'available', race: true },
  ])('returns 409 without persisting a 500 for %j', async ({ sleepStatus, status, race }) => {
    const id = crypto.randomUUID();
    const user = `user-${id}`,
      node = `node-${id}`,
      workspace = `ws-${id}`,
      chat = `chat-${id}`;
    await seedUser(user);
    await seedNode(node, user);
    await seedWorkspace(workspace, node, user, { chatSessionId: chat, status: 'running' });
    await env.DATABASE.prepare(
      `INSERT INTO session_snapshots
      (id, chat_session_id, workspace_id, node_id, user_id, manifest_r2_key, runtime, status, sleep_status, created_at, updated_at, expires_at)
      VALUES (?, ?, ?, ?, ?, 'test/manifest', 'vm', ?, ?, datetime('now'), datetime('now'), datetime('now', '+7 days'))`
    )
      .bind(id, chat, workspace, node, user, status, sleepStatus)
      .run();
    let raceReached = false;
    const database = new Proxy(env.DATABASE, {
      get(target, prop) {
        if (prop !== 'prepare') {
          const value = Reflect.get(target, prop);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return (query: string) => {
          const statement = target.prepare(query);
          if (!race || !/^update "session_snapshots"/i.test(query)) return statement;
          return {
            bind: (...params: unknown[]) => {
              const bound = statement.bind(...params);
              return {
                run: async () => {
                  raceReached = true;
                  await target
                    .prepare("UPDATE session_snapshots SET sleep_status = 'stopping' WHERE id = ?")
                    .bind(id)
                    .run();
                  return bound.run();
                },
              };
            },
          };
        };
      },
    });
    const bindings = { ...env, DATABASE: database } as unknown as Env;
    const token = await signCallbackToken(workspace, bindings);
    const app = new Hono<{ Bindings: Env }>();
    app.onError(handleAppError);
    app.route('/api/workspaces', sessionSnapshotRoutes);
    const pending: Promise<unknown>[] = [];
    const response = await app.fetch(
      new Request(`https://api.example.com/api/workspaces/${workspace}/session-snapshot/prepare`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatSessionId: chat, runtime: 'vm' }),
      }),
      bindings,
      {
        waitUntil: (p: Promise<unknown>) => pending.push(p),
        passThroughOnException() {},
      } as ExecutionContext
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'CONFLICT' });
    await Promise.all(pending);
    expect(
      await env.OBSERVABILITY_DATABASE.prepare(
        'SELECT count(*) n FROM platform_errors WHERE workspace_id = ?'
      )
        .bind(workspace)
        .first('n')
    ).toBe(0);
    expect(
      await env.DATABASE.prepare('SELECT sleep_status FROM session_snapshots WHERE id = ?')
        .bind(id)
        .first('sleep_status')
    ).toBe(race ? 'stopping' : sleepStatus);
    expect(raceReached).toBe(race);
  });
});
