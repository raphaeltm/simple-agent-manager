import type Database from 'better-sqlite3';
import { is } from 'drizzle-orm';
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';

interface ExecutableStatement {
  run(): Promise<unknown>;
  runSync(): unknown;
}

/**
 * Create tables in an in-memory SQLite database directly from the drizzle schema
 * definitions, so a test database can never drift from the columns production
 * queries actually select (`db.select().from(table)` selects every column).
 *
 * Only column names/affinities and the primary key are emitted. FK, NOT NULL and
 * DEFAULT constraints are intentionally omitted so tests can seed narrow fixtures
 * without materialising every referenced table. The point of this helper is that
 * real WHERE predicates get evaluated by a real SQL engine — a mock whose
 * `.where()` ignores its arguments cannot prove an ownership guard filters.
 */
export function createSchemaTables(sqlite: Database.Database, tables: SQLiteTable[]): void {
  for (const table of tables) {
    const config = getTableConfig(table);
    const inlinePrimaryKey = config.columns.filter((column) => column.primary);
    const definitions = config.columns.map((column) => {
      // Only inline PRIMARY KEY when exactly one column claims it; SQLite rejects
      // multiple inline primary keys, so composite keys become a table constraint.
      const primary = column.primary && inlinePrimaryKey.length === 1 ? ' PRIMARY KEY' : '';
      return `"${column.name}" ${column.getSQLType()}${primary}`;
    });

    if (inlinePrimaryKey.length > 1) {
      definitions.push(
        `PRIMARY KEY (${inlinePrimaryKey.map((column) => `"${column.name}"`).join(', ')})`
      );
    }
    for (const compositeKey of config.primaryKeys) {
      definitions.push(
        `PRIMARY KEY (${compositeKey.columns.map((column) => `"${column.name}"`).join(', ')})`
      );
    }

    sqlite.exec(`CREATE TABLE "${config.name}" (${definitions.join(', ')})`);
  }
}

/**
 * Materialise every table exported by a drizzle schema module. Use this for route-level tests,
 * where a handler's incidental reads (profile hints, activity, dependencies) would otherwise
 * force the test to enumerate — and keep re-enumerating — tables it does not care about.
 */
export function createAllSchemaTables(
  sqlite: Database.Database,
  schemaModule: Record<string, unknown>
): void {
  const tables = Object.values(schemaModule).filter((value): value is SQLiteTable =>
    is(value, SQLiteTable)
  );
  createSchemaTables(sqlite, tables);
}

/** Faithful D1 boundary adapter backed by a real in-memory SQLite engine. */
export function createSqliteD1(sqlite: Database.Database): D1Database {
  const normalize = (params: unknown[]) =>
    params.map((value) => (value === undefined ? null : value));

  const bound = (sql: string, params: unknown[]): ExecutableStatement & Record<string, unknown> => {
    const runSync = () => {
      const info = sqlite.prepare(sql).run(...normalize(params));
      return {
        success: true,
        results: [],
        meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) },
      };
    };
    return {
      runSync,
      run: async () => runSync(),
      all: async () => ({
        success: true,
        results: sqlite.prepare(sql).all(...normalize(params)),
        meta: {},
      }),
      raw: async () =>
        sqlite
          .prepare(sql)
          .raw()
          .all(...normalize(params)),
      first: async (column?: string) => {
        const row = sqlite.prepare(sql).get(...normalize(params)) as
          | Record<string, unknown>
          | undefined;
        return column === undefined ? (row ?? null) : (row?.[column] ?? null);
      },
    };
  };

  const statement = (sql: string) => ({
    bind: (...params: unknown[]) => bound(sql, params),
    ...bound(sql, []),
  });

  return {
    prepare: statement,
    batch: async (statements: ExecutableStatement[]) =>
      sqlite.transaction((items: ExecutableStatement[]) => items.map((item) => item.runSync()))(
        statements
      ),
    exec: async (sql: string) => {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;
}

/** Small stateful KV boundary fake that preserves JSON get/put semantics. */
export function createMemoryKv(): KVNamespace {
  const values = new Map<string, string>();
  return {
    get: async (key: string, type?: string) => {
      const value = values.get(key) ?? null;
      return type === 'json' && value !== null ? JSON.parse(value) : value;
    },
    put: async (key: string, value: string) => {
      values.set(key, value);
    },
  } as unknown as KVNamespace;
}
