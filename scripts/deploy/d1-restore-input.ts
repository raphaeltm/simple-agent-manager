#!/usr/bin/env tsx
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type D1RestoreEnvironment = 'staging' | 'production';
export type D1RestoreDatabaseSelection = 'main' | 'observability' | 'both';
export type D1RestorePointKind = 'timestamp' | 'bookmark';

export interface D1RestoreDispatch {
  kind: D1RestorePointKind;
  value: string;
  wranglerArgument: string;
  environment: D1RestoreEnvironment;
  database: D1RestoreDatabaseSelection;
  dryRun: boolean;
  recoveryWindowDays: number;
}

export interface D1RestoreCommandOptions {
  cwd?: string;
}

export interface D1RestoreCommandRunner {
  executeJson(command: string, args: string[], options?: D1RestoreCommandOptions): unknown;
  execute(command: string, args: string[], options?: D1RestoreCommandOptions): void;
}

export interface D1RestoreTarget {
  label: 'main' | 'observability';
  databaseName: string;
}

export interface D1BookmarkWindow {
  oldestBookmark: string;
  currentBookmark: string;
}

export interface D1RestorePreflightResult extends D1RestoreTarget {
  targetBookmark: string;
  oldestBookmark?: string;
  currentBookmark?: string;
}

export interface D1RestoreResult extends D1RestoreTarget {
  bookmark: string;
  previousBookmark: string;
  message?: string;
}

export class D1RestoreInputError extends Error {}

const APPS_API_DIR = resolve(import.meta.dirname, '../../apps/api');
const DEFAULT_RECOVERY_WINDOW_DAYS = 30;
const MAX_RECOVERY_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1_000;
// D1 Time Travel resolves restore points at minute granularity. Stay one full
// provider minute inside the moving retention boundary so the subsequent
// Wrangler process cannot reject the lookup merely because its clock advanced.
const BOOKMARK_WINDOW_BOUNDARY_SAFETY_MS = 60 * 1_000;
const UNIX_SECONDS_PATTERN = /^\d{10}$/;
const BOOKMARK_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{32}$/;
const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/;

class ExecD1RestoreCommandRunner implements D1RestoreCommandRunner {
  executeJson(command: string, args: string[], options: D1RestoreCommandOptions = {}): unknown {
    const output = execFileSync(command, args, {
      cwd: options.cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    return JSON.parse(output);
  }

  execute(command: string, args: string[], options: D1RestoreCommandOptions = {}): void {
    execFileSync(command, args, {
      cwd: options.cwd,
      stdio: 'inherit',
    });
  }
}

function parseRecoveryWindowDays(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new D1RestoreInputError('Invalid D1 recovery window: expected a whole number of days');
  }

  const days = Number(value);
  if (!Number.isSafeInteger(days) || days < 1 || days > MAX_RECOVERY_WINDOW_DAYS) {
    throw new D1RestoreInputError(
      `Invalid D1 recovery window: expected 1 through ${MAX_RECOVERY_WINDOW_DAYS} days`
    );
  }
  return days;
}

function parseTimestamp(value: string, nowMs: number, recoveryWindowDays: number): string | null {
  let timestampMs: number;

  if (UNIX_SECONDS_PATTERN.test(value)) {
    timestampMs = Number(value) * 1_000;
  } else {
    const match = RFC3339_PATTERN.exec(value);
    if (!match) {
      return null;
    }

    const [, yearValue, monthValue, dayValue, hourValue, minuteValue, secondValue] = match;
    const year = Number(yearValue);
    const month = Number(monthValue);
    const day = Number(dayValue);
    const hour = Number(hourValue);
    const minute = Number(minuteValue);
    const second = Number(secondValue);
    const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
    const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);
    const daysInMonth =
      month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;

    if (
      day < 1 ||
      day > daysInMonth ||
      hour > 23 ||
      minute > 59 ||
      second > 59 ||
      offsetHour > 23 ||
      offsetMinute > 59
    ) {
      throw new D1RestoreInputError(
        'Invalid restore timestamp: date or time component is out of range'
      );
    }

    timestampMs = Date.parse(value);
  }

