import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, beforeEach, inject } from 'vitest';

async function clearDatabase(db: D1Database): Promise<void> {
  const { results } = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\_cf\_%' ESCAPE '\\' AND name != 'd1_migrations'"
    )
    .all<{ name: string }>();
  if (results.length === 0) return;

  await db.batch([
    db.prepare('PRAGMA defer_foreign_keys = ON'),
    ...results.map(({ name }) => db.prepare(`DELETE FROM "${name.replaceAll('"', '""')}"`)),
  ]);
}

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, inject('databaseMigrations'));
  await applyD1Migrations(env.OBSERVABILITY_DATABASE, inject('observabilityMigrations'));
});

beforeEach(async () => {
  await clearDatabase(env.DATABASE);
  await clearDatabase(env.OBSERVABILITY_DATABASE);
});

declare module 'vitest' {
  export interface ProvidedContext {
    databaseMigrations: D1Migration[];
    observabilityMigrations: D1Migration[];
  }
}
