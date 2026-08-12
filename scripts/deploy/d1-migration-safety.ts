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
  churningTableSelectors?: string[];
  maxChurningTableDecreasePercent?: number;
  cwd?: string;
  runner: D1MigrationSafetyRunner;
}

const APPS_API_DIR = resolve(import.meta.dirname, '../../apps/api');
const WRANGLER_COMMAND = 'pnpm';
const D1_MIGRATIONS_TABLE = 'd1_migrations';

const SYSTEM_TABLES = new Set(['_cf_KV', D1_MIGRATIONS_TABLE, 'sqlite_sequence']);

export const DEFAULT_D1_MIGRATION_CHURNING_TABLES = [
  'DATABASE.deployment_releases',
  'DATABASE.github_webhook_deliveries',
  'DATABASE.project_files',
  'DATABASE.registry_credential_rate_limits',
  'DATABASE.session_snapshots',
  'DATABASE.sessions',
  'DATABASE.trial_waitlist',
  'DATABASE.trigger_executions',
  'DATABASE.verifications',
  'DATABASE.webhook_deliveries',
  'OBSERVABILITY_DATABASE.platform_errors',
] as const;
export const DEFAULT_D1_MIGRATION_CHURNING_TABLE_MAX_DECREASE_PERCENT = 50;

const REVIEWED_CHURNING_TABLES = new Set<string>(DEFAULT_D1_MIGRATION_CHURNING_TABLES);

export class MigrationSafetyError extends Error {}

/**
 * Wrangler 4.118 can append a human-readable diagnostic after a valid `--json`
 * response. Keep the migration gate fail-closed for leading garbage and
 * malformed JSON while accepting that documented output shape.
 */
export function parseWranglerJsonOutput(output: string): unknown {
  const trimmedStart = output.trimStart();
  const first = trimmedStart[0];
  if (first !== '[' && first !== '{') {
    throw new MigrationSafetyError('Wrangler D1 output did not begin with JSON');
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;

  for (let index = 0; index < trimmedStart.length; index += 1) {
    const character = trimmedStart[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === '[' || character === '{') {
      depth += 1;
    } else if (character === ']' || character === '}') {
      depth -= 1;
      if (depth < 0) {
        throw new MigrationSafetyError('Wrangler D1 output contained malformed JSON');
      }
      if (depth === 0) {
        end = index + 1;
        break;
      }
    }
  }

  if (end < 0 || inString || depth !== 0) {
    throw new MigrationSafetyError('Wrangler D1 output contained incomplete JSON');
  }

  return JSON.parse(trimmedStart.slice(0, end)) as unknown;
}

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
    return parseWranglerJsonOutput(output);
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

function databaseKey(db: D1DatabaseTarget): string {
  return `${db.binding}:${db.name}`;
}

function tableSelector(entry: Pick<D1TableCount, 'binding' | 'table'>): string {
  return `${entry.binding}.${entry.table}`;
}

function validateChurningTableSelectors(selectors: readonly string[]): string[] {
  const normalized = selectors.map((selector) => selector.trim());
  const unique = new Set<string>();

  for (const selector of normalized) {
    if (!selector || !selector.includes('.')) {
      throw new MigrationSafetyError(
        `Invalid D1 churning-table selector "${selector}". Expected <binding>.<table>`
      );
    }
    if (unique.has(selector)) {
      throw new MigrationSafetyError(`Duplicate D1 churning-table selector: ${selector}`);
    }
    if (!REVIEWED_CHURNING_TABLES.has(selector)) {
      throw new MigrationSafetyError(
        `${selector} is not a reviewed churning table and cannot receive a row-count decrease tolerance`
      );
    }
    unique.add(selector);
  }

  return normalized;
}

export function parseChurningTableSelectors(value: string | undefined): string[] {
  if (!value?.trim()) {
    return [...DEFAULT_D1_MIGRATION_CHURNING_TABLES];
  }
  return validateChurningTableSelectors(value.split(','));
}

function validateChurningTableMaxDecreasePercent(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new MigrationSafetyError(
      'D1 churning-table maximum decrease percent must be a number between 0 and 100'
    );
  }
  return value;
}

