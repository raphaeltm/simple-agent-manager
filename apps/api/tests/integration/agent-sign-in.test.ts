/**
 * Agent sign-in through workload identity, end to end.
 *
 * The trusted instance is SAM's real workload identity signer (`signWorkloadIdentityToken`) and
 * real JWKS (`getWorkloadJWKS`), served at the issuer's published path by a fake network. This
 * instance is the production `/api/auth` wiring (agent sign-in route, then BetterAuth), a real
 * SQL engine with the shipped `agent_sign_ins` migration, and real BetterAuth sessions. Forged
 * tokens are used only for shapes the real issuer cannot produce (expired, wrong alg, missing
 * claims). Every success asserts the session works on an authenticated route.
 */
import { SYSTEM_USER_ID } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import {
  calculateJwkThumbprint,
  decodeJwt,
  exportJWK,
  exportPKCS8,
  exportSPKI,
  generateKeyPair,
  importPKCS8,
  SignJWT,
} from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { handleAppError } from '../../src/middleware/app-error-handler';
import { adminRoutes } from '../../src/routes/admin';
import { agentSignInRoutes } from '../../src/routes/agent-sign-in';
import { apiTokenRoutes } from '../../src/routes/api-tokens';
import { authRoutes } from '../../src/routes/auth';
import { connectorConsentRoutes } from '../../src/routes/connector-oauth';
import { deviceFlowRoutes } from '../../src/routes/device-flow';
import { nodeLifecycleRoutes } from '../../src/routes/node-lifecycle';
import { nodesRoutes } from '../../src/routes/nodes';
import { notificationRoutes } from '../../src/routes/notifications';
import { projectScheduleRoutes } from '../../src/routes/project-schedules';
import { projectStandingWatchRoutes } from '../../src/routes/project-standing-watches';
import { projectsRoutes } from '../../src/routes/projects';
import { terminalRoutes } from '../../src/routes/terminal';
import { triggersRoutes } from '../../src/routes/triggers';
import { workspacesRoutes } from '../../src/routes/workspaces';
import {
  isAgentSignInEnabled,
  resolveAgentSignInTrust,
} from '../../src/services/agent-sign-in/config';
import { __resetAgentSignInKeyCacheForTest } from '../../src/services/agent-sign-in/verify';
import { __resetPlatformConfigCacheForTest } from '../../src/services/platform-config';
import { verifyPortAccessToken } from '../../src/services/jwt';
import { createSessionCookieForUser } from '../../src/services/session-factory';
import { assertTerminalTokenSessionLive } from '../../src/services/terminal-token-liveness';
import {
  getWorkloadJWKS,
  signWorkloadIdentityToken,
} from '../../src/services/workload-identity-token';
import {
  applySqliteMigration,
  createAllSchemaTables,
  createMemoryKv,
  createSchemaTables,
  createSqliteD1,
} from '../helpers/sqlite-d1';

const ISSUER_DOMAIN = 'trusted.example';
const ISSUER = `https://api.${ISSUER_DOMAIN}/oidc`;
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
const TARGET_DOMAIN = 'test.example';
const API_ORIGIN = `https://api.${TARGET_DOMAIN}`;
const ENDPOINT = `${API_ORIGIN}/api/auth/workload-identity-login`;
const AUDIENCE = ENDPOINT;

const SOURCE_PROJECT = 'proj-trusted';
const SOURCE_USER = 'user-trusted';
const TARGET_ID = 'smoke-user';
const TARGET_EMAIL = 'Smoke@Test.Example';
const ADMIN_ID = 'admin-user';

const CLAIMS = {
  project_id: SOURCE_PROJECT,
  user_id: SOURCE_USER,
  chat_session_id: 'chat-1',
  agent_session_id: 'runtime-1',
  workspace_id: 'ws-1',
  agent_profile_id: 'profile-1',
  task_id: 'task-1',
};

interface IssuerKeys {
  privatePem: string;
  publicPem: string;
}

async function makeKeys(): Promise<IssuerKeys> {
  const keys = await generateKeyPair('RS256', { extractable: true });
  return {
    privatePem: await exportPKCS8(keys.privateKey),
    publicPem: await exportSPKI(keys.publicKey),
  };
}

/** A SAM installation acting as the trusted issuer: its real signer over its own settings DB. */
function issuerInstance(keys: IssuerKeys, baseDomain = ISSUER_DOMAIN) {
  const sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.platformSettings, schema.platformCredentials]);
  const env = {
    BASE_DOMAIN: baseDomain,
    JWT_PRIVATE_KEY: keys.privatePem,
    JWT_PUBLIC_KEY: keys.publicPem,
    DATABASE: createSqliteD1(sqlite),
  } as Env;
  return {
    env,
    sign: (claims: typeof CLAIMS = CLAIMS, audience = AUDIENCE) =>
      signWorkloadIdentityToken(env, claims, audience),
    close: () => sqlite.close(),
  };
}

function trustJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    issuer: ISSUER,
    allowedSources: [{ projectId: SOURCE_PROJECT, userId: SOURCE_USER }],
    allowedTargets: [TARGET_ID],
    ...overrides,
  });
}

function buildApp() {
  // Mounted, in order, and with errors handled exactly as src/index.ts does.
  const app = new Hono<{ Bindings: Env }>();
  app.onError(handleAppError);
  app.route('/api/auth', apiTokenRoutes);
  app.route('/api/auth', agentSignInRoutes);
  app.route('/api/auth', deviceFlowRoutes);
  app.route('/api/auth', authRoutes);
  app.route('/api/connector/consent', connectorConsentRoutes);
  app.route('/api/projects/:projectId/triggers', triggersRoutes);
  app.route('/api/projects', projectsRoutes);
  app.route('/api/projects/:projectId/schedules', projectScheduleRoutes);
  app.route('/api/projects/:projectId/standing-watches', projectStandingWatchRoutes);
  app.route('/api/admin', adminRoutes);
  app.route('/api/workspaces', workspacesRoutes);
  app.route('/api/terminal', terminalRoutes);
  app.route('/api/nodes', nodesRoutes);
  app.route('/api/nodes', nodeLifecycleRoutes);
  app.route('/api/notifications', notificationRoutes);
  app.notFound((c) => c.json({ error: 'NOT_FOUND', message: 'Endpoint not found' }, 404));
  return app;
}

