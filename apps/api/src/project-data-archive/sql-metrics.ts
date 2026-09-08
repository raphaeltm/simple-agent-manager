import { createModuleLogger } from '../lib/logger';
const log = createModuleLogger('project_data.archive_sql');

/** Report the actual SQL cursor write counter, including failed attempts. The admission
 * estimate can be calibrated against these counters; it is never presented as billed usage.
 */
export async function measureArchiveSql<T>(sql: SqlStorage, sessionId: string, phase: string,
  operation: (measured: SqlStorage) => Promise<T>): Promise<T> {
  let rowsWritten = 0;
  const before = sql.databaseSize;
  const measured = new Proxy(sql, { get(target, key) {
    if (key === 'exec') return (query: string, ...bindings: unknown[]) => {
      const cursor = target.exec(query, ...bindings);
      rowsWritten += cursor.rowsWritten ?? 0;
      return cursor;
    };
    return Reflect.get(target, key, target);
  } });
  try { return await operation(measured); }
  finally { log.info('project_data_archive_sql_usage', { sessionId, phase, rowsWritten,
    databaseSizeBeforeBytes: before, databaseSizeAfterBytes: sql.databaseSize }); }
}
