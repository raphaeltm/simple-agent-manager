/**
 * Durable Object Migration Safety Check
 *
 * Scans all Durable Object SQLite migration definitions (TypeScript) for
 * dangerous patterns that could cause data loss. This check runs in CI
 * alongside the D1 migration safety check.
 *
 * What it catches:
 *
 * 1. DROP TABLE in DO migrations — DO tables should never be dropped
 *    because there is no rollback mechanism and no point-in-time recovery
 *    for DO SQLite (unlike D1's time-travel).
 *
 * 2. DELETE FROM without WHERE — bulk deletes wipe per-project data
 *    irreversibly.
 *
 * 3. Table recreation patterns (CREATE new, copy, DROP old, RENAME).
 *
 * 4. UPDATE without WHERE on tables with data — can corrupt all rows.
 *
 * Why this exists:
 * D1 has time-travel recovery (30 days). DO SQLite has NO recovery mechanism.
 * A destructive DO migration is permanent — there is no restore workflow.
 * Every DO migration must be append-only and non-destructive.
 *
 * See: docs/notes/2026-04-25-migration-cascade-data-loss-postmortem.md
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';

export const DO_MIGRATION_FILES = [
  resolve(
    import.meta.dirname,
    '../../packages/project-data/src/do/migrations.ts'
  ),
  resolve(
    import.meta.dirname,
    '../../apps/api/src/durable-objects/notification-migrations.ts'
  ),
  // Migration 072's DDL and legacy-row copy live beside the comment core (it is invoked
  // from migrations.ts); scan it like the ledger itself.
  resolve(
    import.meta.dirname,
    '../../packages/project-data/src/do/anchored-comments-migration.ts'
  ),
  // setup-session-pool uses inline constructor DDL (pure DO-SQLite) — scan it.
  resolve(
    import.meta.dirname,
    '../../apps/api/src/durable-objects/setup-session-pool.ts'
  ),
  // CredentialSetupSession keeps every DO-SQLite DDL statement (CREATE TABLE IF NOT
  // EXISTS plus guarded ALTER TABLE ADD COLUMN) in schema.ts. Its index.ts is not
  // scanned: it also writes D1 through a dynamic `SET ${...}` UPDATE that this
  // scanner's line heuristic misreads. Any new DO DDL for it belongs in schema.ts.
  resolve(
    import.meta.dirname,
    '../../apps/api/src/durable-objects/credential-setup-session/schema.ts'
  ),
];

interface Violation {
  file: string;
  line: number;
  pattern: string;
  message: string;
}

/**
 * Allowlist for patterns that are safe in context.
 * Format: "basename:line" — e.g., "migrations.ts:154"
 *
 * Currently empty — all DO migrations use safe patterns. Add entries here
 * only with a justifying comment explaining why the pattern is safe.
 */
const ALLOWLISTED_VIOLATIONS = new Set<string>([]);

/**
 * Extract SQL string literals from a TypeScript migration file.
 *
 * Matches all three JavaScript string forms — template literals, single-quoted,
 * and DOUBLE-quoted. Double quotes are not optional coverage: the idiomatic way
 * to write `ADD COLUMN scope TEXT NOT NULL DEFAULT 'always'` without escaping is
 * to wrap the statement in double quotes, so a scanner that skips them is blind
 * to exactly the statements most likely to embed a literal — and a
 * `sql.exec("DROP TABLE ...")` would sail straight through a green check.
 *
 * Rule 31 calls this gate one that "cannot be bypassed", so a quoting style must
 * never be able to bypass it.
 *
 * Use TypeScript's parser so regex literals cannot masquerade as comments or
 * strings. Retain raw string bodies (including template interpolations) and
 * source line numbers for the existing SQL checks and diagnostics.
 */
