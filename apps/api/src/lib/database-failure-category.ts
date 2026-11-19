const DATABASE_FAILURE_CATEGORIES = [
  [/SQLITE_BUSY|SQLITE_LOCKED|database is locked/i, 'busy'],
  [/SQLITE_CONSTRAINT|constraint failed/i, 'constraint'],
  [/SQLITE_FULL|database or disk is full/i, 'storage_full'],
  [/SQLITE_TOOBIG|too big/i, 'too_large'],
  [/SQLITE_CORRUPT|SQLITE_NOTADB/i, 'corrupt'],
  [/SQLITE_SCHEMA|no such (table|column)/i, 'schema'],
  [/SQLITE_MISMATCH|D1_TYPE_ERROR/i, 'type'],
  [/D1.*(overload|rate.limit)|too many requests/i, 'overloaded'],
  [/D1.*timeout|timed out/i, 'timeout'],
  [/D1.*(reset|unavailable|internal error)/i, 'unavailable'],
] as const;

/** Allowlisted diagnostics only: never serialize database messages, SQL, or bindings. */
export function databaseFailureCategory(error: unknown): string {
  const seen = new Set<unknown>();
  let current = error;
  let category = 'unknown';
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    // Drizzle wrapper messages contain SQL parameters. Only classify the underlying error.
    if (!('query' in current)) {
      const message = current.message;
      category =
        DATABASE_FAILURE_CATEGORIES.find(([pattern]) => pattern.test(message))?.[1] ?? category;
    }
    current = current.cause;
  }
  return category;
}