  if (!Number.isFinite(timestampMs)) {
    throw new D1RestoreInputError('Invalid restore timestamp');
  }
  if (timestampMs > nowMs) {
    throw new D1RestoreInputError('Restore timestamp must not be in the future');
  }
  if (timestampMs < nowMs - recoveryWindowDays * DAY_MS) {
    throw new D1RestoreInputError(
      `Restore timestamp must be within the configured ${recoveryWindowDays}-day recovery window`
    );
  }

  return value;
}

function parseEnvironment(value: string): D1RestoreEnvironment {
  if (value !== 'staging' && value !== 'production') {
    throw new D1RestoreInputError('Invalid restore environment');
  }
  return value;
}

function parseDatabaseSelection(value: string): D1RestoreDatabaseSelection {
  if (value !== 'main' && value !== 'observability' && value !== 'both') {
    throw new D1RestoreInputError('Invalid restore database selection');
  }
  return value;
}

function parseDryRun(value: string): boolean {
  if (value !== 'true' && value !== 'false') {
    throw new D1RestoreInputError('Invalid dry run value');
  }
  return value === 'true';
}

function parseRestorePoint(
  value: string,
  nowMs: number,
  recoveryWindowDays: number
): Pick<D1RestoreDispatch, 'kind' | 'value' | 'wranglerArgument'> {
  if (BOOKMARK_PATTERN.test(value)) {
    return { kind: 'bookmark', value, wranglerArgument: `--bookmark=${value}` };
  }

  const timestamp = parseTimestamp(value, nowMs, recoveryWindowDays);
  if (timestamp !== null) {
    return { kind: 'timestamp', value: timestamp, wranglerArgument: `--timestamp=${timestamp}` };
  }

  throw new D1RestoreInputError(
    'Invalid restore point: expected Unix seconds, an RFC3339 date-time with timezone, or a D1 bookmark'
  );
}

export function parseD1RestoreDispatch(
  raw: {
    restorePoint: string;
    environment: string;
    database: string;
    dryRun: string;
    recoveryWindowDays?: string;
  },
  options: { nowMs?: number } = {}
): D1RestoreDispatch {
  const recoveryWindowDays = parseRecoveryWindowDays(
    raw.recoveryWindowDays ?? String(DEFAULT_RECOVERY_WINDOW_DAYS)
  );
  const restorePoint = parseRestorePoint(
    raw.restorePoint,
    options.nowMs ?? Date.now(),
    recoveryWindowDays
  );

  return {
    ...restorePoint,
    environment: parseEnvironment(raw.environment),
    database: parseDatabaseSelection(raw.database),
    dryRun: parseDryRun(raw.dryRun),
    recoveryWindowDays,
  };
}

function parseValidatedDispatchFromEnv(environment: NodeJS.ProcessEnv): D1RestoreDispatch {
  const kind = environment.D1_RESTORE_KIND;
  const value = environment.D1_RESTORE_VALUE ?? '';
  const recoveryWindowDays = parseRecoveryWindowDays(
    environment.D1_RESTORE_RECOVERY_WINDOW_DAYS ?? String(DEFAULT_RECOVERY_WINDOW_DAYS)
  );

  if (kind !== 'timestamp' && kind !== 'bookmark') {
    throw new D1RestoreInputError('Validated restore point kind is missing or invalid');
  }
  const restorePoint = parseRestorePoint(value, Date.now(), recoveryWindowDays);
  if (restorePoint.kind !== kind) {
    throw new D1RestoreInputError('Validated restore point kind does not match its value');
  }

  return {
    kind,
    value: restorePoint.value,
    wranglerArgument: restorePoint.wranglerArgument,
    environment: parseEnvironment(environment.D1_RESTORE_ENVIRONMENT ?? ''),
    database: parseDatabaseSelection(environment.D1_RESTORE_DATABASE ?? ''),
    dryRun: parseDryRun(environment.D1_RESTORE_DRY_RUN ?? ''),
    recoveryWindowDays,
  };
}

function parseDatabaseName(value: string | undefined, label: string): string {
  const hasControlCharacter = [...(value ?? '')].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (!value || value.trim().length === 0 || value.startsWith('-') || hasControlCharacter) {
    throw new D1RestoreInputError(`Invalid ${label} D1 database name`);
  }
  return value;
}

