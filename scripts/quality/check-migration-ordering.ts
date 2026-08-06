#!/usr/bin/env tsx
/**
 * D1 migration ordering check.
 *
 * Wrangler applies D1 migrations by filename from each migrations_dir. Historical
 * files that already ran must not be renamed just to repair numeric prefixes,
 * because existing databases may treat renamed files as new migrations. This
 * guard preserves known legacy duplicate prefixes and blocks any new ambiguous
 * migration names going forward.
 */

import { readdirSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

const DEFAULT_MIGRATION_DIRS = [
  resolve(import.meta.dirname, '../../apps/api/src/db/migrations'),
  resolve(import.meta.dirname, '../../apps/api/src/db/migrations/observability'),
];

const LEGACY_ALLOWED_DUPLICATE_PREFIXES = new Map<string, Set<string>>([
  [
    'apps/api/src/db/migrations',
    new Set(['0002', '0013', '0016', '0024', '0029', '0036', '0037', '0042', '0052', '0069']),
  ],
]);

interface Violation {
  dir: string;
  message: string;
}

function repoRelative(path: string): string {
  return relative(resolve(import.meta.dirname, '../..'), path).replaceAll('\\', '/');
}

function getMigrationDirs(): string[] {
  const explicitDirs = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
  return explicitDirs.length > 0 ? explicitDirs.map((dir) => resolve(dir)) : DEFAULT_MIGRATION_DIRS;
}

function allowedDuplicatesFor(dir: string): Set<string> {
  return LEGACY_ALLOWED_DUPLICATE_PREFIXES.get(repoRelative(dir)) ?? new Set();
}

function validateDirectory(dir: string): Violation[] {
  const violations: Violation[] = [];
  const entries = readdirSync(dir).sort();
  const sqlFiles: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      if (entry === 'observability' && repoRelative(dir) === 'apps/api/src/db/migrations') {
        continue;
      }
      violations.push({ dir, message: `Unexpected directory in migrations_dir: ${entry}` });
      continue;
    }

    if (!entry.endsWith('.sql')) {
      violations.push({ dir, message: `Unexpected non-SQL file in migrations_dir: ${entry}` });
      continue;
    }

    if (!/^\d{4}_[a-z0-9][a-z0-9_]*\.sql$/.test(entry)) {
      violations.push({
        dir,
        message: `Migration filename must match NNNN_descriptive_name.sql: ${entry}`,
      });
      continue;
    }

    sqlFiles.push(entry);
  }

  const byPrefix = new Map<string, string[]>();
  for (const file of sqlFiles) {
    const prefix = file.slice(0, 4);
    const files = byPrefix.get(prefix) ?? [];
    files.push(file);
    byPrefix.set(prefix, files);
  }

  const allowed = allowedDuplicatesFor(dir);
  for (const [prefix, files] of byPrefix) {
    if (files.length <= 1) continue;
    if (allowed.has(prefix)) continue;
    violations.push({
      dir,
      message: `Duplicate migration numeric prefix ${prefix}: ${files.join(', ')}`,
    });
  }

  return violations;
}

function main(): void {
  const dirs = getMigrationDirs();
  const violations = dirs.flatMap(validateDirectory);

  if (violations.length > 0) {
    console.error(`D1 migration ordering check FAILED — ${violations.length} violation(s):\n`);
    for (const violation of violations) {
      console.error(`  ${repoRelative(violation.dir)}: ${violation.message}`);
    }
    console.error(
      '\nDo not rename already-applied migrations. Add the next migration with a unique numeric prefix.'
    );
    process.exit(1);
  }

  console.log(
    `D1 migration ordering check passed. ${dirs.length} migration director${dirs.length === 1 ? 'y' : 'ies'} scanned.`
  );
}

// Only run main when executed directly (not when imported for testing).
const isDirectExecution = process.argv[1]?.endsWith('check-migration-ordering.ts');
if (isDirectExecution) {
  main();
}
