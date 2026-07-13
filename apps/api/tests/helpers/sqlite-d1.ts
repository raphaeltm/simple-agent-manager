import type Database from 'better-sqlite3';

interface ExecutableStatement {
  run(): Promise<unknown>;
  runSync(): unknown;
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
