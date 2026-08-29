import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type SqliteMigrationTarget = {
  exec(sql: string): unknown;
};

function readDbMigration(filename: string): string {
  return readFileSync(join(process.cwd(), 'src/db/migrations', filename), 'utf8');
}

export const migrationSql = readDbMigration('0125_compute_pool_foundation.sql');
export const candidateSnapshotMigrationSql = readDbMigration(
  '0126_capacity_pool_candidate_snapshots.sql'
);
export const concreteOfferingMigrationSql = readDbMigration(
  '0127_concrete_capacity_pool_offerings.sql'
);
export const candidateCatalogMetadataMigrationSql = readDbMigration(
  '0128_capacity_pool_candidate_catalog_metadata.sql'
);
export const capacitySourceExternalCredentialsMigrationSql = readDbMigration(
  '0129_capacity_source_external_credentials.sql'
);

export function applyCapacityPoolSchemaMigrations(database: SqliteMigrationTarget): void {
  database.exec(migrationSql);
  database.exec(candidateSnapshotMigrationSql);
  database.exec(concreteOfferingMigrationSql);
  database.exec(candidateCatalogMetadataMigrationSql);
  database.exec(capacitySourceExternalCredentialsMigrationSql);
}
