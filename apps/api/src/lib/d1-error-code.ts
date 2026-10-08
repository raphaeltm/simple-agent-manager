/** Safe diagnostic vocabulary: never copy provider messages, SQL or parameters. */
const D1_CAUSE_CODES = new Set([
  'SQLITE_ERROR',
  'SQLITE_INTERNAL',
  'SQLITE_PERM',
  'SQLITE_ABORT',
  'SQLITE_BUSY',
  'SQLITE_LOCKED',
  'SQLITE_NOMEM',
  'SQLITE_READONLY',
  'SQLITE_INTERRUPT',
  'SQLITE_IOERR',
  'SQLITE_CORRUPT',
  'SQLITE_NOTFOUND',
  'SQLITE_FULL',
  'SQLITE_CANTOPEN',
  'SQLITE_PROTOCOL',
  'SQLITE_EMPTY',
  'SQLITE_SCHEMA',
  'SQLITE_TOOBIG',
  'SQLITE_CONSTRAINT',
  'SQLITE_CONSTRAINT_CHECK',
  'SQLITE_CONSTRAINT_FOREIGNKEY',
  'SQLITE_CONSTRAINT_NOTNULL',
  'SQLITE_CONSTRAINT_PRIMARYKEY',
  'SQLITE_CONSTRAINT_UNIQUE',
  'SQLITE_MISMATCH',
  'SQLITE_MISUSE',
  'SQLITE_AUTH',
  'SQLITE_RANGE',
  'SQLITE_NOTADB',
  'D1_ERROR',
  'D1_EXEC_ERROR',
  'D1_TYPE_ERROR',
  'D1_COLUMN_NOTFOUND',
]);

// Stable categories for documented D1 errors which have no SQLite code.
// https://developers.cloudflare.com/d1/observability/debug-d1/
const D1_MESSAGE_CODES: ReadonlyMap<string, string> = new Map([
  ['D1 DB is overloaded. Requests queued for too long.', 'D1_OVERLOADED'],
  ['D1 DB is overloaded. Too many requests queued.', 'D1_OVERLOADED'],
  ['Network connection lost.', 'D1_NETWORK'],
  ['Replica disconnected from primary.', 'D1_NETWORK'],
  ['D1 DB storage operation exceeded timeout which caused object to be reset.', 'D1_TIMEOUT'],
]);

export function isFailedQueryError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Failed query:');
}

/** Walk Error causes with cycle detection; return only a fixed, known code. */
export function d1CauseCode(error: unknown): string | undefined {
  const visited = new Set<Error>();
  let current = error;
  let fallback: string | undefined;
  while (current instanceof Error && !visited.has(current)) {
    visited.add(current);
    // Drizzle's outer message contains user-controlled parameters. Inspect only
    // the driver's error below it, never tokens embedded in the failed query.
    if (!isFailedQueryError(current)) {
      const code = (current as Error & { code?: unknown }).code;
      if (typeof code === 'string' && D1_CAUSE_CODES.has(code)) return code;
      const sqliteMatch = current.message.match(
        /(?:^|:\s*)(SQLITE_[A-Z_]+)(?: \(extended: (SQLITE_[A-Z_]+)\))?\s*$/
      );
      const sqliteCode = sqliteMatch?.[2] ?? sqliteMatch?.[1];
      if (sqliteCode && D1_CAUSE_CODES.has(sqliteCode)) return sqliteCode;
      const d1Code = current.message.match(/^(D1_[A-Z_]+):/)?.[1];
      if (d1Code && D1_CAUSE_CODES.has(d1Code)) {
        const category = D1_MESSAGE_CODES.get(current.message.slice(d1Code.length + 1).trim());
        if (category) return category;
        fallback = d1Code;
      }
    }
    current = current.cause;
  }
  return fallback;
}
