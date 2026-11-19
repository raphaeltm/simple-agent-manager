import type Database from 'better-sqlite3';
import { getTableConfig } from 'drizzle-orm/sqlite-core';

import * as schema from '../../src/db/schema';
import { applySqliteMigration, createSchemaTables } from './sqlite-d1';

/**
 * Give a hand-built fixture what GCP workload identity pool ownership reads
 * (`gcp-wif-pool-ownership.ts`): the real migration 0262, plus any table it or the ownership check
 * depends on that the fixture did not create. Tables the fixture already made are left alone.
 */
export function applyGcpWifPoolOwnershipMigration(sqlite: Database.Database): void {
  const existing = new Set(
    (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
      name: string;
    }>).map((row) => row.name)
  );
  const prerequisites = [
    schema.credentials,
    schema.platformCredentials,
    schema.ccCredentials,
    schema.ccConfigurations,
    schema.projectDeploymentCredentials,
    schema.platformSettings,
  ].filter((table) => !existing.has(getTableConfig(table).name));
  createSchemaTables(sqlite, prerequisites);
  applySqliteMigration(
    sqlite,
    new URL('../../src/db/migrations/0262_gcp_wif_pool_index.sql', import.meta.url)
  );
}

