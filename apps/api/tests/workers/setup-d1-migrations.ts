import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, inject } from 'vitest';

interface D1Migration {
  name: string;
  queries: string[];
}

function injectedMigrations(key: string): D1Migration[] {
  return JSON.parse(inject<string>(key)) as D1Migration[];
}

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, injectedMigrations('D1_MIGRATIONS_JSON'));
  await applyD1Migrations(
    env.OBSERVABILITY_DATABASE,
    injectedMigrations('OBSERVABILITY_D1_MIGRATIONS_JSON')
  );
});
