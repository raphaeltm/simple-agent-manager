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

const LEGACY_ALLOWED_DUPLICATE_FILES = new Map<string, Map<string, Set<string>>>([
  [
    'apps/api/src/db/migrations',
    new Map([
      ['0002', new Set(['0002_betterauth_tables.sql', '0002_multi_agent_acp.sql'])],
      [
        '0013',
        new Set(['0013_project_first_architecture.sql', '0013_task_auto_provisioned_node.sql']),
      ],
      ['0016', new Set(['0016_remove_idle_timeout.sql', '0016_session_suspend_resume.sql'])],
      [
        '0024',
        new Set(['0024_project_default_workspace_profile.sql', '0024_unique_chat_session_id.sql']),
      ],
      ['0029', new Set(['0029_project_idle_timeouts.sql', '0029_task_dispatch_depth.sql'])],
      ['0036', new Set(['0036_project_file_library.sql', '0036_triggers.sql'])],
      ['0037', new Set(['0037_platform_credentials.sql', '0037_project_file_directories.sql'])],
      ['0042', new Set(['0042_project_agent_defaults.sql', '0042_project_scoped_credentials.sql'])],
      [
        '0052',
        new Set(['0052_github_installation_accounts.sql', '0052_profile_runtime_assets.sql']),
      ],
      [
        '0069',
        new Set(['0069_deployment_environment_placement.sql', '0069_deployment_volumes.sql']),
      ],
      // These draft migrations were already applied to staging before current-main
      // migrations claimed the same numeric prefixes. Wrangler tracks exact
      // filenames, so renaming the applied files would replay them.
      [
        '0105',
        new Set(['0105_bootstrap_token_consumes.sql', '0105_debug_diagnosis_canonical_status.sql']),
      ],
      ['0106', new Set(['0106_diagnostic_incidents.sql', '0106_node_agent_version.sql'])],
      // Same situation: 0112_deployment_release_status_updated_at.sql was applied to
      // staging on 2026-08-16 (d1_migrations id 134) from PR #1837's branch, before
      // 0112_session_snapshot_direct_upload_authorization.sql landed on main under the
      // same prefix. Staging's ledger records the exact applied filename, so renumbering
      // it would replay ALTER TABLE deployment_releases ADD COLUMN status_updated_at
      // against a table that already has the column and abort the migration step.
      [
        '0112',
        new Set([
          '0112_session_snapshot_direct_upload_authorization.sql',
          '0112_deployment_release_status_updated_at.sql',
        ]),
      ],
    ]),
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

export function isAllowedDuplicateSet(dir: string, prefix: string, files: string[]): boolean {
  const expected = LEGACY_ALLOWED_DUPLICATE_FILES.get(repoRelative(dir))?.get(prefix);
  if (!expected || expected.size !== files.length) return false;
  return files.every((file) => expected.has(file));
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

  for (const [prefix, files] of byPrefix) {
    if (files.length <= 1) continue;
    if (isAllowedDuplicateSet(dir, prefix, files)) continue;
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
