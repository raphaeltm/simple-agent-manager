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
      if (/SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(message)) category = 'busy';
      else if (/SQLITE_CONSTRAINT|constraint failed/i.test(message)) category = 'constraint';
      else if (/SQLITE_FULL|database or disk is full/i.test(message)) category = 'storage_full';
      else if (/SQLITE_TOOBIG|too big/i.test(message)) category = 'too_large';
      else if (/SQLITE_CORRUPT|SQLITE_NOTADB/i.test(message)) category = 'corrupt';
      else if (/SQLITE_SCHEMA|no such (table|column)/i.test(message)) category = 'schema';
      else if (/SQLITE_MISMATCH|D1_TYPE_ERROR/i.test(message)) category = 'type';
      else if (/D1.*(overload|rate.limit)|too many requests/i.test(message))
        category = 'overloaded';
      else if (/D1.*timeout|timed out/i.test(message)) category = 'timeout';
      else if (/D1.*(reset|unavailable|internal error)/i.test(message)) category = 'unavailable';
    }
    current = current.cause;
  }
  return category;
}
