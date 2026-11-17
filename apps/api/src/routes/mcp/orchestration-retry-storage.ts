/** Replacement-task persistence, separate from retry placement and startup orchestration. */
import { getTableColumns, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export async function insertMcpRetriedTask(db: Db, values: typeof schema.tasks.$inferInsert) {
  // Keep the same typed row and Drizzle column encoders while making mission
  // admission part of INSERT itself, rather than an earlier awaited check.
  const columns = getTableColumns(schema.tasks);
  const entries = Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ({ column: columns[key as keyof typeof columns], value }));
  const columnNames = sql.join(
    entries.map(({ column }) => sql.identifier(column.name)),
    sql`, `
  );
  const boundValues = sql.join(
    entries.map(({ column, value }) => sql`${sql.param(value, column)}`),
    sql`, `
  );
  const missionId = values.missionId ?? null;
  return db.run(sql`INSERT INTO ${schema.tasks} (${columnNames}) SELECT ${boundValues}
    WHERE (${missionId} IS NULL OR EXISTS (
      SELECT 1 FROM ${schema.missions} WHERE ${schema.missions.id} = ${missionId}
      AND ${schema.missions.projectId} = ${values.projectId}
      AND ${schema.missions.status} NOT IN ('cancelled', 'completed', 'failed')
    ))`);
}