export function selectD1RestoreTargets(
  selection: D1RestoreDatabaseSelection,
  mainDatabaseName: string,
  observabilityDatabaseName: string
): D1RestoreTarget[] {
  if (selection === 'main') {
    return [{ label: 'main', databaseName: parseDatabaseName(mainDatabaseName, 'main') }];
  }
  if (selection === 'observability') {
    return [
      {
        label: 'observability',
        databaseName: parseDatabaseName(observabilityDatabaseName, 'observability'),
      },
    ];
  }
  return [
    { label: 'main', databaseName: parseDatabaseName(mainDatabaseName, 'main') },
    {
      label: 'observability',
      databaseName: parseDatabaseName(observabilityDatabaseName, 'observability'),
    },
  ];
}

export function buildWranglerTimeTravelArgs(
  operation: 'info' | 'restore',
  databaseName: string,
  restoreArgument?: string
): string[] {
  const args = ['exec', 'wrangler', 'd1', 'time-travel', operation, databaseName];
  if (restoreArgument) args.push(restoreArgument);
  args.push('--json');
  return args;
}

function parseBookmarkResponse(value: unknown): string {
  const bookmark =
    typeof value === 'object' && value !== null && 'bookmark' in value
      ? (value as { bookmark?: unknown }).bookmark
      : undefined;
  if (typeof bookmark !== 'string' || !BOOKMARK_PATTERN.test(bookmark)) {
    throw new D1RestoreInputError('Wrangler returned an invalid D1 bookmark');
  }
  return bookmark;
}

export function verifyBookmarkRecoveryWindow(options: {
  bookmark: string;
  databaseName: string;
  environment: D1RestoreEnvironment;
  recoveryWindowDays: number;
  nowMs?: number;
  runner: D1RestoreCommandRunner;
}): D1BookmarkWindow {
  if (!BOOKMARK_PATTERN.test(options.bookmark)) {
    throw new D1RestoreInputError('Validated D1 bookmark is invalid');
  }

  const oldestTimestamp = new Date(
    (options.nowMs ?? Date.now()) -
      options.recoveryWindowDays * DAY_MS +
      BOOKMARK_WINDOW_BOUNDARY_SAFETY_MS
  ).toISOString();
  const oldestBookmark = parseBookmarkResponse(
    options.runner.executeJson(
      'pnpm',
      buildWranglerTimeTravelArgs('info', options.databaseName, `--timestamp=${oldestTimestamp}`),
      { cwd: APPS_API_DIR }
    )
  );
  const currentBookmark = parseBookmarkResponse(
    options.runner.executeJson('pnpm', buildWranglerTimeTravelArgs('info', options.databaseName), {
      cwd: APPS_API_DIR,
    })
  );

  if (options.bookmark < oldestBookmark) {
    throw new D1RestoreInputError('D1 bookmark is older than the configured recovery window');
  }
  if (options.bookmark > currentBookmark) {
    throw new D1RestoreInputError('D1 bookmark is newer than the current database bookmark');
  }

  return { oldestBookmark, currentBookmark };
}

export function preflightD1Restore(options: {
  dispatch: D1RestoreDispatch;
  mainDatabaseName: string;
  observabilityDatabaseName: string;
  runner: D1RestoreCommandRunner;
  nowMs?: number;
}): D1RestorePreflightResult[] {
  const targets = selectD1RestoreTargets(
    options.dispatch.database,
    options.mainDatabaseName,
    options.observabilityDatabaseName
  );

  return targets.map((target) => {
    if (options.dispatch.kind === 'bookmark') {
      const window = verifyBookmarkRecoveryWindow({
        bookmark: options.dispatch.value,
        databaseName: target.databaseName,
        environment: options.dispatch.environment,
        recoveryWindowDays: options.dispatch.recoveryWindowDays,
        nowMs: options.nowMs,
        runner: options.runner,
      });
      return { ...target, targetBookmark: options.dispatch.value, ...window };
    }

    const targetBookmark = parseBookmarkResponse(
      options.runner.executeJson(
        'pnpm',
        buildWranglerTimeTravelArgs('info', target.databaseName, options.dispatch.wranglerArgument),
        { cwd: APPS_API_DIR }
      )
    );
    return { ...target, targetBookmark };
  });
}

