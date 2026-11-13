import { newProviderLimitWait } from '@simple-agent-manager/scheduler-core';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { AppError } from '../../src/middleware/error';
import { runtimeRoutes } from '../../src/routes/workspaces/runtime';
import { assertProviderLimitCredentialPin } from '../../src/services/provider-limit-credential-pin';
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
      sqlite.exec(`INSERT INTO users(id,status) VALUES ('user-1','active');
        INSERT INTO project_members(project_id,user_id,role,status) VALUES ('project-1','user-1','owner','active');
        INSERT INTO agent_profiles(id,user_id,project_id,name,agent_type) VALUES ('approved-profile','user-1','project-1','Approved','opencode');
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

    it('injects only the approved account and records final authorization without editing the rejected window', async () => {
      const approved = scopedApproval();
      const before = sqlite.prepare('SELECT * FROM credential_limit_windows').all();
      const response = await inject();
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toMatchObject({
        apiKey: key.secret,
        credentialReference: 'cc_credentials:pinned',
      });
      expect(sqlite.prepare('SELECT * FROM credential_limit_windows').all()).toEqual(before);
      const saved = JSON.parse(
        (
          sqlite.prepare('SELECT provider_limit_wait_json AS value FROM tasks').get() as {
            value: string;
          }
        ).value
      );
      expect(saved.ownerOverride.firstInjection).toMatchObject({
        workspaceId: 'workspace-1',
        callbackGeneration: null,
        agentSessionId: 'agent-1',
        credentialGeneration: 1,
      });
      const { firstInjection, ...unchangedApproval } = saved.ownerOverride;
      expect(firstInjection.authorizedAt).toBeGreaterThanOrEqual(
        JSON.parse(approved).ownerOverride.grantedAt
      );
      expect({ ...saved, ownerOverride: unchangedApproval }).toEqual(JSON.parse(approved));
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

    async function expectDeniedApproval() {
      const response = await inject();
      expect(response.status, await response.clone().text()).toBe(409);
      expect(await response.text()).not.toContain(key.secret);
      const saved = sqlite.prepare('SELECT provider_limit_wait_json AS value FROM tasks').get() as {
        value: string;
      };
      expect(JSON.parse(saved.value).ownerOverride).toBeUndefined();
      expect(sqlite.prepare('SELECT agent_credential_reference FROM agent_sessions').get()).toEqual(
        { agent_credential_reference: null }
      );
    }

    it.each([
      "UPDATE project_members SET status='removed'",
      "UPDATE project_members SET role='viewer'",
      "UPDATE users SET status='disabled'",
      'DELETE FROM project_members',
    ])('denies scoped approval after project authority changes: %s', async (mutation) => {
      scopedApproval();
      sqlite.exec(mutation);
      await expectDeniedApproval();
    });

    it('denies a first callback after expiry even with a newer committed start marker', async () => {
      const approved = expiredScopedApproval();
      sqlite
        .prepare("UPDATE tasks SET status='in_progress',started_at=?")
        .run(new Date(approved.ownerOverride.expiresAt + 1).toISOString());
      await expectDeniedApproval();
    });

    it('pre-attribution validation cannot record a first release marker', async () => {
      const approved = scopedApproval();
      await assertProviderLimitCredentialPin(
        env,
        'workspace-1',
        key.reference,
        undefined,
        'opencode',
        'agent-1'
      );
      expect(
        (
          sqlite.prepare('SELECT provider_limit_wait_json AS value FROM tasks').get() as {
            value: string;
          }
        ).value
      ).toBe(approved);
    });

    it.each([undefined, 0, 1.5])(
      'rejects final authorization without an exact positive generation: %s',
      async (generation) => {
        scopedApproval();
        await expect(
          assertProviderLimitCredentialPin(
            env,
            'workspace-1',
            key.reference,
            undefined,
            'opencode',
            'agent-1',
            { credentialGeneration: generation }
          )
        ).rejects.toThrow('task blocked');
      }
    );

    function useDatabaseClock(now: () => number) {
      sqlite.function('julianday', { varargs: true }, (...args: unknown[]) => {
        let milliseconds = Date.parse(String(args[0]));
        if (args[0] === 'now') milliseconds = now();
        else if (args[1] === 'unixepoch') milliseconds = Number(args[0]) * 1000;
        return milliseconds / 86_400_000 + 2_440_587.5;
      });
    }

    function beforeMarkerAuthorization(mutate: () => void) {
      const prepare = env.DATABASE.prepare.bind(env.DATABASE);
      env.DATABASE.prepare = ((query: string) => {
        const statement = prepare(query);
        if (!query.includes('UPDATE tasks SET provider_limit_wait_json=?')) return statement;
        const bind = statement.bind.bind(statement);
        statement.bind = ((...values: unknown[]) => {
          const bound = bind(...values);
          const run = bound.run.bind(bound);
          bound.run = (async () => {
            mutate();
            return run();
          }) as typeof bound.run;
          return bound;
        }) as typeof statement.bind;
        return statement;
      }) as typeof env.DATABASE.prepare;
    }

    function afterAttribution(mutate: () => void | Promise<void>) {
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
            await mutate();
            return result;
          }) as typeof bound.first;
          return bound;
        }) as typeof statement.bind;
        return statement;
      }) as typeof env.DATABASE.prepare;
    }

    it('refuses an overlapping older attribution without revoking consent for the newer callback', async () => {
      const approved = scopedApproval();
      function gate() {
        let release = () => {};
        const promise = new Promise<void>((resolve) => {
          release = resolve;
        });
        return { promise, release: () => release() };
      }
      const ready = [gate(), gate()];
      const proceed = [gate(), gate()];
      let writes = 0;
      afterAttribution(async () => {
        const turn = writes++;
        ready[turn].release();
        await proceed[turn].promise;
      });
      const older = inject();
      await ready[0].promise;
      const newer = inject();
      await ready[1].promise;
      try {
        proceed[0].release();
        const staleResponse = await older;
        expect(staleResponse.status).toBe(409);
        expect(await staleResponse.text()).not.toContain(key.secret);
        expect(
          (
            sqlite.prepare('SELECT provider_limit_wait_json AS value FROM tasks').get() as {
              value: string;
            }
          ).value
        ).toBe(approved);
        expect(sqlite.prepare('SELECT admission_state FROM tasks').get()).toEqual({
          admission_state: null,
        });
        proceed[1].release();
        const currentResponse = await newer;
        expect(currentResponse.status, await currentResponse.clone().text()).toBe(200);
        expect(await currentResponse.json()).toMatchObject({
          apiKey: key.secret,
          credentialGeneration: 2,
        });
        const saved = JSON.parse(
          (
            sqlite.prepare('SELECT provider_limit_wait_json AS value FROM tasks').get() as {
              value: string;
            }
          ).value
        );
        expect(saved.ownerOverride.firstInjection.credentialGeneration).toBe(2);
        expect(saved.ownerOverride.grantedAt).toBe(JSON.parse(approved).ownerOverride.grantedAt);
      } finally {
        proceed.forEach((item) => item.release());
        await Promise.all([older, newer]);
      }
    });

    function expiredScopedApproval(withMarker = false) {
      const approved = JSON.parse(scopedApproval());
      approved.ownerOverride.grantedAt = Date.now() - 2_000;
      approved.ownerOverride.expiresAt = Date.now() - 1_000;
      if (withMarker) {
        approved.ownerOverride.firstInjection = {
          authorizedAt: approved.ownerOverride.grantedAt + 1,
          workspaceId: 'workspace-1',
          callbackGeneration: null,
          agentSessionId: 'agent-1',
          credentialGeneration: 1,
        };
        sqlite.exec('UPDATE agent_sessions SET agent_credential_generation=1');
      }
      sqlite.prepare('UPDATE tasks SET provider_limit_wait_json=?').run(JSON.stringify(approved));
      return approved;
    }

    it('refreshes after expiry only after a real pre-expiry final authorization', async () => {
      const approved = JSON.parse(scopedApproval());
      useDatabaseClock(() => Date.now());
      sqlite
        .prepare("UPDATE tasks SET status='in_progress',started_at=?")
        .run(new Date(approved.ownerOverride.grantedAt).toISOString());
      const first = await inject();
      expect(first.status, await first.clone().text()).toBe(200);
      const receipt = (
        sqlite.prepare('SELECT provider_limit_wait_json AS value FROM tasks').get() as {
          value: string;
        }
      ).value;
      const marker = JSON.parse(receipt).ownerOverride.firstInjection;
      expect(marker.authorizedAt).toBeLessThan(approved.ownerOverride.expiresAt);
      const clock = vi.spyOn(Date, 'now').mockReturnValue(approved.ownerOverride.expiresAt + 1);
      try {
        const refreshed = await inject();
        expect(refreshed.status, await refreshed.clone().text()).toBe(200);
        expect(await refreshed.json()).toMatchObject({
          apiKey: key.secret,
          credentialGeneration: 2,
        });
        expect(
          (
            sqlite.prepare('SELECT provider_limit_wait_json AS value FROM tasks').get() as {
              value: string;
            }
          ).value
        ).toBe(receipt);
      } finally {
        clock.mockRestore();
      }
    });

    it('cannot create refresh proof when approval expires after attribution', async () => {
      const approved = JSON.parse(scopedApproval());
      const clock = vi.spyOn(Date, 'now').mockReturnValue(approved.ownerOverride.grantedAt);
      afterAttribution(() => clock.mockReturnValue(approved.ownerOverride.expiresAt + 1));
      try {
        const response = await inject();
        expect(response.status).toBe(409);
        expect(await response.text()).not.toContain(key.secret);
        const saved = JSON.parse(
          (
            sqlite.prepare('SELECT provider_limit_wait_json AS value FROM tasks').get() as {
              value: string;
            }
          ).value
        );
        expect(saved.ownerOverride).toBeUndefined();
      } finally {
        clock.mockRestore();
      }
    });

    it.each([false, true])(
      'enforces DB-time expiry at final CAS with an existing marker: %s',
      async (existingMarker) => {
        const approved = JSON.parse(scopedApproval());
        if (existingMarker) {
          expect((await inject()).status).toBe(200);
          sqlite.exec("UPDATE tasks SET status='queued'");
        }
        let dbNow = approved.ownerOverride.grantedAt + 1;
        useDatabaseClock(() => dbNow);
        beforeMarkerAuthorization(() => {
          dbNow = approved.ownerOverride.expiresAt + 1;
        });
        const response = await inject();
        expect(response.status, await response.clone().text()).toBe(409);
        expect(await response.text()).not.toContain(key.secret);
        const saved = JSON.parse(
          (
            sqlite.prepare('SELECT provider_limit_wait_json AS value FROM tasks').get() as {
              value: string;
            }
          ).value
        );
        expect(saved.ownerOverride).toBeUndefined();
      }
    );

    it.each([
      'fresh rejection',
      'membership',
      'attribution generation',
      'profile agent',
      'superseded with membership removed',
      'superseded with profile changed',
    ])('does not release the secret when %s changes at the final marker CAS', async (change) => {
      const approved = JSON.parse(scopedApproval());
      const fresh = JSON.stringify({
        ...approved,
        phase: 'waiting',
        scheduleKey: 'fresh-rejection',
        ownerOverride: undefined,
      });
      beforeMarkerAuthorization(() => {
        if (change === 'fresh rejection')
          sqlite.prepare('UPDATE tasks SET provider_limit_wait_json=?').run(fresh);
        else if (change === 'membership')
          sqlite.exec("UPDATE project_members SET status='removed'");
        else if (change === 'profile agent')
          sqlite.exec("UPDATE agent_profiles SET agent_type='claude-code'");
        else {
          sqlite.exec(
            'UPDATE agent_sessions SET agent_credential_generation=agent_credential_generation+1'
          );
          if (change === 'superseded with membership removed')
            sqlite.exec("UPDATE project_members SET status='removed'");
          else if (change === 'superseded with profile changed')
            sqlite.exec("UPDATE agent_profiles SET agent_type='claude-code'");
        }
      });
      const response = await inject();
      expect(response.status).toBe(409);
      expect(await response.text()).not.toContain(key.secret);
      const saved = (
        sqlite.prepare('SELECT provider_limit_wait_json AS value FROM tasks').get() as {
          value: string;
        }
      ).value;
      if (change === 'fresh rejection') expect(saved).toBe(fresh);
      else if (change === 'attribution generation') expect(saved).toBe(JSON.stringify(approved));
      else expect(JSON.parse(saved).ownerOverride).toBeUndefined();
    });

    it.each([
      ['delegated', 'current'],
      ['sleeping', 'current'],
      ['in_progress', 'missing'],
      ['in_progress', 'invalid'],
      ['in_progress', 'stale'],
    ])('denies expired approval for %s with a %s start marker', async (status, marker) => {
      const approved = expiredScopedApproval(true);
      const startedAt =
        marker === 'missing'
          ? null
          : marker === 'invalid'
            ? 'not-a-timestamp'
            : new Date(
                approved.ownerOverride.grantedAt + (marker === 'stale' ? -1 : 1)
              ).toISOString();
      sqlite.prepare('UPDATE tasks SET status=?,started_at=?').run(status, startedAt);
      await expectDeniedApproval();
    });

    it.each([
      ['changed task profile', 'UPDATE tasks SET agent_profile_hint=NULL'],
      ['changed task skill', 'UPDATE tasks SET skill_id=NULL'],
      ['changed profile agent', "UPDATE agent_profiles SET agent_type='claude-code'"],
      ['changed skill agent', "UPDATE skills SET agent_type='claude-code'"],
      ['invalid profile ownership', "UPDATE agent_profiles SET project_id='other-project'"],
      ['changed account', null],
    ])('keeps the %s fence after committed-run expiry', async (change, sql) => {
      const approved = expiredScopedApproval(true);
      sqlite
        .prepare("UPDATE tasks SET status='in_progress',started_at=?")
        .run(new Date(approved.ownerOverride.grantedAt).toISOString());
      if (sql) sqlite.exec(sql);
      if (change === 'changed account') key.reference = 'cc_credentials:other';
      await expectDeniedApproval();
    });

    it.each(['workspace', 'session', 'callback generation', 'late authorization'])(
      'denies expired refresh with a mismatched first authorization %s',
      async (change) => {
        const approved = expiredScopedApproval(true);
        const marker = approved.ownerOverride.firstInjection;
        if (change === 'workspace') marker.workspaceId = 'other-workspace';
        else if (change === 'session') marker.agentSessionId = 'other-session';
        else if (change === 'callback generation')
          marker.callbackGeneration = 'replaced-generation';
        else marker.authorizedAt = approved.ownerOverride.expiresAt;
        sqlite
          .prepare("UPDATE tasks SET status='in_progress',started_at=?,provider_limit_wait_json=?")
          .run(new Date(approved.ownerOverride.grantedAt).toISOString(), JSON.stringify(approved));
        await expectDeniedApproval();
      }
    );

    it('accepts the same canonical profile selected by its scoped name hint', async () => {
      scopedApproval();
      sqlite.exec("UPDATE tasks SET agent_profile_hint='Approved'");
      const response = await inject();
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toMatchObject({ apiKey: key.secret });
    });

    it.each([null, 'replacement-skill'])(
      'withholds approval when only the runtime session skill changes to %s',
      async (skillId) => {
        scopedApproval();
        sqlite.exec(
          "INSERT INTO skills(id,user_id,project_id,name,agent_type) VALUES ('replacement-skill','user-1','project-1','Replacement',NULL)"
        );
        sqlite.prepare('UPDATE agent_sessions SET skill_id=?').run(skillId);
        const response = await inject();
        expect(response.status).toBe(409);
        expect(await response.text()).not.toContain(key.secret);
      }
    );

    it.each([
      ['runtime session skill', 'UPDATE agent_sessions SET skill_id=NULL'],
      ['task skill', 'UPDATE tasks SET skill_id=NULL'],
      ['project membership', "UPDATE project_members SET status='removed'"],
      [
        'newer credential attribution',
        'UPDATE agent_sessions SET agent_credential_generation=agent_credential_generation+1',
      ],
    ])('rechecks %s after attribution before releasing the secret', async (_scope, mutation) => {
      scopedApproval();
      afterAttribution(() => sqlite.exec(mutation));
      const response = await inject();
      expect(response.status).toBe(409);
      expect(await response.text()).not.toContain(key.secret);
      const saved = sqlite.prepare('SELECT provider_limit_wait_json AS value FROM tasks').get() as {
        value: string;
      };
      if (_scope === 'newer credential attribution')
        expect(JSON.parse(saved.value).ownerOverride).toBeDefined();
      else expect(JSON.parse(saved.value).ownerOverride).toBeUndefined();
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
