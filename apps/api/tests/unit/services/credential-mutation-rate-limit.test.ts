import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { RateLimitError } from '../../../src/middleware/rate-limit';
import { enforceCredentialMutationRateLimit } from '../../../src/services/credential-mutation-rate-limit';

function createD1(sqlite: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      let bindings: unknown[] = [];
      return {
        bind(...values: unknown[]) {
          bindings = values;
          return this;
        },
        async run() {
          const result = statement.run(...bindings);
          return { meta: { changes: result.changes } };
        },
      };
    },
  } as unknown as D1Database;
}

function createEnv(): Env {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE platform_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT
    );
  `);
  return {
    DATABASE: createD1(sqlite),
    RATE_LIMIT_CREDENTIAL_UPDATE: '2',
  } as Env;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('enforceCredentialMutationRateLimit', () => {
  it('rejects at the configured limit and resets after the window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-16T00:00:00Z'));
    const env = createEnv();

    await enforceCredentialMutationRateLimit(env, 'user-1', 'gcp-service-account');
    await enforceCredentialMutationRateLimit(env, 'user-1', 'gcp-service-account');
    await expect(enforceCredentialMutationRateLimit(env, 'user-1', 'gcp-service-account'))
      .rejects.toBeInstanceOf(RateLimitError);

    vi.setSystemTime(new Date('2026-07-16T01:00:01Z'));
    await expect(enforceCredentialMutationRateLimit(env, 'user-1', 'gcp-service-account'))
      .resolves.toBeUndefined();
  });

  it('isolates principals and mutation scopes', async () => {
    const env = createEnv();
    await enforceCredentialMutationRateLimit(env, 'user-1', 'gcp-service-account');
    await enforceCredentialMutationRateLimit(env, 'user-1', 'gcp-service-account');

    await expect(enforceCredentialMutationRateLimit(env, 'user-2', 'gcp-service-account'))
      .resolves.toBeUndefined();
    await expect(enforceCredentialMutationRateLimit(env, 'user-1', 'google-infra-oauth'))
      .resolves.toBeUndefined();
  });
});