describe('agent sign-in through workload identity (vertical slice)', () => {
  let trustedKeys: IssuerKeys;
  let otherKeys: IssuerKeys;
  let issuer: ReturnType<typeof issuerInstance>;
  let sqlite: Database.Database;
  let env: Env;
  let jwksFetches: number;
  const app = buildApp();

  beforeAll(async () => {
    trustedKeys = await makeKeys();
    otherKeys = await makeKeys();
  });

  beforeEach(() => {
    issuer = issuerInstance(trustedKeys);
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    // The ledger's replay guard is the migration's UNIQUE(issuer, jti): use the shipped SQL...
    sqlite.exec('DROP TABLE agent_sign_ins');
    // ...and its sessions.hard_expires_at column, which the migration adds.
    sqlite.exec('ALTER TABLE sessions DROP COLUMN hard_expires_at');
    applySqliteMigration(
      sqlite,
      new URL('../../src/db/migrations/0234_agent_sign_ins.sql', import.meta.url)
    );
    const now = Date.now();
    const insertUser = sqlite.prepare(
      `INSERT INTO users (id, email, email_verified, name, role, status, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?)`
    );
    insertUser.run(ADMIN_ID, 'owner@test.example', 'Owner', 'superadmin', 'active', now, now);
    insertUser.run(TARGET_ID, TARGET_EMAIL, 'Smoke', 'user', 'active', now, now);
    insertUser.run('other-user', 'other@test.example', 'Other', 'user', 'active', now, now);
    insertUser.run('pending-user', 'pending@test.example', 'Pending', 'user', 'pending', now, now);
    insertUser.run(SYSTEM_USER_ID, 'system@internal', 'System', 'user', 'system', now, now);
    env = {
      DATABASE: createSqliteD1(sqlite),
      KV: createMemoryKv(),
      BASE_DOMAIN: TARGET_DOMAIN,
      ENCRYPTION_KEY: 'test-encryption-key',
      AGENT_SIGN_IN_TRUST: trustJson(),
    } as Env;
    __resetPlatformConfigCacheForTest();
    __resetAgentSignInKeyCacheForTest();
    jwksFetches = 0;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method === 'GET' && request.url === JWKS_URL) {
        jwksFetches += 1;
        return Response.json(await getWorkloadJWKS(issuer.env));
      }
      throw new Error(`Unexpected outbound request: ${request.method} ${request.url}`);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    issuer.close();
    sqlite.close();
  });

  function exchange(token: string, target: string = TARGET_ID, ip = '203.0.113.7') {
    return app.request(
      ENDPOINT,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
        body: JSON.stringify({ token, target }),
      },
      env
    );
  }

  function cookieFrom(response: Response): string {
    const setCookie = response.headers.get('set-cookie') ?? '';
    return setCookie.split(';', 1)[0] ?? '';
  }

  function me(cookie: string) {
    return app.request(`${API_ORIGIN}/api/auth/me`, { headers: { cookie } }, env);
  }

  function auditRows() {
    return sqlite.prepare('SELECT * FROM agent_sign_ins ORDER BY created_at').all() as Array<
      Record<string, unknown>
    >;
  }

  function sessionCount(): number {
    return (sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n;
  }

  /** A token in shapes the real issuer cannot mint, signed with the trusted key unless told. */
  async function forge(
    payload: Record<string, unknown>,
    options: { alg?: string; kid?: string | null; privatePem?: string } = {}
  ): Promise<string> {
    const { keys } = await getWorkloadJWKS(issuer.env);
    const kid = options.kid === undefined ? keys[0]?.kid : options.kid;
    const nowSeconds = Math.floor(Date.now() / 1000);
    return new SignJWT({
      ...CLAIMS,
      type: 'workload-identity',
      iss: ISSUER,
      sub: 'project:proj-trusted:user:user-trusted:profile:profile-1',
      aud: AUDIENCE,
      iat: nowSeconds,
      exp: nowSeconds + 300,
      jti: crypto.randomUUID(),
      ...payload,
    })
      .setProtectedHeader({ alg: options.alg ?? 'RS256', ...(kid ? { kid } : {}), typ: 'JWT' })
      .sign(await importPKCS8(options.privatePem ?? trustedKeys.privatePem, 'RS256'));
  }

  async function expectRejected(
    response: Response,
    status: number,
    message: string | RegExp
  ): Promise<void> {
    expect(response.status).toBe(status);
    expect(response.headers.get('set-cookie')).toBeNull();
    const body = (await response.json()) as { message: string };
    expect(body.message).toMatch(message);
    expect(auditRows()).toHaveLength(0);
    expect(sessionCount()).toBe(0);
  }

  describe('success', () => {
    it('signs the agent in as the allowed target with a short session and an audit record', async () => {
      expect(isAgentSignInEnabled(env)).toBe(true);
      const token = await issuer.sign();
      const response = await exchange(token);

      expect(response.status).toBe(200);
      const body = (await response.json()) as { user: { id: string }; sessionCookie: string };
      expect(body.user.id).toBe(TARGET_ID);
      const setCookie = response.headers.get('set-cookie') ?? '';
      expect(setCookie).toMatch(/Max-Age=3600/);
      expect(setCookie).toMatch(/HttpOnly/);
      expect(setCookie).toMatch(/Domain=\.test\.example/);

      const session = await me(cookieFrom(response));
      expect(session.status).toBe(200);
      expect(((await session.json()) as { id: string }).id).toBe(TARGET_ID);

      const [row, ...rest] = auditRows();
      expect(rest).toHaveLength(0);
      const sessionRow = sqlite
        .prepare('SELECT id, expires_at, hard_expires_at FROM sessions')
        .get() as { id: string; expires_at: number; hard_expires_at: number };
      expect(sessionRow.hard_expires_at).toBe(Number(auditRows()[0]?.session_expires_at));
      expect(row).toMatchObject({
        issuer: ISSUER,
        source_subject: 'project:proj-trusted:user:user-trusted:profile:profile-1',
        source_project_id: SOURCE_PROJECT,
        source_user_id: SOURCE_USER,
        source_agent_profile_id: 'profile-1',
        source_task_id: 'task-1',
        source_workspace_id: 'ws-1',
        target_user_id: TARGET_ID,
        session_id: sessionRow.id,
      });
      expect(typeof row?.jti).toBe('string');
      expect(Number(row?.session_expires_at) - Number(row?.created_at)).toBe(3600 * 1000);
      expect(sessionRow.expires_at).toBeLessThanOrEqual(Number(row?.session_expires_at));
      // No role changed: the target and the administrator are exactly as seeded.
      expect(
        sqlite
          .prepare('SELECT id, role, status FROM users WHERE id IN (?, ?) ORDER BY id')
          .all(ADMIN_ID, TARGET_ID)
      ).toEqual([
        { id: ADMIN_ID, role: 'superadmin', status: 'active' },
        { id: TARGET_ID, role: 'user', status: 'active' },
      ]);
    });

    it('matches an email target case-insensitively against the stored account', async () => {
      env.AGENT_SIGN_IN_TRUST = trustJson({ allowedTargets: ['smoke@test.example'] });
      const response = await exchange(await issuer.sign(), 'SMOKE@test.example');
      expect(response.status).toBe(200);
      expect(((await me(cookieFrom(response)).then((r) => r.json())) as { id: string }).id).toBe(
        TARGET_ID
      );
    });

    it('keeps the session to its hard expiry when BetterAuth refreshes it', async () => {
      env.AGENT_SIGN_IN_TRUST = trustJson({ sessionTtlSeconds: 120 });
      const response = await exchange(await issuer.sign());
      const cookie = cookieFrom(response);
      const cap = Number(auditRows()[0]?.session_expires_at);

      // A two-minute session is due for refresh at once; BetterAuth would extend it to 7 days.
      for (let i = 0; i < 3; i++) expect((await me(cookie)).status).toBe(200);
      const { expires_at } = sqlite.prepare('SELECT expires_at FROM sessions').get() as {
        expires_at: number;
      };
      expect(expires_at).toBeLessThanOrEqual(cap);

      // And once the cap passes the session is gone.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(cap + 1000);
      expect((await me(cookie)).status).toBe(401);
    });

    it('leaves ordinary sessions to refresh normally (control for the clamp)', async () => {
      const ordinary = await createSessionCookieForUser(env, 'other-user');
      // Age it so BetterAuth's refresh is due, exactly as for the agent session above.
      sqlite
        .prepare('UPDATE sessions SET expires_at = ? WHERE id = ?')
        .run(Date.now() + 120_000, ordinary.sessionId);
      expect((await me(ordinary.sessionCookie)).status).toBe(200);
      const { expires_at } = sqlite
        .prepare('SELECT expires_at FROM sessions WHERE id = ?')
        .get(ordinary.sessionId) as { expires_at: number };
      // Refreshed past its two-minute creation lifetime: proof the refresh ran and the clamp
      // only applies to agent sign-in sessions.
      expect(expires_at - Date.now()).toBeGreaterThan(24 * 60 * 60 * 1000);
    });
  });

  describe('what an agent session may not do', () => {
    async function agentCookie(): Promise<string> {
      const response = await exchange(await issuer.sign());
      expect(response.status).toBe(200);
      return cookieFrom(response);
    }

    async function ordinaryCookie(): Promise<string> {
      return (await createSessionCookieForUser(env, TARGET_ID)).sessionCookie;
    }

    function post(path: string, cookie: string, body: unknown = {}) {
      return app.request(
        `${API_ORIGIN}${path}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie,
            origin: `https://app.${TARGET_DOMAIN}`,
          },
          body: JSON.stringify(body),
        },
        env
      );
    }

    const REFUSED = /Agent sign-in sessions cannot create credentials/;

    it('cannot mint a personal access token (ordinary session can)', async () => {
      const refused = await post('/api/auth/api-tokens', await agentCookie(), { name: 'escape' });
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { message: string }).message).toMatch(REFUSED);
      expect(sqlite.prepare('SELECT COUNT(*) AS n FROM smoke_test_tokens').get()).toEqual({ n: 0 });

      const allowed = await post('/api/auth/api-tokens', await ordinaryCookie(), { name: 'ok' });
      expect(allowed.status).toBe(201);
    });

    it('cannot approve a device sign-in (ordinary session reaches the code check)', async () => {
      const refused = await post('/api/auth/device/approve', await agentCookie(), {
        userCode: 'ABCD-EFGH',
      });
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { message: string }).message).toMatch(REFUSED);

      const ordinary = await post('/api/auth/device/approve', await ordinaryCookie(), {
        userCode: 'ABCD-EFGH',
      });
      expect(ordinary.status).toBe(404);
    });

    it('cannot grant connector OAuth consent', async () => {
      const refused = await app.request(
        `${API_ORIGIN}/api/connector/consent`,
        { headers: { cookie: await agentCookie() } },
        env
      );
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { message: string }).message).toMatch(REFUSED);

      const ordinary = await app.request(
        `${API_ORIGIN}/api/connector/consent`,
        { headers: { cookie: await ordinaryCookie() } },
        env
      );
      expect(((await ordinary.json()) as { message?: string }).message ?? '').not.toMatch(REFUSED);
    });

    it('cannot change the account through BetterAuth, but can sign out', async () => {
      const cookie = await agentCookie();
      const link = await post('/api/auth/link-social', cookie, { provider: 'github' });
      expect(link.status).toBe(403);
      expect(((await link.json()) as { message: string }).message).toMatch(/can only sign out/);

      const ordinaryLink = await post('/api/auth/link-social', await ordinaryCookie(), {
        provider: 'github',
      });
      expect(
        ordinaryLink.status === 403 && /can only sign out/.test(await ordinaryLink.text())
      ).toBe(false);

      const signOut = await post('/api/auth/sign-out', cookie);
      expect(signOut.status).toBe(200);
      expect((await me(cookie)).status).toBe(401);
    });

    it('cannot grant lasting access: invites, access approvals, webhook credentials', async () => {
      const agent = await agentCookie();
      const ordinary = await ordinaryCookie();
      const cases: Array<[string, unknown, number]> = [
        // [path, body, status an ordinary session reaches past the guard: project not found]
        ['/api/projects/proj-x/invite-links', {}, 404],
        ['/api/projects/proj-x/access-requests/req-x/approve', {}, 404],
        [
          '/api/projects/proj-x/triggers',
          { name: 'w', sourceType: 'webhook', promptTemplate: 'p' },
          404,
        ],
        ['/api/projects/proj-x/triggers/trig-x/webhook/rotate', {}, 404],
      ];
      for (const [path, body, ordinaryStatus] of cases) {
        const refused = await post(path, agent, body);
        expect({ path, status: refused.status }).toEqual({ path, status: 403 });
        expect(((await refused.json()) as { message: string }).message).toMatch(REFUSED);
        const control = await post(path, ordinary, body);
        expect({ path, status: control.status }).toEqual({ path, status: ordinaryStatus });
      }
    });

    it('cannot approve accounts or change roles even as an administrator target', async () => {
      env.AGENT_SIGN_IN_TRUST = trustJson({ allowedTargets: [ADMIN_ID] });
      const response = await exchange(await issuer.sign(), ADMIN_ID);
      const agent = cookieFrom(response);
      const ordinary = (await createSessionCookieForUser(env, ADMIN_ID)).sessionCookie;
      const patch = (path: string, cookie: string, body: unknown) =>
        app.request(
          `${API_ORIGIN}${path}`,
          {
            method: path.endsWith('signup-approval') ? 'PUT' : 'PATCH',
            headers: { 'content-type': 'application/json', cookie },
            body: JSON.stringify(body),
          },
          env
        );
      const actions = [
        ['/api/admin/users/pending-user', { action: 'approve' }],
        ['/api/admin/users/pending-user/role', { role: 'admin' }],
        ['/api/admin/signup-approval', { requireApproval: false }],
      ] as const;
      for (const [path, body] of actions) {
        const refused = await patch(path, agent, body);
        expect({ path, status: refused.status }).toEqual({ path, status: 403 });
        expect(((await refused.json()) as { message: string }).message).toMatch(REFUSED);
      }
      const pendingStatus = () =>
        (
          sqlite.prepare('SELECT status FROM users WHERE id = ?').get('pending-user') as {
            status: string;
          }
        ).status;
      expect(pendingStatus()).toBe('pending');
      // Control: the same administrator with an ordinary session gets past the guard.
      for (const [path, body] of actions) {
        const control = await patch(path, ordinary, body);
        expect(((await control.json()) as { message?: string }).message ?? '').not.toMatch(REFUSED);
      }
      expect(pendingStatus()).toBe('active');
    });

    it('cannot list the account’s sessions through BetterAuth', async () => {
      const listed = await app.request(
        `${API_ORIGIN}/api/auth/list-sessions`,
        { headers: { cookie: await agentCookie() } },
        env
      );
      expect(listed.status).toBe(403);
      const control = await app.request(
        `${API_ORIGIN}/api/auth/list-sessions`,
        { headers: { cookie: await ordinaryCookie() } },
        env
      );
      expect(control.status).toBe(200);
    });

    it('cannot list sessions with a cookie written with whitespace before "="', async () => {
      // BetterAuth's cookie parser trims around "=", so this form authenticates. A guard that
      // looked for "better-auth.session_token=" in the header would miss it and let it through.
      const spaced = (await agentCookie()).replace('=', ' =');
      expect(spaced).toMatch(/session_token =/);
      expect((await me(spaced)).status).toBe(200);
      const listed = await app.request(
        `${API_ORIGIN}/api/auth/list-sessions`,
        { headers: { cookie: spaced } },
        env
      );
      expect(listed.status).toBe(403);
      // Control: an ordinary session in the same form still lists its sessions.
      const control = await app.request(
        `${API_ORIGIN}/api/auth/list-sessions`,
        { headers: { cookie: (await ordinaryCookie()).replace('=', ' =') } },
        env
      );
      expect(control.status).toBe(200);
    });

    it('cannot create a trigger of any source type (ordinary session reaches the project check)', async () => {
      const agent = await agentCookie();
      const ordinary = await ordinaryCookie();
      const bodies = [
        { name: 'c', sourceType: 'cron', cronExpression: '0 * * * *', promptTemplate: 'p' },
        {
          name: 'e',
          sourceType: 'email',
          promptTemplate: 'p',
          emailConfig: { allowedSenders: ['operator@outside.example'] },
        },
        { name: 'g', sourceType: 'github', promptTemplate: 'p' },
        { name: 'w', sourceType: 'webhook', promptTemplate: 'p' },
      ];
      for (const body of bodies) {
        const refused = await post('/api/projects/proj-x/triggers', agent, body);
        expect({ sourceType: body.sourceType, status: refused.status }).toEqual({
          sourceType: body.sourceType,
          status: 403,
        });
        expect(((await refused.json()) as { message: string }).message).toMatch(REFUSED);
        const control = await post('/api/projects/proj-x/triggers', ordinary, body);
        expect(((await control.json()) as { message?: string }).message ?? '').not.toMatch(REFUSED);
      }
    });

    it('may only pause or disable a trigger, never change what it does', async () => {
      const agent = await agentCookie();
      const ordinary = await ordinaryCookie();
      const patch = (cookie: string, body: unknown) =>
        app.request(
          `${API_ORIGIN}/api/projects/proj-x/triggers/trig-x`,
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json', cookie },
            body: JSON.stringify(body),
          },
          env
        );
      const refusedBodies = [
        { emailConfig: { allowedSenders: ['operator@outside.example'] } },
        { status: 'active' },
        { promptTemplate: 'new' },
        { cronExpression: '* * * * *' },
        { status: 'paused', promptTemplate: 'new' },
      ];
      for (const body of refusedBodies) {
        const refused = await patch(agent, body);
        expect({ body, status: refused.status }).toEqual({ body, status: 403 });
        // Control: an ordinary session gets past the guard to the project check.
        const control = await patch(ordinary, body);
        expect({ body, status: control.status }).toEqual({ body, status: 404 });
      }
      // Standing a trigger down is allowed: it reaches the project check, like an ordinary session.
      for (const status of ['paused', 'disabled']) {
        expect((await patch(agent, { status })).status).toBe(404);
      }
    });

    it('cannot arm schedules or standing watches, but can cancel, pause and revoke them', async () => {
      sqlite
        .prepare(`INSERT INTO projects (id, user_id, name) VALUES ('proj-own', ?, 'P')`)
        .run(TARGET_ID);
      sqlite
        .prepare(
          `INSERT INTO project_members (project_id, user_id, role, status, created_at, updated_at)
           VALUES ('proj-own', ?, 'owner', 'active', datetime('now'), datetime('now'))`
        )
        .run(TARGET_ID);
      const agent = await agentCookie();
      const ordinary = await ordinaryCookie();
      const refusedPaths = [
        '/api/projects/proj-own/schedules',
        '/api/projects/proj-own/schedules/sch-x/reschedule',
        '/api/projects/proj-own/schedules/sch-x/reconcile',
        '/api/projects/proj-own/standing-watches',
        '/api/projects/proj-own/standing-watches/w-x/update',
      ];
      for (const path of refusedPaths) {
        const refused = await post(path, agent, {});
        expect({ path, status: refused.status }).toEqual({ path, status: 403 });
        expect(((await refused.json()) as { message: string }).message).toMatch(REFUSED);
        const control = await post(path, ordinary, {});
        expect({ path, refused: REFUSED.test(await control.text()) }).toEqual({
          path,
          refused: false,
        });
      }
      for (const path of [
        '/api/projects/proj-own/schedules/sch-x/cancel',
        '/api/projects/proj-own/standing-watches/w-x/pause',
        '/api/projects/proj-own/standing-watches/w-x/revoke',
      ]) {
        const allowed = await post(path, agent, {});
        expect({ path, refused: REFUSED.test(await allowed.text()) }).toEqual({
          path,
          refused: false,
        });
      }
    });

    it('cannot add a push subscription or make workspace ports public', async () => {
      const agent = await agentCookie();
      const ordinary = await ordinaryCookie();
      const subscribe = await post('/api/notifications/push/subscriptions', agent, {
        endpoint: 'https://push.outside.example/x',
        keys: { p256dh: 'k', auth: 'a' },
      });
      expect(subscribe.status).toBe(403);
      const subscribeControl = await post('/api/notifications/push/subscriptions', ordinary, {});
      expect(subscribeControl.status).toBe(400); // past the guard, to body validation

      const ports = (cookie: string, enabled: boolean) =>
        app.request(
          `${API_ORIGIN}/api/workspaces/ws-x/ports-public`,
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json', cookie },
            body: JSON.stringify({ enabled }),
          },
          env
        );
      expect((await ports(agent, true)).status).toBe(403);
      expect((await ports(ordinary, true)).status).toBe(404); // control: reaches ownership check
      expect((await ports(agent, false)).status).toBe(404); // closing ports is allowed
    });

    it('is refused once past its hard expiry even if its expiry was extended', async () => {
      const cookie = await agentCookie();
      // Simulate a refresh that escaped the clamp: the row says 7 days, the cap has passed.
      sqlite
        .prepare('UPDATE sessions SET expires_at = ?, hard_expires_at = ?')
        .run(Date.now() + 7 * 86_400_000, Date.now() - 1000);
      expect((await me(cookie)).status).toBe(401);
      expect(
        (await app.request(`${API_ORIGIN}/api/auth/api-tokens`, { headers: { cookie } }, env))
          .status
      ).toBe(401);
    });
  });

  describe('credentials an agent session mints end with it', () => {
    const TTL_SECONDS = 60; // shorter than every token's own lifetime, so the cap is what decides

    beforeEach(() => {
      env.AGENT_SIGN_IN_TRUST = trustJson({ sessionTtlSeconds: TTL_SECONDS });
      // This instance's own signing keys (port, terminal, node and forward tokens).
      env.JWT_PRIVATE_KEY = otherKeys.privatePem;
      env.JWT_PUBLIC_KEY = otherKeys.publicPem;
      sqlite
        .prepare(`INSERT INTO nodes (id, user_id, status) VALUES ('node-1', ?, 'running')`)
        .run(TARGET_ID);
      sqlite
        .prepare(
          `INSERT INTO workspaces (id, user_id, node_id, status) VALUES ('ws-1', ?, 'node-1', 'running')`
        )
        .run(TARGET_ID);
    });

    async function agentSession(): Promise<{ cookie: string; capSeconds: number }> {
      const response = await exchange(await issuer.sign());
      expect(response.status).toBe(200);
      const cap = (
        sqlite.prepare('SELECT hard_expires_at AS cap FROM sessions').get() as { cap: number }
      ).cap;
      return { cookie: cookieFrom(response), capSeconds: Math.floor(cap / 1000) };
    }

    function call(method: string, path: string, cookie: string, body?: unknown) {
      return app.request(
        `${API_ORIGIN}${path}`,
        {
          method,
          headers: {
            cookie,
            accept: 'application/json',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        env
      );
    }

    /** Every session route that hands the caller a token, and how to read the token. */
    const MINTERS: Array<[string, (cookie: string) => Promise<string>]> = [
      [
        'port access',
        async (cookie) =>
          (
            (await (
              await call('GET', '/api/workspaces/ws-1/port-access?port=3000', cookie)
            ).json()) as {
              token: string;
            }
          ).token,
      ],
      [
        'terminal',
        async (cookie) =>
          (
            (await (
              await call('POST', '/api/terminal/token', cookie, { workspaceId: 'ws-1' })
            ).json()) as {
              token: string;
            }
          ).token,
      ],
      [
        'node management',
        async (cookie) =>
          (
            (await (await call('POST', '/api/nodes/node-1/token', cookie)).json()) as {
              token: string;
            }
          ).token,
      ],
      [
        'local forward',
        async (cookie) =>
          (
            (await (
              await call('POST', '/api/workspaces/ws-1/forwards', cookie, {
                remotePort: 3000,
                localAuthority: 'localhost:3000',
              })
            ).json()) as { token: string }
          ).token,
      ],
    ];

    it('caps every token at the session hard expiry (ordinary sessions keep the full lifetime)', async () => {
      const { cookie, capSeconds } = await agentSession();
      const ordinary = await ordinaryCookie();
      for (const [name, mint] of MINTERS) {
        const capped = decodeJwt(await mint(cookie));
        expect({ name, exp: capped.exp }).toEqual({ name, exp: capSeconds });
        // Control: the same route for an ordinary session issues a token past the cap.
        const full = decodeJwt(await mint(ordinary));
        expect({ name, past: (full.exp ?? 0) > capSeconds }).toEqual({ name, past: true });
        expect(full.sessionNotAfter).toBeUndefined();
      }
    });

    it('tells the VM agent to end the session it builds from a terminal token at the cap', async () => {
      const { cookie, capSeconds } = await agentSession();
      const terminal = decodeJwt(await MINTERS[1]![1](cookie));
      expect(terminal.sessionNotAfter).toBe(capSeconds);
    });

    it('refuses a port-access token after the session has expired', async () => {
      const { cookie, capSeconds } = await agentSession();
      const agentToken = await MINTERS[0]![1](cookie);
      const ordinaryToken = await MINTERS[0]![1](await ordinaryCookie());
      await expect(verifyPortAccessToken(agentToken, env)).resolves.toMatchObject({
        workspace: 'ws-1',
      });
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime((capSeconds + 1) * 1000);
      await expect(verifyPortAccessToken(agentToken, env)).rejects.toThrow();
      // Control: an ordinary session's link is still good at the same moment.
      await expect(verifyPortAccessToken(ordinaryToken, env)).resolves.toMatchObject({
        workspace: 'ws-1',
      });
    });

    it('refuses a terminal token once the session is past its hard expiry, even if extended', async () => {
      const { cookie } = await agentSession();
      const payload = decodeJwt(await MINTERS[1]![1](cookie));
      const terminal = {
        workspace: 'ws-1',
        subject: TARGET_ID,
        sessionToken: payload.sessionToken as string,
      };
      await expect(assertTerminalTokenSessionLive(env, terminal)).resolves.toBeUndefined();
      // A refresh that escaped the clamp: expires_at says 7 days, the hard cap has passed.
      sqlite
        .prepare(
          'UPDATE sessions SET expires_at = ?, hard_expires_at = ? WHERE hard_expires_at IS NOT NULL'
        )
        .run(Date.now() + 7 * 86_400_000, Date.now() - 1000);
      await expect(assertTerminalTokenSessionLive(env, terminal)).rejects.toThrow(/expired/);
    });

    it('the documented revocation ends every agent session and leaves ordinary sessions alone', async () => {
      const { cookie } = await agentSession();
      const payload = decodeJwt(await MINTERS[1]![1](cookie));
      const ordinary = await ordinaryCookie();
      expect((await me(cookie)).status).toBe(200);

      // Exactly the statement in docs/guides/agent-sign-in.md (incident response).
      sqlite.exec('DELETE FROM sessions WHERE hard_expires_at IS NOT NULL');

      expect((await me(cookie)).status).toBe(401);
      await expect(
        assertTerminalTokenSessionLive(env, {
          workspace: 'ws-1',
          subject: TARGET_ID,
          sessionToken: payload.sessionToken as string,
        })
      ).rejects.toThrow(/not live/);
      expect((await me(ordinary)).status).toBe(200);
      // The audit record survives revocation.
      expect(auditRows()).toHaveLength(1);
    });

    async function ordinaryCookie(): Promise<string> {
      return (await createSessionCookieForUser(env, TARGET_ID)).sessionCookie;
    }
  });

  describe('agent profile pin', () => {
    it('accepts only the pinned profile when a source names one', async () => {
      env.AGENT_SIGN_IN_TRUST = trustJson({
        allowedSources: [
          { projectId: SOURCE_PROJECT, userId: SOURCE_USER, agentProfileId: 'profile-1' },
        ],
      });
      expect((await exchange(await issuer.sign())).status).toBe(200);
      await (async () => {
        const response = await exchange(
          await issuer.sign({ ...CLAIMS, agent_profile_id: 'profile-2' })
        );
        expect(response.status).toBe(403);
        expect(((await response.json()) as { message: string }).message).toMatch(
          /not allowed to sign in/
        );
      })();
    });
  });

  describe('feature off', () => {
    async function unknownRouteResponse() {
      const response = await app.request(
        `${API_ORIGIN}/api/auth/no-such-endpoint`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
        env
      );
      return { status: response.status, body: await response.text() };
    }

    it.each([
      ['absent', undefined],
      ['empty', '   '],
      ['not JSON', '{issuer:'],
      ['http issuer', trustJson({ issuer: 'http://api.trusted.example/oidc' })],
      ['issuer with trailing slash', trustJson({ issuer: `${ISSUER}/` })],
      ['no sources', trustJson({ allowedSources: [] })],
      ['source without user', trustJson({ allowedSources: [{ projectId: SOURCE_PROJECT }] })],
      ['no targets', trustJson({ allowedTargets: [] })],
      ['wildcard inside a list', trustJson({ allowedTargets: ['*'] })],
      ['unknown key', trustJson({ allowedTarget: [TARGET_ID] })],
      ['session lifetime out of range', trustJson({ sessionTtlSeconds: 10 * 86_400 })],
    ])('behaves as if the endpoint did not exist when configuration is %s', async (_label, raw) => {
      env.AGENT_SIGN_IN_TRUST = raw;
      expect(resolveAgentSignInTrust(env)).toBeNull();
      // The flag the sign-in page shows (GET /api/config/login-providers) is off too.
      expect(isAgentSignInEnabled(env)).toBe(false);
      const token = await issuer.sign();
      const unknown = await unknownRouteResponse();
      const response = await exchange(token);
      expect({ status: response.status, body: await response.text() }).toEqual(unknown);
      expect(response.status).toBe(404);
      expect(jwksFetches).toBe(0);
      expect(auditRows()).toHaveLength(0);
      expect(sessionCount()).toBe(0);
    });
  });

  describe('token verification', () => {
    it('rejects a token from a different issuer signed with the same key', async () => {
      const elsewhere = issuerInstance(trustedKeys, 'elsewhere.example');
      try {
        await expectRejected(await exchange(await elsewhere.sign()), 401, /\(issuer\)/);
      } finally {
        elsewhere.close();
      }
    });

    it('rejects a token for another audience', async () => {
      const token = await issuer.sign(
        CLAIMS,
        'https://api.other.example/api/auth/workload-identity-login'
      );
      await expectRejected(await exchange(token), 401, /\(audience\)/);
    });

    it('rejects an expired token', async () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const token = await forge({ iat: nowSeconds - 400, exp: nowSeconds - 100 });
      await expectRejected(await exchange(token), 401, /\(expired\)/);
    });

    it('rejects a token whose lifetime exceeds any SAM issuer’s maximum', async () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const token = await forge({ iat: nowSeconds - 5, exp: nowSeconds + 3600 });
      await expectRejected(await exchange(token), 401, /\(too_old\)/);
    });

    it('rejects HS256 signed with the issuer public key, without fetching keys', async () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const { keys } = await getWorkloadJWKS(issuer.env);
      const token = await new SignJWT({ ...CLAIMS, type: 'workload-identity' })
        .setProtectedHeader({ alg: 'HS256', kid: keys[0]?.kid ?? '' })
        .setIssuer(ISSUER)
        .setSubject('s')
        .setAudience(AUDIENCE)
        .setIssuedAt(nowSeconds)
        .setExpirationTime(nowSeconds + 300)
        .setJti(crypto.randomUUID())
        .sign(new TextEncoder().encode(trustedKeys.publicPem));
      await expectRejected(await exchange(token), 401, /\(algorithm\)/);
      expect(jwksFetches).toBe(0);
    });

    it('rejects alg none', async () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const token = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
        ...CLAIMS,
        type: 'workload-identity',
        iss: ISSUER,
        sub: 's',
        aud: AUDIENCE,
        iat: nowSeconds,
        exp: nowSeconds + 300,
        jti: crypto.randomUUID(),
      })}.`;
      await expectRejected(await exchange(token), 401, /\(algorithm\)/);
    });

    it('rejects a key ID the issuer does not publish', async () => {
      const otherJwk = await exportJWK(
        (await generateKeyPair('RS256', { extractable: true })).publicKey
      );
      const token = await forge(
        {},
        { kid: await calculateJwkThumbprint(otherJwk), privatePem: otherKeys.privatePem }
      );
      await expectRejected(await exchange(token), 401, /\(unknown_key\)/);
    });

    it('rejects a token signed by another key under the published key ID', async () => {
      const token = await forge({}, { privatePem: otherKeys.privatePem });
      await expectRejected(await exchange(token), 401, /\(signature\)/);
    });

    it('rejects a token with the wrong type', async () => {
      await expectRejected(await exchange(await forge({ type: 'session' })), 401, /\(claims\)/);
    });

    it.each(['project_id', 'user_id', 'jti', 'sub', 'iss', 'aud', 'exp', 'iat'])(
      'rejects a token missing %s',
      async (claim) => {
        const nowSeconds = Math.floor(Date.now() / 1000);
        const { keys } = await getWorkloadJWKS(issuer.env);
        const payload: Record<string, unknown> = {
          ...CLAIMS,
          type: 'workload-identity',
          iss: ISSUER,
          sub: 's',
          aud: AUDIENCE,
          iat: nowSeconds,
          exp: nowSeconds + 300,
          jti: crypto.randomUUID(),
        };
        delete payload[claim];
        const token = await new SignJWT(payload)
          .setProtectedHeader({ alg: 'RS256', kid: keys[0]?.kid ?? '' })
          .sign(await importPKCS8(trustedKeys.privatePem, 'RS256'));
        await expectRejected(await exchange(token), 401, /\((claims|issuer|audience)\)/);
      }
    );

    it('caches the issuer keys across exchanges', async () => {
      env.AGENT_SIGN_IN_TRUST = trustJson({ allowedTargets: '*' });
      expect((await exchange(await issuer.sign())).status).toBe(200);
      expect((await exchange(await issuer.sign(), 'other-user')).status).toBe(200);
      expect(jwksFetches).toBe(1);
    });
  });

  describe('trust allowlists', () => {
    it('rejects a source project that is not allowed, even for an allowed user', async () => {
      const token = await issuer.sign({ ...CLAIMS, project_id: 'proj-other' });
      await expectRejected(await exchange(token), 403, /not allowed to sign in/);
    });

    it('rejects a source user that is not allowed, even in an allowed project', async () => {
      const token = await issuer.sign({ ...CLAIMS, user_id: 'user-other' });
      await expectRejected(await exchange(token), 403, /not allowed to sign in/);
    });

    it('requires the allowed project and user together, not separately', async () => {
      env.AGENT_SIGN_IN_TRUST = trustJson({
        allowedSources: [
          { projectId: SOURCE_PROJECT, userId: 'user-other' },
          { projectId: 'proj-other', userId: SOURCE_USER },
        ],
      });
      await expectRejected(await exchange(await issuer.sign()), 403, /not allowed to sign in/);
    });

    it('rejects a target that is not allowed, and a missing one, identically', async () => {
      await expectRejected(await exchange(await issuer.sign(), 'other-user'), 403, /Target user/);
      await expectRejected(await exchange(await issuer.sign(), 'nobody'), 403, /Target user/);
    });

    it('allows any user only with the explicit wildcard', async () => {
      await expectRejected(await exchange(await issuer.sign(), 'other-user'), 403, /Target user/);
      env.AGENT_SIGN_IN_TRUST = trustJson({ allowedTargets: '*' });
      const response = await exchange(await issuer.sign(), 'other-user');
      expect(response.status).toBe(200);
      expect(((await me(cookieFrom(response)).then((r) => r.json())) as { id: string }).id).toBe(
        'other-user'
      );
    });

    it('never signs in as the system sentinel, even with the wildcard', async () => {
      env.AGENT_SIGN_IN_TRUST = trustJson({ allowedTargets: '*' });
      await expectRejected(await exchange(await issuer.sign(), SYSTEM_USER_ID), 403, /Target user/);
    });
  });

  describe('target account checks', () => {
    it('refuses a target pending approval, like any other sign-in', async () => {
      env.REQUIRE_APPROVAL = 'true';
      env.AGENT_SIGN_IN_TRUST = trustJson({ allowedTargets: ['pending-user'] });
      await expectRejected(
        await exchange(await issuer.sign(), 'pending-user'),
        403,
        /pending admin approval/
      );
    });

    it('refuses a suspended target', async () => {
      sqlite.prepare(`UPDATE users SET status = 'suspended' WHERE id = ?`).run(TARGET_ID);
      await expectRejected(await exchange(await issuer.sign()), 403, /suspended/);
    });

    it('refuses while the instance has no administrator, so no role can change', async () => {
      // The target is left as the only real user and nobody is superadmin: exactly the state in
      // which LOGIN_SELF_HEAL_SQL would promote whoever signs in.
      sqlite
        .prepare(`DELETE FROM users WHERE id IN (?, 'other-user', 'pending-user')`)
        .run(ADMIN_ID);
      await expectRejected(await exchange(await issuer.sign()), 403, /until this instance/);
      // The self-heal hook would have promoted the sole remaining real user.
      expect(
        (sqlite.prepare('SELECT role FROM users WHERE id = ?').get(TARGET_ID) as { role: string })
          .role
      ).toBe('user');
    });
  });

  describe('per-IP attempt bound', () => {
    it('limits exchange attempts per client IP before verifying the token', async () => {
      env.AGENT_SIGN_IN_TRUST = trustJson({ maxAttemptsPerIpPerHour: 2 });
      await expectRejected(
        await exchange('not-a-jwt', TARGET_ID, '198.51.100.1'),
        401,
        /malformed/
      );
      await expectRejected(
        await exchange('not-a-jwt', TARGET_ID, '198.51.100.1'),
        401,
        /malformed/
      );
      // Third attempt from the same address is refused even with a valid token.
      await expectRejected(
        await exchange(await issuer.sign(), TARGET_ID, '198.51.100.1'),
        429,
        /Too many requests/
      );
      // Another address is unaffected (control).
      expect((await exchange(await issuer.sign(), TARGET_ID, '198.51.100.2')).status).toBe(200);
    });
  });

  describe('replay and rate limit', () => {
    it('accepts a token once', async () => {
      const token = await issuer.sign();
      expect((await exchange(token)).status).toBe(200);
      const replay = await exchange(token);
      expect(replay.status).toBe(401);
      expect(((await replay.json()) as { message: string }).message).toMatch(/\(replayed\)/);
      expect(auditRows()).toHaveLength(1);
      expect(sessionCount()).toBe(1);
    });

    it('accepts concurrent uses of one token exactly once', async () => {
      const token = await issuer.sign();
      const responses = await Promise.all([exchange(token), exchange(token), exchange(token)]);
      expect(responses.map((r) => r.status).sort()).toEqual([200, 401, 401]);
      expect(auditRows()).toHaveLength(1);
      expect(sessionCount()).toBe(1);
    });

    it('limits sign-ins per source principal and releases the budget after the window', async () => {
      env.AGENT_SIGN_IN_TRUST = trustJson({ maxSignInsPerHour: 2 });
      vi.useFakeTimers({ toFake: ['Date'] });
      const start = Date.now();
      expect((await exchange(await issuer.sign())).status).toBe(200);
      expect((await exchange(await issuer.sign())).status).toBe(200);
      const limited = await exchange(await issuer.sign());
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get('retry-after') ?? '0')).toBeGreaterThan(0);
      expect(auditRows()).toHaveLength(2);

      // Another principal is unaffected by this one's budget.
      env.AGENT_SIGN_IN_TRUST = trustJson({
        maxSignInsPerHour: 2,
        allowedSources: [
          { projectId: SOURCE_PROJECT, userId: SOURCE_USER },
          { projectId: SOURCE_PROJECT, userId: 'user-two' },
        ],
      });
      expect((await exchange(await issuer.sign({ ...CLAIMS, user_id: 'user-two' }))).status).toBe(
        200
      );

      vi.setSystemTime(start + 60 * 60 * 1000 + 1000);
      expect((await exchange(await issuer.sign())).status).toBe(200);
    });
  });
});
