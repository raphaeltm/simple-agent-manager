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
import {
  calculateJwkThumbprint,
  exportJWK,
  exportPKCS8,
  exportSPKI,
  generateKeyPair,
  importPKCS8,
  SignJWT,
} from 'jose';
import { Hono } from 'hono';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { handleAppError } from '../../src/middleware/app-error-handler';
import { agentSignInRoutes } from '../../src/routes/agent-sign-in';
import { authRoutes } from '../../src/routes/auth';
import { resolveAgentSignInTrust } from '../../src/services/agent-sign-in/config';
import { __resetAgentSignInKeyCacheForTest } from '../../src/services/agent-sign-in/verify';
import { __resetPlatformConfigCacheForTest } from '../../src/services/platform-config';
import { createSessionCookieForUser } from '../../src/services/session-factory';
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
  app.route('/api/auth', agentSignInRoutes);
  app.route('/api/auth', authRoutes);
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
    // The ledger's replay guard is the migration's UNIQUE(issuer, jti): use the shipped SQL.
    sqlite.exec('DROP TABLE agent_sign_ins');
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
      const sessionRow = sqlite.prepare('SELECT id, expires_at FROM sessions').get() as {
        id: string;
        expires_at: number;
      };
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
      const ordinary = await createSessionCookieForUser(env, 'other-user', { ttlSeconds: 120 });
      expect((await me(ordinary.sessionCookie)).status).toBe(200);
      const { expires_at } = sqlite
        .prepare('SELECT expires_at FROM sessions WHERE id = ?')
        .get(ordinary.sessionId) as { expires_at: number };
      // Refreshed past its two-minute creation lifetime: proof the refresh ran and the clamp
      // only applies to agent sign-in sessions.
      expect(expires_at - Date.now()).toBeGreaterThan(24 * 60 * 60 * 1000);
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

    it.each(['project_id', 'user_id', 'jti'])('rejects a token missing %s', async (claim) => {
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
      await expectRejected(await exchange(token), 401, /\(claims\)/);
    });

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
