/**
 * Migration Safety Check
 *
 * Scans all D1 migration files and blocks dangerous patterns that can cause
 * production data loss. This check runs in CI and blocks merge.
 *
 * What it catches:
 *
 * 1. DROP TABLE on any table that is a parent in an ON DELETE CASCADE
 *    foreign key relationship. Dropping such a table can wipe all rows
 *    in child tables — even with PRAGMA foreign_keys = OFF in some
 *    D1 execution contexts.
 *
 * 2. Table recreation patterns (CREATE new, copy, DROP old, RENAME) that
 *    target FK parent tables. The "safe" SQLite pattern for altering columns
 *    is catastrophically unsafe when the table has CASCADE children.
 *
 * 3. TRUNCATE / DELETE FROM without WHERE on FK parent tables.
 *
 * Why this exists:
 * Migration 0047 dropped and recreated the `projects` table. The `triggers`,
 * `tasks`, `agent_profiles`, `deployment_credentials`, and other tables had
 * ON DELETE CASCADE referencing projects. The DROP TABLE cascaded and wiped
 * all data from every child table in production.
 *
 * See: docs/notes/2026-04-25-migration-cascade-data-loss-postmortem.md
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const MIGRATIONS_DIR = resolve(
  import.meta.dirname,
  '../../apps/api/src/db/migrations'
);

/**
 * Allowlist for migrations that already ran in production before this check existed.
 * These are grandfathered — they cannot be un-run, and blocking CI on them is pointless.
 * NEVER add new migrations to this list. If a new migration triggers a violation,
 * fix the migration — do not allowlist it.
 *
 * Format: "filename:line" matching the violation output.
 */
const ALLOWLISTED_VIOLATIONS = new Set([
  // Ran before any child tables existed — no actual cascade risk at the time
  '0002_betterauth_tables.sql:27',
  '0003_users_timestamp_to_integer.sql:39',
  '0037_project_file_directories.sql:44',
  // THE MIGRATION THAT CAUSED THE 2026-04-25 DATA LOSS INCIDENT.
  // Already applied in production. Listed here ONLY so CI passes on main.
  // This is the reason this check exists.
  '0047_artifacts_repo_provider.sql:61',
]);

interface ForeignKey {
  childTable: string;
  parentTable: string;
  onDelete: string;
  migrationFile: string;
}

interface Violation {
  file: string;
  line: number;
  pattern: string;
  message: string;
}

/**
 * Parse all migration files and extract FK relationships.
 */
function extractForeignKeys(migrationsDir: string): ForeignKey[] {
  const fks: ForeignKey[] = [];
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const content = readFileSync(join(migrationsDir, file), 'utf-8');

    // Find CREATE TABLE blocks and extract their table name + FK references
    // Match both inline column FKs and table-level FOREIGN KEY constraints
    const createTableRegex =
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(([\s\S]*?)\);/gi;
    let createMatch;
    while ((createMatch = createTableRegex.exec(content)) !== null) {
      const tableName = createMatch[1];
      const tableBody = createMatch[2];

      // Skip _new/_tmp tables — they're intermediate recreation targets
      if (tableName.endsWith('_new') || tableName.endsWith('_tmp')) continue;

      // Inline column FK: REFERENCES parent_table(col) ON DELETE CASCADE
      const inlineFkRegex =
        /REFERENCES\s+(\w+)\s*\([^)]+\)\s+ON\s+DELETE\s+(CASCADE|SET\s+NULL|SET\s+DEFAULT|RESTRICT|NO\s+ACTION)/gi;
      let fkMatch;
      while ((fkMatch = inlineFkRegex.exec(tableBody)) !== null) {
        fks.push({
          childTable: tableName,
          parentTable: fkMatch[1],
          onDelete: fkMatch[2].toUpperCase(),
          migrationFile: file,
        });
      }

      // Table-level: FOREIGN KEY (col) REFERENCES parent_table(col) ON DELETE CASCADE
      const tableFkRegex =
        /FOREIGN\s+KEY\s*\([^)]+\)\s+REFERENCES\s+(\w+)\s*\([^)]+\)\s+ON\s+DELETE\s+(CASCADE|SET\s+NULL|SET\s+DEFAULT|RESTRICT|NO\s+ACTION)/gi;
      let tableFkMatch;
      while ((tableFkMatch = tableFkRegex.exec(tableBody)) !== null) {
        fks.push({
          childTable: tableName,
          parentTable: tableFkMatch[1],
          onDelete: tableFkMatch[2].toUpperCase(),
          migrationFile: file,
        });
      }
    }

    // Also catch ALTER TABLE ... ADD COLUMN ... REFERENCES ... ON DELETE CASCADE
    const alterFkRegex =
      /ALTER\s+TABLE\s+(\w+)\s+ADD\s+(?:COLUMN\s+)?\w+[^;]*REFERENCES\s+(\w+)\s*\([^)]+\)\s+ON\s+DELETE\s+(CASCADE|SET\s+NULL|SET\s+DEFAULT|RESTRICT|NO\s+ACTION)/gi;
    let alterMatch;
    while ((alterMatch = alterFkRegex.exec(content)) !== null) {
      fks.push({
        childTable: alterMatch[1],
        parentTable: alterMatch[2],
        onDelete: alterMatch[3].toUpperCase(),
        migrationFile: file,
      });
    }
  }

  return fks;
}

/**
 * Build a map of parent table -> child tables with CASCADE deletes.
 */
