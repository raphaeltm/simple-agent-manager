import { readFileSync } from 'node:fs';

import Database from 'better-sqlite3';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { generateEncryptionKey } from '../../src/services/encryption';
import { createMemoryKv, createSchemaTables, createSqliteD1 } from './sqlite-d1';

/** Existing settings schema plus the actual additive Phase 1 migration. */
export function createAdminSettingsEnv(overrides: Partial<Env> = {}) {
  const sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.platformSettings, schema.platformCredentials]);
  sqlite.exec(
    readFileSync(
      new URL('../../src/db/migrations/0196_admin_settings.sql', import.meta.url),
      'utf8'
    )
  );
  const env = {
    DATABASE: createSqliteD1(sqlite),
    KV: createMemoryKv(),
    ENCRYPTION_KEY: generateEncryptionKey(),
    ...overrides,
  } as Env;
  return { sqlite, env };
}
