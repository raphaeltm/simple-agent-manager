/** Replacement-task persistence, separate from retry placement and startup orchestration. */
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export async function insertMcpRetriedTask(db: Db, values: typeof schema.tasks.$inferInsert) {
  return db.insert(schema.tasks).values(values);
}