export function restoreD1Databases(options: {
  dispatch: D1RestoreDispatch;
  mainDatabaseName: string;
  observabilityDatabaseName: string;
  runner: D1RestoreCommandRunner;
}): D1RestoreResult[] {
  if (options.dispatch.dryRun) {
    throw new D1RestoreInputError('Refusing to restore databases while dry run is enabled');
  }

  const targets = selectD1RestoreTargets(
    options.dispatch.database,
    options.mainDatabaseName,
    options.observabilityDatabaseName
  );

  return targets.map((target) => {
    const response = options.runner.executeJson(
      'pnpm',
      buildWranglerTimeTravelArgs(
        'restore',
        target.databaseName,
        options.dispatch.wranglerArgument
      ),
      { cwd: APPS_API_DIR }
    );
    const bookmark = parseBookmarkResponse(response);
    const previousBookmark =
      typeof response === 'object' && response !== null && 'previous_bookmark' in response
        ? (response as { previous_bookmark?: unknown }).previous_bookmark
        : undefined;
    if (typeof previousBookmark !== 'string' || !BOOKMARK_PATTERN.test(previousBookmark)) {
      throw new D1RestoreInputError('Wrangler restore response omitted a valid previous bookmark');
    }
    const message =
      typeof response === 'object' && response !== null && 'message' in response
        ? (response as { message?: unknown }).message
        : undefined;
    return {
      ...target,
      bookmark,
      previousBookmark,
      ...(typeof message === 'string' ? { message } : {}),
    };
  });
}

function dispatchInputFromEnvironment(environment: NodeJS.ProcessEnv): D1RestoreDispatch {
  return parseD1RestoreDispatch({
    restorePoint: environment.D1_RESTORE_POINT ?? '',
    environment: environment.D1_RESTORE_ENVIRONMENT ?? '',
    database: environment.D1_RESTORE_DATABASE ?? '',
    dryRun: environment.D1_RESTORE_DRY_RUN ?? '',
    recoveryWindowDays:
      environment.D1_RESTORE_RECOVERY_WINDOW_DAYS ?? String(DEFAULT_RECOVERY_WINDOW_DAYS),
  });
}

function writeValidationOutputs(dispatch: D1RestoreDispatch, outputPath: string | undefined): void {
  if (!outputPath) {
    throw new D1RestoreInputError('GITHUB_OUTPUT is required for restore input validation');
  }
  const outputs = [
    ['kind', dispatch.kind],
    ['value', dispatch.value],
    ['environment', dispatch.environment],
    ['database', dispatch.database],
    ['dry_run', String(dispatch.dryRun)],
    ['recovery_window_days', String(dispatch.recoveryWindowDays)],
  ];
  appendFileSync(outputPath, `${outputs.map(([key, value]) => `${key}=${value}`).join('\n')}\n`, {
    encoding: 'utf8',
  });
}

function databaseNamesFromEnvironment(environment: NodeJS.ProcessEnv): {
  mainDatabaseName: string;
  observabilityDatabaseName: string;
} {
  return {
    mainDatabaseName: environment.D1_MAIN_DATABASE_NAME ?? '',
    observabilityDatabaseName: environment.D1_OBSERVABILITY_DATABASE_NAME ?? '',
  };
}

function runCli(argv: string[], environment: NodeJS.ProcessEnv): void {
  const command = argv[0];
  const runner = new ExecD1RestoreCommandRunner();

  if (command === 'validate') {
    writeValidationOutputs(dispatchInputFromEnvironment(environment), environment.GITHUB_OUTPUT);
    console.log('D1 restore dispatch input validated.');
    return;
  }

  const dispatch = parseValidatedDispatchFromEnv(environment);
  const databaseNames = databaseNamesFromEnvironment(environment);
  if (command === 'preflight') {
    console.log(
      JSON.stringify(preflightD1Restore({ dispatch, ...databaseNames, runner }), null, 2)
    );
    return;
  }
  if (command === 'restore') {
    console.log(
      JSON.stringify(restoreD1Databases({ dispatch, ...databaseNames, runner }), null, 2)
    );
    return;
  }

  throw new D1RestoreInputError('Usage: d1-restore-input.ts <validate|preflight|restore>');
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    runCli(process.argv.slice(2), process.env);
  } catch (error) {
    const message =
      error instanceof D1RestoreInputError
        ? error.message
        : 'D1 restore validation or operation failed';
    console.error(`::error title=D1 restore blocked::${message}`);
    process.exitCode = 1;
  }
}
