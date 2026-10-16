import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { AppError } from '../../src/middleware/error';
import { runtimeRoutes } from '../../src/routes/workspaces/runtime';
import { newProviderLimitWait } from '../../src/services/provider-limit-policy';
import { createAllSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';

const key = vi.hoisted(() => ({
  reference: 'cc_credentials:pinned',
  secret: 'test-only-secret-canary',
}));
vi.mock('../../src/routes/credentials', () => ({
  getDecryptedAgentKey: vi.fn(async () => ({
    credential: key.secret,
    credentialKind: 'api-key',
    credentialSource: 'user',
    credentialReference: key.reference,
    credentialProvider: 'opencode',
  })),
  getDecryptedCredentialRecord: vi.fn(async () => null),
}));
vi.mock('../../src/services/jwt', () => ({
  verifyCallbackToken: vi.fn(async () => ({ workspace: 'workspace-1', scope: 'workspace' })),
  signCallbackToken: vi.fn(),
}));

describe('provider wait credential pin at the authenticated secret injection route', () => {
  let sqlite: Database.Database;
  let env: Env;
  beforeEach(() => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    env = { DATABASE: createSqliteD1(sqlite), ENCRYPTION_KEY: 'test-only-not-a-real-key' } as Env;
    sqlite.exec(
      `INSERT INTO nodes(id,user_id,status)VALUES('node-1','user-1','running');INSERT INTO workspaces(id,user_id,node_id,project_id,status)VALUES('workspace-1','user-1','node-1','project-1','running');INSERT INTO tasks(id,project_id,user_id,workspace_id,status)VALUES('task-1','project-1','user-1','workspace-1','delegated');INSERT INTO agent_sessions(id,user_id,workspace_id,status,agent_credential_generation)VALUES('agent-1','user-1','workspace-1','running',0);`
    );
    key.reference = 'cc_credentials:pinned';
  });
  afterEach(() => sqlite.close());
  function pin(credentialKey: string | null) {
    const wait = newProviderLimitWait({
      taskId: 'task-1',
      origin: 'callback',
      incidentId: 'old-workspace:old-agent',
      credentialKey,
      previous: null,
      now: Date.now(),
      resetsAt: null,
    });
    sqlite
      .prepare(
        "UPDATE tasks SET provider_limit_wait_json = ?,admission_state='provider_limit_waiting'"
      )
      .run(JSON.stringify({ ...wait, phase: 'released' }));
  }
  async function inject() {
    const app = new Hono<{ Bindings: Env }>();
    app.onError((err, c) =>
      err instanceof AppError
        ? c.json(err.toJSON(), err.statusCode)
        : c.json({ error: String(err) }, 500)
    );
    app.route('/api/workspaces', runtimeRoutes);
    return app.request(
      '/api/workspaces/workspace-1/agent-key',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer test-callback', 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentType: 'opencode', agentSessionId: 'agent-1' }),
      },
      env
    );
  }
  it('matching pin can receive its selected credential', async () => {
    pin('cc_credentials:pinned');
    const response = await inject();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      apiKey: key.secret,
      credentialReference: key.reference,
    });
  });
  it('an ordinary competing task cannot shadow the workspace recovery pin', async () => {
    sqlite.exec(
      "INSERT INTO tasks(id,project_id,user_id,workspace_id,status)VALUES('task-0','project-1','user-1','workspace-1','delegated')"
    );
    pin('cc_credentials:pinned');
    sqlite.exec(
      "UPDATE tasks SET provider_limit_wait_json=NULL,admission_state=NULL WHERE id='task-1'"
    );
    key.reference = 'cc_credentials:other';
    const response = await inject();
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain(key.secret);
  });

  it('a pin changed during attribution cannot leak the selected credential', async () => {
    pin('cc_credentials:pinned');
    const original = env.DATABASE.prepare.bind(env.DATABASE);
    env.DATABASE.prepare = ((query: string) => {
      const statement = original(query);
      if (!/UPDATE agent_sessions/i.test(query)) return statement;
      const bind = statement.bind.bind(statement);
      statement.bind = ((...values: unknown[]) => {
        const bound = bind(...values);
        const first = bound.first.bind(bound);
        bound.first = (async () => {
          const result = await first();
          pin('cc_credentials:changed');
          return result;
        }) as typeof bound.first;
        return bound;
      }) as typeof statement.bind;
      return statement;
    }) as typeof env.DATABASE.prepare;
    const response = await inject();
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain(key.secret);
  });
  it('a blocked wait cannot inject even a matching credential or erase its reason', async () => {
    pin('cc_credentials:pinned');
    const saved = JSON.parse(
      (
        sqlite.prepare('SELECT provider_limit_wait_json AS value FROM tasks').get() as {
          value: string;
        }
      ).value
    );
    sqlite
      .prepare(
        "UPDATE tasks SET provider_limit_wait_json=?,admission_state='provider_limit_blocked'"
      )
      .run(
        JSON.stringify({
          ...saved,
          phase: 'blocked',
          reason: 'Blocked: provider wait budget exhausted.',
        })
      );
    const response = await inject();
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain(key.secret);
    expect(sqlite.prepare('SELECT admission_reason FROM tasks').get()).toEqual({
      admission_reason: 'Blocked: provider wait budget exhausted.',
    });
  });
  it('a workspace changed at the final pin read cannot receive a credential', async () => {
    pin('cc_credentials:pinned');
    const prepare = env.DATABASE.prepare.bind(env.DATABASE);
    let pinReads = 0;
    env.DATABASE.prepare = ((query: string) => {
      const statement = prepare(query);
      if (!/SELECT/i.test(query) || !query.includes('provider_limit_wait_json')) return statement;
      const bind = statement.bind.bind(statement);
      statement.bind = ((...values: unknown[]) => {
        const bound = bind(...values);
        const all = bound.all.bind(bound);
        bound.all = (async () => {
          if (++pinReads === 2)
            sqlite.exec("UPDATE workspaces SET status='stopping' WHERE id='workspace-1'");
          return all();
        }) as typeof bound.all;
        return bound;
      }) as typeof statement.bind;
      return statement;
    }) as typeof env.DATABASE.prepare;
    const response = await inject();
    expect(sqlite.prepare("SELECT status FROM workspaces WHERE id='workspace-1'").get()).toEqual({
      status: 'stopping',
    });
    expect(response.status).toBe(410);
    expect(await response.text()).not.toContain(key.secret);
  });
  it('terminal task metadata cannot veto a preserved workspace credential', async () => {
    pin('cc_credentials:pinned');
    sqlite.exec("UPDATE tasks SET status='completed',admission_state='provider_limit_blocked'");
    key.reference = 'cc_credentials:other';
    const response = await inject();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ credentialReference: key.reference });
    expect(sqlite.prepare('SELECT admission_state FROM tasks').get()).toEqual({
      admission_state: 'provider_limit_blocked',
    });
  });
  it.each(['mismatch', 'absent', 'malformed'] as const)(
    'a %s pin cannot expose or substitute a credential',
    async (shape) => {
      pin(shape === 'absent' ? null : 'cc_credentials:pinned');
      if (shape === 'mismatch') key.reference = 'cc_credentials:other';
      if (shape === 'malformed')
        sqlite.exec("UPDATE tasks SET provider_limit_wait_json='{malformed'");
      const response = await inject();
      expect(response.status).toBe(409);
      const body = await response.text();
      expect(body).not.toContain(key.secret);
      expect(body).not.toContain(key.reference);
      expect(sqlite.prepare('SELECT admission_state FROM tasks').get()).toEqual({
        admission_state: 'provider_limit_blocked',
      });
      expect(sqlite.prepare('SELECT agent_credential_reference FROM agent_sessions').get()).toEqual(
        { agent_credential_reference: null }
      );
    }
  );
});
