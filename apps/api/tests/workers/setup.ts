import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, inject } from 'vitest';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, inject('databaseMigrations'));
  await applyD1Migrations(env.OBSERVABILITY_DATABASE, inject('observabilityMigrations'));
});

declare module 'vitest' {
  export interface ProvidedContext {
    databaseMigrations: D1Migration[];
    observabilityMigrations: D1Migration[];
  }
}
