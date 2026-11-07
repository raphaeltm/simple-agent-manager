/**
 * The session list names each session's creator. With `include=live` a list can carry up to
 * three times the page limit, so a busy shared project can name more creators than D1 binds
 * in one statement. Run against a real SQLite engine that enforces D1's bind ceiling.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import { enrichSessionsWithCreators } from '../../../src/routes/chat-session-ownership';
import { createAllSchemaTables, createSqliteD1WithBindLimit } from '../../helpers/sqlite-d1';

describe('enrichSessionsWithCreators', () => {
  let sqlite: Database.Database;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  // Cloudflare's documented D1 ceiling, written out rather than read from
  // `D1_MAX_BOUND_PARAMETERS`, so a wrong constant cannot also move the test's limit.
  const D1_BOUND_PARAMETER_CEILING = 100;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    db = drizzle(createSqliteD1WithBindLimit(sqlite, D1_BOUND_PARAMETER_CEILING), { schema });
  });

  afterEach(() => {
    sqlite.close();
  });

  it('names every creator when there are more than one statement can bind', async () => {
    // Well past the ceiling, and not a multiple of it, so an off-by-one cannot land on a
    // clean boundary.
    const creatorCount = 251;
    const insert = sqlite.prepare('INSERT INTO users (id, email, name) VALUES (?, ?, ?)');
    const sessions = Array.from({ length: creatorCount }, (_, n) => {
      insert.run(`user-${n}`, `user-${n}@example.com`, `User ${n}`);
      return { id: `session-${n}`, createdByUserId: `user-${n}` };
    });

    const enriched = await enrichSessionsWithCreators(db, sessions, 'user-0');

    expect(enriched).toHaveLength(creatorCount);
    expect(enriched.every((session) => session.createdBy !== null)).toBe(true);
    expect(enriched[creatorCount - 1]).toMatchObject({
      createdBy: { id: `user-${creatorCount - 1}`, name: `User ${creatorCount - 1}` },
      isMine: false,
    });
    expect(enriched[0]).toMatchObject({ isMine: true });
  });
});
