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

const DO_MIGRATION_FILES = [
  resolve(
    import.meta.dirname,
    '../../apps/api/src/durable-objects/migrations.ts'
  ),
  resolve(
    import.meta.dirname,
    '../../apps/api/src/durable-objects/notification-migrations.ts'
  ),
  // trial-counter.ts has inline DDL (CREATE TABLE IF NOT EXISTS) — scan it too
  resolve(
    import.meta.dirname,
    '../../apps/api/src/durable-objects/trial-counter.ts'
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
 * Matches template literals (backtick strings) and regular strings
 * that contain SQL keywords.
 */
function extractSqlFromTypeScript(
  content: string
): { sql: string; lineStart: number }[] {
  const results: { sql: string; lineStart: number }[] = [];

  // Match template literals (backtick strings)
  const templateRegex = /`([\s\S]*?)`/g;
  let match;
  while ((match = templateRegex.exec(content)) !== null) {
    const sqlContent = match[1];
    // Only include if it looks like SQL
    if (
      /\b(CREATE|DROP|DELETE|INSERT|UPDATE|ALTER|TRUNCATE|SELECT)\b/i.test(
        sqlContent
      )
    ) {
      const lineStart =
        content.substring(0, match.index).split('\n').length;
      results.push({ sql: sqlContent, lineStart });
    }
  }

  // Match single-quoted strings with SQL
  const singleQuoteRegex = /'((?:[^'\\]|\\.)*)'/g;
  while ((match = singleQuoteRegex.exec(content)) !== null) {
    const sqlContent = match[1];
    if (
      /\b(CREATE|DROP|DELETE|INSERT|UPDATE|ALTER|TRUNCATE)\b/i.test(
        sqlContent
      )
    ) {
      const lineStart =
        content.substring(0, match.index).split('\n').length;
      results.push({ sql: sqlContent, lineStart });
    }
  }

  return results;
}

function scanDoMigrations(filePath: string): Violation[] {
  const violations: Violation[] = [];
  const content = readFileSync(filePath, 'utf-8');
  const basename = filePath.split('/').pop() ?? filePath;
  const sqlBlocks = extractSqlFromTypeScript(content);

  for (const { sql, lineStart } of sqlBlocks) {
    const sqlLines = sql.split('\n');

    for (let i = 0; i < sqlLines.length; i++) {
      const line = sqlLines[i];
      const absoluteLine = lineStart + i;

      // Skip comments
      if (line.trim().startsWith('--')) continue;

      // 1. DROP TABLE (never allowed in DO migrations)
      const dropTableMatch = line.match(
        /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\w+)/i
      );
      if (dropTableMatch) {
        const tableName = dropTableMatch[1];
        // Allow dropping _new/_tmp tables (cleanup of failed recreation)
        if (
          !tableName.endsWith('_new') &&
          !tableName.endsWith('_tmp')
        ) {
          const key = `${basename}:${absoluteLine}`;
          if (!ALLOWLISTED_VIOLATIONS.has(key)) {
            violations.push({
              file: basename,
              line: absoluteLine,
              pattern: 'DROP TABLE in DO migration',
              message:
                `DROP TABLE ${tableName} in a Durable Object migration is irreversible. ` +
                `DO SQLite has NO time-travel recovery (unlike D1). ` +
                `Use ALTER TABLE ADD COLUMN or CREATE TABLE IF NOT EXISTS instead.`,
            });
          }
        }
      }

      // 2. DELETE FROM without WHERE
      const deleteMatch = line.match(/DELETE\s+FROM\s+(\w+)/i);
      if (deleteMatch) {
        const tableName = deleteMatch[1];
        // Check next few lines for WHERE clause
        const context = sqlLines
          .slice(i, Math.min(i + 3, sqlLines.length))
          .join(' ');
        if (!/WHERE/i.test(context)) {
          const key = `${basename}:${absoluteLine}`;
          if (!ALLOWLISTED_VIOLATIONS.has(key)) {
            violations.push({
              file: basename,
              line: absoluteLine,
              pattern: 'DELETE FROM without WHERE in DO migration',
              message:
                `DELETE FROM ${tableName} without WHERE will wipe all rows. ` +
                `DO SQLite has no recovery mechanism. Add a WHERE clause.`,
            });
          }
        }
      }

      // 3. UPDATE without WHERE (data corruption risk)
      const updateMatch = line.match(/UPDATE\s+(\w+)\s+SET\b/i);
      if (updateMatch) {
        const tableName = updateMatch[1];
        const context = sqlLines
          .slice(i, Math.min(i + 3, sqlLines.length))
          .join(' ');
        // Allow UPDATE with WHERE (backfill patterns are fine)
        if (!/WHERE/i.test(context)) {
          // Allow known safe backfill patterns (e.g., SET column = rowid WHERE column IS NULL)
          // The existing migration 007 does: UPDATE chat_messages SET sequence = rowid WHERE sequence IS NULL
          // That has a WHERE so it won't trigger this check.
          const key = `${basename}:${absoluteLine}`;
          if (!ALLOWLISTED_VIOLATIONS.has(key)) {
            violations.push({
              file: basename,
              line: absoluteLine,
              pattern: 'UPDATE without WHERE in DO migration',
              message:
                `UPDATE ${tableName} SET without WHERE will modify all rows. ` +
                `If this is an intentional backfill, add a WHERE clause (e.g., WHERE column IS NULL).`,
            });
          }
        }
      }

      // 4. TRUNCATE (not valid in SQLite but catch anyway)
      const truncateMatch = line.match(
        /TRUNCATE\s+(?:TABLE\s+)?(\w+)/i
      );
      if (truncateMatch) {
        violations.push({
          file: basename,
          line: absoluteLine,
          pattern: 'TRUNCATE in DO migration',
          message: `TRUNCATE ${truncateMatch[1]} is irreversible in DO SQLite.`,
        });
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

main();
