import { abortAllDurableObjects, applyD1Migrations, env, reset } from 'cloudflare:test';
import { beforeEach, inject } from 'vitest';

beforeEach(async () => {
  await reset();
  await abortAllDurableObjects();
  await applyD1Migrations(env.DATABASE, inject('databaseMigrations'));
  await applyD1Migrations(env.OBSERVABILITY_DATABASE, inject('observabilityMigrations'));
});

declare module 'vitest' {
  export interface ProvidedContext {
    databaseMigrations: D1Migration[];
    observabilityMigrations: D1Migration[];
  }
}