function buildCascadeMap(
  fks: ForeignKey[]
): Map<string, { childTable: string; migrationFile: string }[]> {
  const cascadeMap = new Map<
    string,
    { childTable: string; migrationFile: string }[]
  >();

  for (const fk of fks) {
    if (fk.onDelete === 'CASCADE') {
      const existing = cascadeMap.get(fk.parentTable) ?? [];
      existing.push({
        childTable: fk.childTable,
        migrationFile: fk.migrationFile,
      });
      cascadeMap.set(fk.parentTable, existing);
    }
  }

  return cascadeMap;
}

/**
 * Scan migration files for dangerous DROP TABLE / DELETE FROM patterns
 * targeting FK parent tables.
 */
function scanForViolations(
  migrationsDir: string,
  cascadeMap: Map<string, { childTable: string; migrationFile: string }[]>
): Violation[] {
  const violations: Violation[] = [];
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const content = readFileSync(join(migrationsDir, file), 'utf-8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Skip comments
      if (line.trim().startsWith('--')) continue;

      // Check for DROP TABLE targeting a CASCADE parent
      const dropMatch = line.match(
        /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\w+)/i
      );
      if (dropMatch) {
        const tableName = dropMatch[1];

        // Allow dropping _new/_tmp tables (cleanup of failed recreation)
        if (tableName.endsWith('_new') || tableName.endsWith('_tmp')) continue;

        const children = cascadeMap.get(tableName);
        if (children && children.length > 0) {
          const childList = children
            .map((c) => `${c.childTable} (from ${c.migrationFile})`)
            .join(', ');
          violations.push({
            file,
            line: lineNum,
            pattern: 'DROP TABLE on CASCADE parent',
            message:
              `DROP TABLE ${tableName} will CASCADE-delete all rows in: ${childList}. ` +
              `Use ALTER TABLE ADD COLUMN instead, or if table recreation is unavoidable, ` +
              `manually re-parent child tables before dropping. ` +
              `See .claude/rules/31-migration-safety.md for safe alternatives.`,
          });
        }
      }

      // Check for DELETE FROM without WHERE on a CASCADE parent
      const deleteMatch = line.match(/DELETE\s+FROM\s+(\w+)/i);
      if (deleteMatch) {
        const tableName = deleteMatch[1];
        const children = cascadeMap.get(tableName);

        // Check if there's a WHERE clause on this line or the next few lines
        const contextLines = lines.slice(i, Math.min(i + 3, lines.length)).join(' ');
        if (children && children.length > 0 && !/WHERE/i.test(contextLines)) {
          const childList = children.map((c) => c.childTable).join(', ');
          violations.push({
            file,
            line: lineNum,
            pattern: 'DELETE FROM without WHERE on CASCADE parent',
            message:
              `DELETE FROM ${tableName} without WHERE will CASCADE-delete all rows in: ${childList}. ` +
              `Add a WHERE clause or reconsider the migration.`,
          });
        }
      }

      // Check for TRUNCATE (SQLite doesn't have TRUNCATE, but catch it anyway)
      const truncateMatch = line.match(/TRUNCATE\s+(?:TABLE\s+)?(\w+)/i);
      if (truncateMatch) {
        const tableName = truncateMatch[1];
        const children = cascadeMap.get(tableName);
        if (children && children.length > 0) {
          violations.push({
            file,
            line: lineNum,
            pattern: 'TRUNCATE on CASCADE parent',
            message: `TRUNCATE ${tableName} will delete all rows and cascade to child tables.`,
          });
        }
      }
    }
  }

  return violations;
}

function main(): void {
  // Also check the observability migrations subdirectory
  const migrationDirs = [MIGRATIONS_DIR];
  const obsMigrationsDir = join(MIGRATIONS_DIR, 'observability');
  try {
    readdirSync(obsMigrationsDir);
    migrationDirs.push(obsMigrationsDir);
  } catch {
    // observability subdirectory may not exist
  }

  // Collect all FK relationships across all migration directories
  const allFks: ForeignKey[] = [];
  for (const dir of migrationDirs) {
    allFks.push(...extractForeignKeys(dir));
  }

  const cascadeMap = buildCascadeMap(allFks);

  // Report the FK cascade map for visibility
  console.log('Foreign key CASCADE relationships detected:');
  for (const [parent, children] of cascadeMap) {
    const childNames = [...new Set(children.map((c) => c.childTable))].join(
      ', '
    );
    console.log(`  ${parent} -> [${childNames}]`);
  }
  console.log('');

  // Scan for violations
  const allViolations: Violation[] = [];
  for (const dir of migrationDirs) {
    allViolations.push(...scanForViolations(dir, cascadeMap));
  }

  // Separate allowlisted (already-applied) from new violations
  const newViolations = allViolations.filter(
    (v) => !ALLOWLISTED_VIOLATIONS.has(`${v.file}:${v.line}`)
  );
  const allowlistedCount = allViolations.length - newViolations.length;

  if (allowlistedCount > 0) {
    console.log(
      `${allowlistedCount} allowlisted violation(s) in already-applied migrations (grandfathered).`
    );
  }

  if (newViolations.length > 0) {
    console.error(
      `\nMigration safety check FAILED — ${newViolations.length} NEW violation(s):\n`
    );
    for (const v of newViolations) {
      console.error(`  ${v.file}:${v.line}`);
      console.error(`  Pattern: ${v.pattern}`);
      console.error(`  ${v.message}`);
      console.error('');
    }
    console.error(
      'These patterns have caused production data loss. See:'
    );
    console.error(
      '  docs/notes/2026-04-25-migration-cascade-data-loss-postmortem.md'
    );
    console.error('  .claude/rules/31-migration-safety.md\n');
    process.exit(1);
  }

  console.log(
    `Migration safety check passed. ${allFks.length} FK relationships scanned, 0 violations.`
  );
}

main();
