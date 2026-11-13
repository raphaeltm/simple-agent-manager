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
  // Tests that call ProjectData or repo-hosting modules directly (not through the Durable Object
  // or the entry) need the worker's ports even before the entry module, which also configures
  // them, is evaluated.
  const [{ configureProjectDataPorts }, { workerProjectDataPorts }] = await Promise.all([
    import('@simple-agent-manager/project-data/internal/do/ports'),
    import('../../src/project-data-ports/index'),
    import('../../src/repo-hosting-wiring'),
  ]);
  configureProjectDataPorts(workerProjectDataPorts);
  await applyD1Migrations(env.DATABASE, injectedMigrations('D1_MIGRATIONS_JSON'));
  await applyD1Migrations(
    env.OBSERVABILITY_DATABASE,
    injectedMigrations('OBSERVABILITY_D1_MIGRATIONS_JSON')
  );
});
