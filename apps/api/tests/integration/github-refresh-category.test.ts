/** Preserve provider failures across the real BetterAuth getAccessToken wrapper. */
import { symmetricEncrypt } from 'better-auth/crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { getBetterAuthSecret } from '../../src/lib/secrets';
import { getBetterAuthAccessTokenForProvider } from '../../src/services/better-auth-access-token';
import { getGitHubUserAccessTokenForOwner } from '../../src/services/github-user-access-token';
import { __resetPlatformConfigCacheForTest } from '../../src/services/platform-config';
import { createAllSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';

describe('GitHub refresh recovery category through BetterAuth', () => {
  let sqlite: Database.Database;
  let env: Env;
  beforeEach(async () => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    const database = createSqliteD1(sqlite);
    // Production D1 permits numbered binds used by the canonical account-owner resolver.
    env = {
      DATABASE: new Proxy(database, {
        get(target, key) {
          if (key !== 'prepare') return Reflect.get(target, key);
          return (sql: string) => {
            const order = [...sql.matchAll(/\?(\d+)/g)].map((match) => Number(match[1]));
            if (!order.length) return database.prepare(sql);
            const statement = database.prepare(sql.replace(/\?\d+/g, '?'));
            return {
              ...statement,
              bind: (...params: unknown[]) => statement.bind(...order.map((n) => params[n - 1])),
            };
          };
        },
      }),
      BASE_DOMAIN: 'example.com',
      ENCRYPTION_KEY: 'test-encryption-key',
      GITHUB_CLIENT_ID: 'Iv1.refresh-test',
      GITHUB_CLIENT_SECRET: 'refresh-test-secret',
    } as Env;
    __resetPlatformConfigCacheForTest();
    sqlite
      .prepare(
        `INSERT INTO users (id, email, email_verified, name, role, status, created_at, updated_at)
      VALUES ('owner', 'owner@example.com', 1, 'Owner', 'user', 'active', 1, 1)`
      )
      .run();
    const secret = getBetterAuthSecret(env);
    const access = await symmetricEncrypt({ key: secret, data: 'expired-access' });
    const refresh = await symmetricEncrypt({ key: secret, data: 'refresh-fixture' });
    sqlite
      .prepare(
        `INSERT INTO accounts (id, account_id, provider_id, user_id, access_token, refresh_token,
      access_token_expires_at, refresh_token_expires_at, scope, created_at, updated_at)
      VALUES ('link', '777', 'github', 'owner', ?, ?, ?, ?, 'read:user', 1, 1)`
      )
      .run(access, refresh, Date.now() - 60000, Date.now() + 3600000);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    sqlite.close();
  });

  it.each([
    {
      status: 503,
      body: { message: 'Service Unavailable' },
      code: 'GITHUB_UNAVAILABLE',
      expected: 503,
    },
    {
      status: 200,
      body: { error: 'invalid_grant', error_description: 'Refresh token revoked' },
      code: 'GITHUB_REAUTH_REQUIRED',
      expected: 401,
    },
  ])(
    'preserves $code and its recovery at the owner token sink',
    async ({ status, body, code, expected }) => {
      const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        expect(request.url).toBe('https://github.com/login/oauth/access_token');
        const form = new URLSearchParams(await request.text());
        expect(form.get('grant_type')).toBe('refresh_token');
        expect(form.get('refresh_token')).toBe('refresh-fixture');
        return Response.json(body, { status });
      });
      vi.stubGlobal('fetch', fetch);
      await expect(
        getBetterAuthAccessTokenForProvider(env, undefined, 'owner', 'github')
      ).rejects.toMatchObject({ statusCode: expected, error: code });
      if (expected === 503) {
        await expect(getGitHubUserAccessTokenForOwner(env, 'owner')).rejects.toMatchObject({
          statusCode: 503,
          error: code,
        });
      } else {
        await expect(getGitHubUserAccessTokenForOwner(env, 'owner')).resolves.toBeNull();
      }
      expect(fetch).toHaveBeenCalledTimes(2);
      expect((sqlite.prepare('SELECT count(*) AS n FROM accounts').get() as { n: number }).n).toBe(
        1
      );
    }
  );
});