export function parseChurningTableMaxDecreasePercent(value: string | undefined): number {
  if (!value?.trim()) {
    return DEFAULT_D1_MIGRATION_CHURNING_TABLE_MAX_DECREASE_PERCENT;
  }
  return validateChurningTableMaxDecreasePercent(Number(value));
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

function countAppliedMigrationRecords(
  runner: D1MigrationSafetyRunner,
  environment: string,
  db: D1DatabaseTarget,
  cwd = APPS_API_DIR
): number {
  let rows: Record<string, unknown>[];
  try {
    rows = parseD1Rows(
      runner.executeJson(
        WRANGLER_COMMAND,
        wranglerArgs(
          environment,
          db.name,
          `SELECT COUNT(*) as count FROM ${quoteSqlIdentifier(D1_MIGRATIONS_TABLE)}`
        ),
        { cwd }
      )
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new MigrationSafetyError(`Failed to read ${db.binding} migration ledger: ${message}`);
  }

  if (rows.length !== 1 || !('count' in rows[0])) {
    throw new MigrationSafetyError(
      `Failed to read ${db.binding} migration ledger: missing count row`
    );
  }

  return parseCountValue(rows[0].count, db, D1_MIGRATIONS_TABLE);
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
  allowlist: CountDecreaseAllowlistEntry[] = [],
  churningTableSelectors: readonly string[] = DEFAULT_D1_MIGRATION_CHURNING_TABLES,
  maxChurningTableDecreasePercent = DEFAULT_D1_MIGRATION_CHURNING_TABLE_MAX_DECREASE_PERCENT
): void {
  const afterByKey = new Map(after.map((entry) => [`${entry.database}:${entry.table}`, entry]));
  const allowed = new Map(
    validateCountDecreaseAllowlist(allowlist).map((entry) => [
      `${entry.database}:${entry.table}`,
      entry,
    ])
  );
  const churningTables = new Set(validateChurningTableSelectors(churningTableSelectors));
  const churningDecreaseLimit = validateChurningTableMaxDecreasePercent(
    maxChurningTableDecreasePercent
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
      if (entry?.reviewedBy && entry.reason) {
        continue;
      }

      const selector = tableSelector(pre);
      const decreasePercent = ((pre.count - post.count) / pre.count) * 100;
      if (churningTables.has(selector) && decreasePercent <= churningDecreaseLimit) {
        continue;
      }

      if (churningTables.has(selector)) {
        failures.push(
          `${selector}: ${pre.count} -> ${post.count} (${decreasePercent.toFixed(3)}% decrease exceeds ${churningDecreaseLimit}% churning-table limit)`
        );
      } else {
        failures.push(`${selector}: ${pre.count} -> ${post.count}`);
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
  const churningTableSelectors =
    options.churningTableSelectors === undefined
      ? parseChurningTableSelectors(process.env.D1_MIGRATION_CHURNING_TABLES)
      : validateChurningTableSelectors(options.churningTableSelectors);
  const maxChurningTableDecreasePercent =
    options.maxChurningTableDecreasePercent === undefined
      ? parseChurningTableMaxDecreasePercent(
          process.env.D1_MIGRATION_CHURNING_TABLE_MAX_DECREASE_PERCENT
        )
      : validateChurningTableMaxDecreasePercent(options.maxChurningTableDecreasePercent);
  const migrationCountsBefore = new Map<string, number>();

  console.log('Recording D1 time-travel recovery timestamp before migrations...');
  console.log(`Pre-migration timestamp: ${backupTimestamp}`);

  try {
    for (const db of options.databases) {
      const allTables = discoverDatabaseTableNames(options.runner, options.environment, db, cwd);
      const tables = normalizeDiscoveredTables(allTables.map((name) => ({ name })));

      const hasMigrationLedger = allTables.includes(D1_MIGRATIONS_TABLE);
      if (tables.length === 0 && hasMigrationLedger) {
        throw new MigrationSafetyError(
          `No protected tables discovered for initialized ${db.binding} (${db.name}); refusing to treat an upgrade as a clean install`
        );
      }

      migrationCountsBefore.set(
        databaseKey(db),
        hasMigrationLedger
          ? countAppliedMigrationRecords(options.runner, options.environment, db, cwd)
          : 0
      );

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
    const databasesWithAppliedMigrations = new Set<string>();
    for (const db of options.databases) {
      const allTables = discoverDatabaseTableNames(options.runner, options.environment, db, cwd);
      if (!allTables.includes(D1_MIGRATIONS_TABLE)) {
        throw new MigrationSafetyError(
          `Migration ledger missing after migrations for ${db.binding} (${db.name})`
        );
      }

      const migrationsBefore = migrationCountsBefore.get(databaseKey(db)) ?? 0;
      const migrationsAfter = countAppliedMigrationRecords(
        options.runner,
        options.environment,
        db,
        cwd
      );
      if (migrationsAfter < migrationsBefore) {
        throw new MigrationSafetyError(
          `${db.binding} migration ledger decreased: ${migrationsBefore} -> ${migrationsAfter}`
        );
      }
      if (migrationsAfter === migrationsBefore) {
        console.log(
          `No migrations applied to ${db.binding} (${db.name}); skipping row-count comparison`
        );
        continue;
      }

      const appliedCount = migrationsAfter - migrationsBefore;
      console.log(`Detected ${appliedCount} migration(s) applied to ${db.binding} (${db.name})`);
      databasesWithAppliedMigrations.add(databaseKey(db));
      const tables = normalizeDiscoveredTables(allTables.map((name) => ({ name })));
      if (tables.length === 0) {
        throw new MigrationSafetyError(
          `No protected tables discovered for ${db.binding} (${db.name}); refusing to migrate`
        );
      }
      after.push(...countProtectedTables(options.runner, options.environment, db, tables, cwd));
    }

    if (databasesWithAppliedMigrations.size === 0) {
      console.log(
        'Post-migration data integrity check SKIPPED. No migrations were applied to any database.'
      );
      return backupTimestamp;
    }

    const beforeForMigratedDatabases = before.filter((entry) =>
      databasesWithAppliedMigrations.has(`${entry.binding}:${entry.database}`)
    );
    verifyNoUnexpectedProtectedTableDecrease(
      beforeForMigratedDatabases,
      after,
      allowlist,
      churningTableSelectors,
      maxChurningTableDecreasePercent
    );
    console.log('Post-migration data integrity check PASSED. No unexpected table decreases.');
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
