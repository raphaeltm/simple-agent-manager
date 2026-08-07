#!/usr/bin/env tsx
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface D1DatabaseTarget {
  binding: string;
  name: string;
}

export interface D1TableCount {
  database: string;
  binding: string;
  table: string;
  count: number;
}

export interface CountDecreaseAllowlistEntry {
  database: string;
  table: string;
  reviewedBy: string;
  reason: string;
}

export interface D1MigrationSafetyRunner {
  executeJson(command: string, args: string[], options?: { cwd?: string }): unknown;
  execute(
    command: string,
    args: string[],
    options?: { cwd?: string; stdio?: 'inherit' | 'pipe' }
  ): void;
  nowIso(): string;
}

export interface SafeRemoteMigrationOptions {
  environment: string;
  databases: D1DatabaseTarget[];
  allowlist?: CountDecreaseAllowlistEntry[];
  cwd?: string;
  runner: D1MigrationSafetyRunner;
}

const APPS_API_DIR = resolve(import.meta.dirname, '../../apps/api');
const WRANGLER_COMMAND = 'pnpm';

const SYSTEM_TABLES = new Set(['_cf_KV', 'd1_migrations', 'sqlite_sequence']);

export class MigrationSafetyError extends Error {}

function quoteSqlIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export class ExecD1MigrationSafetyRunner implements D1MigrationSafetyRunner {
  executeJson(command: string, args: string[], options: { cwd?: string } = {}): unknown {
    const output = execFileSync(command, args, {
      cwd: options.cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(output);
  }

  execute(
    command: string,
    args: string[],
    options: { cwd?: string; stdio?: 'inherit' | 'pipe' } = {}
  ): void {
    execFileSync(command, args, {
      cwd: options.cwd,
      stdio: options.stdio ?? 'inherit',
    });
  }

  nowIso(): string {
    return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
}

function wranglerArgs(environment: string, dbName: string, command: string): string[] {
  return [
    'exec',
    'wrangler',
    'd1',
    'execute',
    dbName,
    '--remote',
    '--env',
    environment,
    '--command',
    command,
    '--json',
  ];
}

function parseD1Rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new MigrationSafetyError('Wrangler D1 JSON response was not an array');
  }

  const results = (value[0] as { results?: unknown } | undefined)?.results;
  if (!Array.isArray(results)) {
    throw new MigrationSafetyError('Wrangler D1 JSON response did not include a results array');
  }

  return results as Record<string, unknown>[];
}

function parseCountValue(value: unknown, db: D1DatabaseTarget, table: string): number {
  const count = typeof value === 'number' ? value : Number(value);

  if (!Number.isSafeInteger(count) || count < 0) {
    throw new MigrationSafetyError(
      `Failed to count ${db.binding}.${table}: invalid count value ${String(value)}`
    );
  }

  return count;
}

export function normalizeDiscoveredTables(rows: Record<string, unknown>[]): string[] {
  return rows
    .map((row) => String(row.name ?? ''))
    .filter((name) => name.length > 0)
    .filter((name) => !name.startsWith('sqlite_'))
    .filter((name) => !SYSTEM_TABLES.has(name))
    .sort((a, b) => a.localeCompare(b));
}

function discoverDatabaseTableNames(
  runner: D1MigrationSafetyRunner,
  environment: string,
  db: D1DatabaseTarget,
  cwd = APPS_API_DIR
): string[] {
  const rows = parseD1Rows(
    runner.executeJson(
      WRANGLER_COMMAND,
      wranglerArgs(
        environment,
        db.name,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      ),
      { cwd }
    )
  );

  return rows
    .map((row) => String(row.name ?? ''))
    .filter((name) => name.length > 0)
    .sort((a, b) => a.localeCompare(b));
}

export function discoverProtectedTables(
  runner: D1MigrationSafetyRunner,
  environment: string,
  db: D1DatabaseTarget,
  cwd = APPS_API_DIR
): string[] {
  const allTables = discoverDatabaseTableNames(runner, environment, db, cwd);
  const tables = normalizeDiscoveredTables(allTables.map((name) => ({ name })));

  if (tables.length === 0) {
    throw new MigrationSafetyError(
      `No protected tables discovered for ${db.binding} (${db.name}); refusing to migrate`
    );
  }

  return tables;
}

export function countProtectedTables(
  runner: D1MigrationSafetyRunner,
  environment: string,
  db: D1DatabaseTarget,
  tables: string[],
  cwd = APPS_API_DIR
): D1TableCount[] {
  return tables.map((table) => {
    let rows: Record<string, unknown>[];
    try {
      rows = parseD1Rows(
        runner.executeJson(
          WRANGLER_COMMAND,
          wranglerArgs(
            environment,
            db.name,
            `SELECT COUNT(*) as count FROM ${quoteSqlIdentifier(table)}`
          ),
          { cwd }
        )
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new MigrationSafetyError(`Failed to count ${db.binding}.${table}: ${message}`);
    }

    if (rows.length !== 1 || !('count' in rows[0])) {
      throw new MigrationSafetyError(`Failed to count ${db.binding}.${table}: missing count row`);
    }

    return {
      database: db.name,
      binding: db.binding,
      table,
      count: parseCountValue(rows[0].count, db, table),
    };
  });
}

export function validateCountDecreaseAllowlist(
  allowlist: CountDecreaseAllowlistEntry[]
): CountDecreaseAllowlistEntry[] {
  const keys = new Set<string>();
  const normalized: CountDecreaseAllowlistEntry[] = [];
  for (const entry of allowlist) {
    if (
      typeof entry.database !== 'string' ||
      !entry.database.trim() ||
      typeof entry.table !== 'string' ||
      !entry.table.trim() ||
      typeof entry.reviewedBy !== 'string' ||
      !entry.reviewedBy.trim() ||
      typeof entry.reason !== 'string' ||
      !entry.reason.trim()
    ) {
      throw new MigrationSafetyError(
        'Every D1 migration decrease allowlist entry requires non-empty string database, table, reviewedBy, and reason fields'
      );
    }

    const normalizedEntry = {
      database: entry.database.trim(),
      table: entry.table.trim(),
      reviewedBy: entry.reviewedBy.trim(),
      reason: entry.reason.trim(),
    };
    const key = `${normalizedEntry.database}:${normalizedEntry.table}`;
    if (keys.has(key)) {
      throw new MigrationSafetyError(`Duplicate D1 migration decrease allowlist entry: ${key}`);
    }
    keys.add(key);
    normalized.push(normalizedEntry);
  }

  return normalized;
}

export function verifyNoUnexpectedProtectedTableDecrease(
  before: D1TableCount[],
  after: D1TableCount[],
  allowlist: CountDecreaseAllowlistEntry[] = []
): void {
  const afterByKey = new Map(after.map((entry) => [`${entry.database}:${entry.table}`, entry]));
  const allowed = new Map(
    validateCountDecreaseAllowlist(allowlist).map((entry) => [
      `${entry.database}:${entry.table}`,
      entry,
    ])
  );
  const failures: string[] = [];

  for (const pre of before) {
    const key = `${pre.database}:${pre.table}`;
    const post = afterByKey.get(key);
    if (!post) {
      failures.push(`${pre.binding}.${pre.table}: missing post-migration count`);
      continue;
    }

    if (post.count < pre.count) {
      const entry = allowed.get(key);
      if (!entry?.reviewedBy || !entry.reason) {
        failures.push(`${pre.binding}.${pre.table}: ${pre.count} -> ${post.count}`);
      }
    }
  }

  if (failures.length > 0) {
    throw new MigrationSafetyError(
      `Protected table row-count decrease detected:\n${failures.join('\n')}`
    );
  }
}

export function applyRemoteMigrations(
  runner: D1MigrationSafetyRunner,
  environment: string,
  db: D1DatabaseTarget,
  cwd = APPS_API_DIR
): void {
  runner.execute(
    WRANGLER_COMMAND,
    ['exec', 'wrangler', 'd1', 'migrations', 'apply', db.name, '--remote', '--env', environment],
    { cwd, stdio: 'inherit' }
  );
}

export function runSafeRemoteMigrations(options: SafeRemoteMigrationOptions): string {
  const cwd = options.cwd ?? APPS_API_DIR;
  const backupTimestamp = options.runner.nowIso();
  const before: D1TableCount[] = [];
  const allowlist = validateCountDecreaseAllowlist(options.allowlist ?? []);

  console.log('Recording D1 time-travel recovery timestamp before migrations...');
  console.log(`Pre-migration timestamp: ${backupTimestamp}`);

  try {
    for (const db of options.databases) {
      const allTables = discoverDatabaseTableNames(options.runner, options.environment, db, cwd);
      const tables = normalizeDiscoveredTables(allTables.map((name) => ({ name })));

      if (tables.length === 0 && allTables.includes('d1_migrations')) {
        throw new MigrationSafetyError(
          `No protected tables discovered for initialized ${db.binding} (${db.name}); refusing to treat an upgrade as a clean install`
        );
      }

      if (tables.length === 0) {
        console.log(
          `Clean install detected for ${db.binding} (${db.name}); initial migrations will create protected tables`
        );
      } else {
        console.log(`Discovered ${tables.length} protected tables in ${db.binding} (${db.name})`);
      }
      before.push(...countProtectedTables(options.runner, options.environment, db, tables, cwd));
    }

    for (const db of options.databases) {
      applyRemoteMigrations(options.runner, options.environment, db, cwd);
    }

    const after: D1TableCount[] = [];
    for (const db of options.databases) {
      const tables = discoverProtectedTables(options.runner, options.environment, db, cwd);
      after.push(...countProtectedTables(options.runner, options.environment, db, tables, cwd));
    }

    verifyNoUnexpectedProtectedTableDecrease(before, after, allowlist);
    console.log('Post-migration data integrity check PASSED. No protected table decreases.');
    return backupTimestamp;
  } catch (error) {
    console.error('POST-MIGRATION DATA INTEGRITY CHECK FAILED — DEPLOY BLOCKED');
    console.error(`Pre-migration timestamp: ${backupTimestamp}`);
    for (const db of options.databases) {
      console.error(
        `Restore ${db.binding}: cd apps/api && pnpm exec wrangler d1 time-travel restore ${db.name} --env ${options.environment} --timestamp=${backupTimestamp}`
      );
    }
    throw error;
  }
}

export function parseAllowlist(json: string | undefined): CountDecreaseAllowlistEntry[] {
  if (!json) return [];
  const parsed = JSON.parse(json) as unknown;
  if (!Array.isArray(parsed)) {
    throw new MigrationSafetyError('D1 migration decrease allowlist must be a JSON array');
  }
  return parsed as CountDecreaseAllowlistEntry[];
}

function parseCliArgs(args: string[]): {
  environment: string;
  databases: D1DatabaseTarget[];
  allowlist: CountDecreaseAllowlistEntry[];
} {
  const envIndex = args.indexOf('--env');
  const environment = envIndex >= 0 ? args[envIndex + 1] : undefined;
  const dbArgs = args.filter((arg) => arg.startsWith('--database='));
  const allowlistIndex = args.indexOf('--allowlist-json');
  const allowlistJson =
    allowlistIndex >= 0 ? args[allowlistIndex + 1] : process.env.D1_MIGRATION_DECREASE_ALLOWLIST;

  if (!environment) {
    throw new MigrationSafetyError('--env <environment> is required');
  }
  if (dbArgs.length === 0) {
    throw new MigrationSafetyError(
      'At least one --database=<binding>:<database-name> argument is required'
    );
  }

  return {
    environment,
    databases: dbArgs.map((arg) => {
      const value = arg.slice('--database='.length);
      const [binding, name] = value.split(':');
      if (!binding || !name) {
        throw new MigrationSafetyError(
          `Invalid database target "${value}". Expected <binding>:<database-name>`
        );
      }
      return { binding, name };
    }),
    allowlist: parseAllowlist(allowlistJson),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    runSafeRemoteMigrations({ ...options, runner: new ExecD1MigrationSafetyRunner() });
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