export function extractSqlFromTypeScript(
  content: string
): { sql: string; lineStart: number }[] {
  const results: { sql: string; lineStart: number }[] = [];
  const SQL_KEYWORDS = /\b(CREATE|DROP|DELETE|INSERT|UPDATE|ALTER|TRUNCATE|SELECT)\b/i;
  const source = ts.createSourceFile(
    'migration.ts',
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  function visit(node: ts.Node): void {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateExpression(node)
    ) {
      const start = node.getStart(source);
      const sql = content.slice(start + 1, node.end - 1);
      if (SQL_KEYWORDS.test(sql)) {
        results.push({
          sql,
          lineStart: source.getLineAndCharacterOfPosition(start).line + 1,
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return results;
}

type ViolationLocation = Pick<Violation, 'file' | 'line'>;

function dropTableViolation(line: string, location: ViolationLocation): Violation | undefined {
  const match = line.match(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\w+)/i);
  if (!match) return;
  const tableName = match[1];
  // Preserve failed-recreation cleanup and the source-line allowlist.
  if (
    tableName.endsWith('_new') ||
    tableName.endsWith('_tmp') ||
    ALLOWLISTED_VIOLATIONS.has(`${location.file}:${location.line}`)
  )
    return;
  return {
    ...location,
    pattern: 'DROP TABLE in DO migration',
    message:
      `DROP TABLE ${tableName} in a Durable Object migration is irreversible. ` +
      `DO SQLite has NO time-travel recovery (unlike D1). ` +
      `Use ALTER TABLE ADD COLUMN or CREATE TABLE IF NOT EXISTS instead.`,
  };
}

function deleteWithoutWhereViolation(
  line: string,
  context: string,
  location: ViolationLocation
): Violation | undefined {
  const match = line.match(/DELETE\s+FROM\s+(\w+)/i);
  if (
    !match ||
    /WHERE/i.test(context) ||
    ALLOWLISTED_VIOLATIONS.has(`${location.file}:${location.line}`)
  )
    return;
  return {
    ...location,
    pattern: 'DELETE FROM without WHERE in DO migration',
    message:
      `DELETE FROM ${match[1]} without WHERE will wipe all rows. ` +
      `DO SQLite has no recovery mechanism. Add a WHERE clause.`,
  };
}

function updateWithoutWhereViolation(
  line: string,
  context: string,
  location: ViolationLocation
): Violation | undefined {
  const match = line.match(/UPDATE\s+(\w+)\s+SET\b/i);
  if (
    !match ||
    /WHERE/i.test(context) ||
    ALLOWLISTED_VIOLATIONS.has(`${location.file}:${location.line}`)
  )
    return;
  return {
    ...location,
    pattern: 'UPDATE without WHERE in DO migration',
    message:
      `UPDATE ${match[1]} SET without WHERE will modify all rows. ` +
      `If this is an intentional backfill, add a WHERE clause (e.g., WHERE column IS NULL).`,
  };
}

function truncateViolation(line: string, location: ViolationLocation): Violation | undefined {
  const match = line.match(/TRUNCATE\s+(?:TABLE\s+)?(\w+)/i);
  if (!match) return;
  // TRUNCATE has never honored the allowlist; preserve that strict behavior.
  return {
    ...location,
    pattern: 'TRUNCATE in DO migration',
    message: `TRUNCATE ${match[1]} is irreversible in DO SQLite.`,
  };
}

export function scanDoMigrations(filePath: string): Violation[] {
  const violations: Violation[] = [];
  const content = readFileSync(filePath, 'utf-8');
  const basename = filePath.split('/').pop() ?? filePath;
  for (const { sql, lineStart } of extractSqlFromTypeScript(content)) {
    const sqlLines = sql.split('\n');
    for (let i = 0; i < sqlLines.length; i++) {
      const line = sqlLines[i];
      if (line.trim().startsWith('--')) continue;
      const location = { file: basename, line: lineStart + i };
      // DELETE/UPDATE retain the same three-line WHERE lookahead.
      const context = sqlLines.slice(i, Math.min(i + 3, sqlLines.length)).join(' ');
      for (const violation of [
        dropTableViolation(line, location),
        deleteWithoutWhereViolation(line, context, location),
        updateWithoutWhereViolation(line, context, location),
        truncateViolation(line, location),
      ]) {
        if (violation) violations.push(violation);
      }
    }
  }
  return violations;
}

function main(): void {
  console.log('Durable Object migration safety check');
  console.log('======================================\n');

  const allViolations: Violation[] = [];

  for (const filePath of DO_MIGRATION_FILES) {
    try {
      const violations = scanDoMigrations(filePath);
      allViolations.push(...violations);
      const basename = filePath.split('/').pop();
      console.log(
        `  ${basename}: ${violations.length === 0 ? 'PASS' : `${violations.length} violation(s)`}`
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        console.log(
          `  ${filePath.split('/').pop()}: SKIPPED (file not found)`
        );
      } else {
        throw e;
      }
    }
  }

  console.log('');

  if (allViolations.length > 0) {
    console.error(
      `DO migration safety check FAILED — ${allViolations.length} violation(s):\n`
    );
    for (const v of allViolations) {
      console.error(`  ${v.file}:${v.line}`);
      console.error(`  Pattern: ${v.pattern}`);
      console.error(`  ${v.message}`);
      console.error('');
    }
    console.error(
      'DO SQLite has NO time-travel recovery. Destructive operations are permanent.'
    );
    console.error('See .claude/rules/31-migration-safety.md\n');
    process.exit(1);
  }

  console.log(
    'DO migration safety check passed. All migrations are non-destructive.'
  );
}

// Only run main when executed directly (not when imported for testing).
const isDirectExecution = process.argv[1]?.endsWith('check-do-migration-safety.ts');
if (isDirectExecution) {
  main();
}
