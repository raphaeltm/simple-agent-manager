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
  callbackGeneration: null as string | null,
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
  verifyCallbackToken: vi.fn(async () => ({
    workspace: 'workspace-1',
    type: 'callback',
    scope: 'workspace',
    callbackGeneration: key.callbackGeneration,
  })),
  signCallbackToken: vi.fn(),
  signCurrentWorkspaceCallbackToken: vi.fn(),
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
    key.callbackGeneration = null;
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
  describe('scoped callback approval at credential injection', () => {
    function scopedApproval() {
      pin('cc_credentials:pinned');
      sqlite.exec(`INSERT INTO agent_profiles(id,user_id,project_id,name,agent_type) VALUES ('approved-profile','user-1','project-1','Approved','opencode');
        INSERT INTO skills(id,user_id,project_id,name,agent_type) VALUES ('approved-skill','user-1','project-1','Approved',NULL);
        UPDATE tasks SET agent_profile_hint='approved-profile',skill_id='approved-skill',admission_state=NULL WHERE id='task-1';
        UPDATE agent_sessions SET agent_profile_id='approved-profile',skill_id='approved-skill';
        INSERT INTO credential_limit_windows(project_id,credential_reference,window_type,status,resets_at,observed_at)
          VALUES ('project-1','cc_credentials:pinned','subscription','rejected',9999999999999,1)`);
      const wait = JSON.parse(
        (
          sqlite.prepare('SELECT provider_limit_wait_json AS value FROM tasks').get() as {
            value: string;
          }
        ).value
      );
      const approved = {
        ...wait,
        ownerOverride: {
          credentialKey: 'cc_credentials:pinned',
          grantedAt: Date.now(),
          profileId: 'approved-profile',
          skillId: 'approved-skill',
          agentType: 'opencode',
          expiresAt: Date.now() + 60_000,
        },
      };
      sqlite.prepare('UPDATE tasks SET provider_limit_wait_json=?').run(JSON.stringify(approved));
      return JSON.stringify(approved);
    }

    it('injects only the approved account without editing the live rejected window or callback approval', async () => {
      const approved = scopedApproval();
      const before = sqlite.prepare('SELECT * FROM credential_limit_windows').all();
      const response = await inject();
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toMatchObject({
        apiKey: key.secret,
        credentialReference: 'cc_credentials:pinned',
      });
      expect(sqlite.prepare('SELECT * FROM credential_limit_windows').all()).toEqual(before);
      expect(sqlite.prepare('SELECT provider_limit_wait_json AS value FROM tasks').get()).toEqual({
        value: approved,
      });
    });

    it.each([
      ['expired', null],
      ['changed task profile', 'UPDATE tasks SET agent_profile_hint=NULL'],
      ['changed task skill', 'UPDATE tasks SET skill_id=NULL'],
      ['changed profile agent', "UPDATE agent_profiles SET agent_type='claude-code'"],
      ['changed skill agent', "UPDATE skills SET agent_type='claude-code'"],
      ['invalid profile ownership', "UPDATE agent_profiles SET project_id='other-project'"],
      ['changed account', null],
    ])('withholds the secret for %s and removes approval', async (change, sql) => {
      const approved = JSON.parse(scopedApproval());
      if (sql) sqlite.exec(sql);
      if (change === 'expired') {
        approved.ownerOverride.expiresAt = Date.now() - 1;
        sqlite.prepare('UPDATE tasks SET provider_limit_wait_json=?').run(JSON.stringify(approved));
      }
      if (change === 'changed account') key.reference = 'cc_credentials:other';
      const response = await inject();
      expect(response.status, await response.clone().text()).toBe(409);
      expect(await response.text()).not.toContain(key.secret);
      const saved = sqlite
        .prepare('SELECT admission_state,provider_limit_wait_json FROM tasks')
        .get() as { admission_state: string; provider_limit_wait_json: string };
      expect(saved.admission_state).toBe('provider_limit_blocked');
      expect(JSON.parse(saved.provider_limit_wait_json)).toMatchObject({ phase: 'blocked' });
      expect(JSON.parse(saved.provider_limit_wait_json).ownerOverride).toBeUndefined();
      expect(sqlite.prepare('SELECT agent_credential_reference FROM agent_sessions').get()).toEqual(
        { agent_credential_reference: null }
      );
    });

    it('rechecks approval after attribution so a profile mutation cannot leak the secret', async () => {
      scopedApproval();
      const prepare = env.DATABASE.prepare.bind(env.DATABASE);
      env.DATABASE.prepare = ((query: string) => {
        const statement = prepare(query);
        if (!/UPDATE agent_sessions/i.test(query)) return statement;
        const bind = statement.bind.bind(statement);
        statement.bind = ((...values: unknown[]) => {
          const bound = bind(...values);
          const first = bound.first.bind(bound);
          bound.first = (async () => {
            const result = await first();
            sqlite.exec('UPDATE tasks SET skill_id=NULL');
            return result;
          }) as typeof bound.first;
          return bound;
        }) as typeof statement.bind;
        return statement;
      }) as typeof env.DATABASE.prepare;
      const response = await inject();
      expect(response.status).toBe(409);
      expect(await response.text()).not.toContain(key.secret);
      const saved = sqlite.prepare('SELECT provider_limit_wait_json AS value FROM tasks').get() as {
        value: string;
      };
      expect(JSON.parse(saved.value).ownerOverride).toBeUndefined();
    });
  });

  it.each([null, 'current-runtime-generation'])(
    'matching pin can receive its selected credential with callback generation %s',
    async (generation) => {
      key.callbackGeneration = generation;
      sqlite.prepare('UPDATE workspaces SET callback_generation=?').run(generation);
      pin('cc_credentials:pinned');
      const response = await inject();
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        apiKey: key.secret,
        credentialReference: key.reference,
      });
    }
  );
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
  it.each([
    ['status', "status='stopping'"],
    ['callback generation', "callback_generation='replacement-runtime-generation'"],
    ['owner', "user_id='replacement-owner'"],
  ])(
    'a workspace %s changed at the final pin read cannot receive a credential',
    async (_change, mutation) => {
      key.callbackGeneration = 'current-runtime-generation';
      sqlite.prepare('UPDATE workspaces SET callback_generation=?').run(key.callbackGeneration);
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
              sqlite.exec(`UPDATE workspaces SET ${mutation} WHERE id='workspace-1'`);
            return all();
          }) as typeof bound.all;
          return bound;
        }) as typeof statement.bind;
        return statement;
      }) as typeof env.DATABASE.prepare;
      const response = await inject();
      expect(pinReads).toBe(2);
      expect(response.status).toBe(410);
      expect(await response.text()).not.toContain(key.secret);
    }
  );
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
