import type Database from 'better-sqlite3';

export function createSqlStorage(db: Database.Database): SqlStorage {
  return {
    exec(query: string, ...params: unknown[]) {
      const trimmed = query.trim().toUpperCase();
      const isSelect = trimmed.startsWith('SELECT') || trimmed.startsWith('WITH');

      if (isSelect) {
        const stmt = db.prepare(query);
        const rows = params.length > 0 ? stmt.all(...params) : stmt.all();
        return {
          toArray() { return rows; },
          rowsWritten: 0,
        };
      }

      if (params.length === 0) {
        db.exec(query);
        return {
          toArray() { return []; },
          rowsWritten: 0,
        };
      }

      const stmt = db.prepare(query);
      const result = stmt.run(...params);
      return {
        toArray() { return []; },
        rowsWritten: result.changes,
      };
    },
  } as unknown as SqlStorage;
}
