import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  buildWranglerTimeTravelArgs,
  type D1RestoreCommandRunner,
  D1RestoreInputError,
  parseD1RestoreDispatch,
  preflightD1Restore,
  restoreD1Databases,
  verifyBookmarkRecoveryWindow,
} from '../deploy/d1-restore-input';

const NOW = Date.parse('2026-08-12T12:00:00.000Z');
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000;
const VALID_BOOKMARK = '00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683';
const CURRENT_BOOKMARK = '00000090-00000000-00000000-00000000000000000000000000000000';
const PREVIOUS_BOOKMARK = '00000091-00000000-00000000-00000000000000000000000000000000';

function validRaw(overrides: Record<string, string> = {}) {
  return {
    restorePoint: '2026-08-07T06:16:19Z',
    environment: 'production',
    database: 'both',
    dryRun: 'true',
    recoveryWindowDays: '30',
    ...overrides,
  };
}

describe('D1 restore dispatch input validation', () => {
  it.each([
    ['Unix seconds', String(Math.floor((NOW - 60_000) / 1_000))],
    ['RFC3339 UTC without fractions', '2026-08-07T06:16:19Z'],
    ['JavaScript date-time with milliseconds', '2026-08-07T06:16:19.123Z'],
    ['RFC3339 with positive offset', '2026-08-07T08:46:19+02:30'],
    ['RFC3339 with negative offset', '2026-08-07T01:16:19.123456789-05:00'],
  ])('accepts a documented %s timestamp', (_label, restorePoint) => {
    expect(parseD1RestoreDispatch(validRaw({ restorePoint }), { nowMs: NOW })).toMatchObject({
      kind: 'timestamp',
      value: restorePoint,
      wranglerArgument: `--timestamp=${restorePoint}`,
      environment: 'production',
      database: 'both',
      dryRun: true,
      recoveryWindowDays: 30,
    });
  });

  it('accepts the exact documented D1 bookmark form', () => {
    expect(
      parseD1RestoreDispatch(validRaw({ restorePoint: VALID_BOOKMARK }), { nowMs: NOW })
    ).toMatchObject({
      kind: 'bookmark',
      value: VALID_BOOKMARK,
      wranglerArgument: `--bookmark=${VALID_BOOKMARK}`,
    });
  });

  it('accepts both database targets and strict dry-run values', () => {
    expect(
      parseD1RestoreDispatch(
        validRaw({ database: 'main', dryRun: 'false', environment: 'staging' }),
        { nowMs: NOW }
      )
    ).toMatchObject({ database: 'main', dryRun: false, environment: 'staging' });
    expect(
      parseD1RestoreDispatch(validRaw({ database: 'observability' }), { nowMs: NOW })
    ).toMatchObject({ database: 'observability' });
  });

  it('accepts the exact recovery-window boundary and a configurable narrower window', () => {
    const boundary = new Date(NOW - THIRTY_DAYS_MS).toISOString();
    expect(parseD1RestoreDispatch(validRaw({ restorePoint: boundary }), { nowMs: NOW }).value).toBe(
      boundary
    );

    const sevenDayPoint = new Date(NOW - 7 * 24 * 60 * 60 * 1_000).toISOString();
    expect(
      parseD1RestoreDispatch(validRaw({ restorePoint: sevenDayPoint, recoveryWindowDays: '7' }), {
        nowMs: NOW,
      }).recoveryWindowDays
    ).toBe(7);
  });

  it('accepts a valid leap-day timestamp and rejects the same date in a non-leap year', () => {
    const leapNow = Date.parse('2024-03-01T12:00:00Z');
    expect(
      parseD1RestoreDispatch(validRaw({ restorePoint: '2024-02-29T12:00:00Z' }), {
        nowMs: leapNow,
      }).value
    ).toBe('2024-02-29T12:00:00Z');
    expect(() =>
      parseD1RestoreDispatch(validRaw({ restorePoint: '2025-02-29T12:00:00Z' }), {
        nowMs: Date.parse('2025-03-01T12:00:00Z'),
      })
    ).toThrow('out of range');
  });

  it('accepts the current Unix second and rejects one second beyond each window boundary', () => {
    const currentSecond = String(Math.floor(NOW / 1_000));
    const oneSecondFuture = String(Math.floor(NOW / 1_000) + 1);
    const oneSecondExpired = String(Math.floor((NOW - THIRTY_DAYS_MS) / 1_000) - 1);

    expect(
      parseD1RestoreDispatch(validRaw({ restorePoint: currentSecond }), { nowMs: NOW }).value
    ).toBe(currentSecond);
    expect(() =>
      parseD1RestoreDispatch(validRaw({ restorePoint: oneSecondFuture }), { nowMs: NOW })
    ).toThrow('future');
    expect(() =>
      parseD1RestoreDispatch(validRaw({ restorePoint: oneSecondExpired }), { nowMs: NOW })
    ).toThrow('recovery window');
  });

  it.each([
    ['', 'empty'],
    ['   ', 'whitespace'],
    ['2026-02-30T12:00:00Z', 'impossible calendar date'],
    ['2026-08-07 06:16:19Z', 'space separator'],
    ['2026-08-07T06:16:19', 'missing timezone'],
    ['2026-08-07T24:00:00Z', 'invalid hour'],
    ['2026-08-07T06:60:00Z', 'invalid minute'],
    ['2026-08-07T06:16:60Z', 'invalid second'],
    ['2026-08-07T06:16:19+24:00', 'invalid offset'],
    ['00000085-0000024c-00004c6d-8e61117bf38d7ad', 'truncated bookmark'],
    ['00000085-0000024C-00004c6d-8e61117bf38d7adb71b934ebbf891683', 'uppercase bookmark'],
    ['-1', 'negative Unix timestamp'],
    ['1786536000000', 'milliseconds instead of Unix seconds'],
  ])('rejects %s (%s)', (restorePoint) => {
    expect(() => parseD1RestoreDispatch(validRaw({ restorePoint }), { nowMs: NOW })).toThrow(
      D1RestoreInputError
    );
  });

  it.each([
    '2026-08-07T06:16:19Z; touch /tmp/pwned',
    '2026-08-07T06:16:19Z && id',
    '$(touch /tmp/pwned)',
    '`touch /tmp/pwned`',
    '2026-08-07T06:16:19Z\nmalicious-command',
    '2026-08-07T06:16:19Z\r\nmalicious-command',
    '2026-08-07T06:16:19Z${IFS}&&${IFS}id',
    '2026-08-07T06:16:19Z"; id; echo "',
    `${VALID_BOOKMARK};id`,
  ])('rejects an injection payload before producing an argument: %j', (restorePoint) => {
    expect(() => parseD1RestoreDispatch(validRaw({ restorePoint }), { nowMs: NOW })).toThrow(
      D1RestoreInputError
    );
  });

  it('rejects future and expired timestamps', () => {
    const future = new Date(NOW + 1).toISOString();
    const expired = new Date(NOW - THIRTY_DAYS_MS - 1).toISOString();

    expect(() =>
      parseD1RestoreDispatch(validRaw({ restorePoint: future }), { nowMs: NOW })
    ).toThrow('Restore timestamp must not be in the future');
    expect(() =>
      parseD1RestoreDispatch(validRaw({ restorePoint: expired }), { nowMs: NOW })
    ).toThrow('Restore timestamp must be within the configured 30-day recovery window');
  });

  it.each([
    [{ environment: 'production;id' }, 'environment'],
    [{ environment: 'development' }, 'environment'],
    [{ database: 'main;id' }, 'database'],
    [{ database: 'MAIN' }, 'database'],
    [{ dryRun: 'false;id' }, 'dry run'],
    [{ dryRun: '1' }, 'dry run'],
    [{ recoveryWindowDays: '0' }, 'recovery window'],
    [{ recoveryWindowDays: '31' }, 'recovery window'],
    [{ recoveryWindowDays: '7;id' }, 'recovery window'],
  ])('rejects an unsafe or unsupported dispatch field: %j', (overrides, expected) => {
    expect(() => parseD1RestoreDispatch(validRaw(overrides), { nowMs: NOW })).toThrow(expected);
  });
});

describe('D1 Time Travel command arguments', () => {
  it('builds one inert argument for a timestamp or bookmark without shell parsing', () => {
    expect(
      buildWranglerTimeTravelArgs('info', 'sam-main', '--timestamp=2026-08-07T06:16:19Z')
    ).toEqual([
      'exec',
      'wrangler',
      'd1',
      'time-travel',
      'info',
      'sam-main',
      '--timestamp=2026-08-07T06:16:19Z',
      '--json',
    ]);
    expect(
      buildWranglerTimeTravelArgs('restore', 'sam-observability', `--bookmark=${VALID_BOOKMARK}`)
    ).toEqual([
      'exec',
      'wrangler',
      'd1',
      'time-travel',
      'restore',
      'sam-observability',
      `--bookmark=${VALID_BOOKMARK}`,
      '--json',
    ]);
  });
});

describe('D1 bookmark recovery-window validation', () => {
  function runnerReturning(bookmarks: [string, string]): D1RestoreCommandRunner {
    let index = 0;
    return {
      executeJson: vi.fn(() => ({ bookmark: bookmarks[index++] })),
      execute: vi.fn(),
    };
  }

  it('accepts a bookmark between the per-database oldest and current bookmarks', () => {
    const oldest = '00000080-00000000-00000000-00000000000000000000000000000000';
    const current = '00000090-00000000-00000000-00000000000000000000000000000000';
    const target = '00000085-00000000-00000000-00000000000000000000000000000000';
    const runner = runnerReturning([oldest, current]);

    expect(
      verifyBookmarkRecoveryWindow({
        bookmark: target,
        databaseName: 'sam-main',
        environment: 'production',
        recoveryWindowDays: 30,
        nowMs: NOW,
        runner,
      })
    ).toEqual({ oldestBookmark: oldest, currentBookmark: current });

    expect(runner.executeJson).toHaveBeenNthCalledWith(
      1,
      'pnpm',
      expect.arrayContaining(['info', 'sam-main', '--timestamp=2026-07-13T12:01:00.000Z']),
      expect.objectContaining({ cwd: expect.stringContaining('apps/api') })
    );
  });

  it.each([
    [
      '00000079-ffffffff-ffffffff-ffffffffffffffffffffffffffffffff',
      'older than the recovery window',
    ],
    [
      '00000091-00000000-00000000-00000000000000000000000000000000',
      'newer than the current database bookmark',
    ],
  ])('rejects a bookmark %s when it is %s', (bookmark) => {
    const runner = runnerReturning([
      '00000080-00000000-00000000-00000000000000000000000000000000',
      '00000090-00000000-00000000-00000000000000000000000000000000',
    ]);

    expect(() =>
      verifyBookmarkRecoveryWindow({
        bookmark,
        databaseName: 'sam-main',
        environment: 'production',
        recoveryWindowDays: 30,
        nowMs: NOW,
        runner,
      })
    ).toThrow(D1RestoreInputError);
    expect(runner.execute).not.toHaveBeenCalled();
  });

  it('fails closed on malformed Wrangler bookmark output', () => {
    const runner = runnerReturning(['not-a-bookmark', VALID_BOOKMARK]);
    expect(() =>
      verifyBookmarkRecoveryWindow({
        bookmark: VALID_BOOKMARK,
        databaseName: 'sam-main',
        environment: 'production',
        recoveryWindowDays: 30,
        nowMs: NOW,
        runner,
      })
    ).toThrow('Wrangler returned an invalid D1 bookmark');
  });
});

describe('D1 restore orchestration', () => {
  const mainDatabaseName = 'sam-main';
  const observabilityDatabaseName = 'sam-observability';
  const response = {
    bookmark: '00000090-00000000-00000000-00000000000000000000000000000000',
    previous_bookmark: '00000091-00000000-00000000-00000000000000000000000000000000',
    message: 'Database restored successfully',
  };

  it.each([
    ['main', [mainDatabaseName]],
    ['observability', [observabilityDatabaseName]],
    ['both', [mainDatabaseName, observabilityDatabaseName]],
  ] as const)('preflights exactly the %s target set', (database, expectedTargets) => {
    const runner: D1RestoreCommandRunner = {
      executeJson: vi.fn(() => ({ bookmark: response.bookmark })),
      execute: vi.fn(),
    };
    const dispatch = parseD1RestoreDispatch(validRaw({ database }), { nowMs: NOW });

    expect(
      preflightD1Restore({
        dispatch,
        mainDatabaseName,
        observabilityDatabaseName,
        runner,
        nowMs: NOW,
      }).map((result) => result.databaseName)
    ).toEqual(expectedTargets);
    expect(runner.executeJson).toHaveBeenCalledTimes(expectedTargets.length);
  });

  it('preserves printable provider names and ignores an invalid unselected target', () => {
    const runner: D1RestoreCommandRunner = {
      executeJson: vi.fn(() => ({ bookmark: response.bookmark })),
      execute: vi.fn(),
    };
    const dispatch = parseD1RestoreDispatch(validRaw({ database: 'main' }), { nowMs: NOW });

    expect(
      preflightD1Restore({
        dispatch,
        mainDatabaseName: 'SAM production.main (legacy)',
        observabilityDatabaseName: 'invalid\nunused',
        runner,
        nowMs: NOW,
      })
    ).toMatchObject([{ databaseName: 'SAM production.main (legacy)' }]);
  });

  it('rejects control characters and option-like names on the selected target', () => {
    const runner: D1RestoreCommandRunner = {
      executeJson: vi.fn(() => ({ bookmark: response.bookmark })),
      execute: vi.fn(),
    };
    const dispatch = parseD1RestoreDispatch(validRaw({ database: 'main' }), { nowMs: NOW });

    for (const mainDatabaseName of ['sam\nmain', '--config']) {
      expect(() =>
        preflightD1Restore({
          dispatch,
          mainDatabaseName,
          observabilityDatabaseName: 'unused',
          runner,
          nowMs: NOW,
        })
      ).toThrow('Invalid main D1 database name');
    }
    expect(runner.executeJson).not.toHaveBeenCalled();
  });

  it.each(['main', 'observability', 'both'] as const)(
    'performs no restore for a %s dry run',
    (database) => {
      const runner: D1RestoreCommandRunner = {
        executeJson: vi.fn(() => response),
        execute: vi.fn(),
      };
      const dispatch = parseD1RestoreDispatch(validRaw({ database, dryRun: 'true' }), {
        nowMs: NOW,
      });

      expect(() =>
        restoreD1Databases({ dispatch, mainDatabaseName, observabilityDatabaseName, runner })
      ).toThrow('dry run is enabled');
      expect(runner.executeJson).not.toHaveBeenCalled();
    }
  );

  it('restores both exact targets with inert arguments and preserves undo evidence', () => {
    const runner: D1RestoreCommandRunner = {
      executeJson: vi.fn(() => response),
      execute: vi.fn(),
    };
    const dispatch = parseD1RestoreDispatch(validRaw({ database: 'both', dryRun: 'false' }), {
      nowMs: NOW,
    });

    const results = restoreD1Databases({
      dispatch,
      mainDatabaseName,
      observabilityDatabaseName,
      runner,
    });

    expect(results.map(({ databaseName }) => databaseName)).toEqual([
      mainDatabaseName,
      observabilityDatabaseName,
    ]);
    expect(
      results.every(({ previousBookmark }) => previousBookmark === response.previous_bookmark)
    ).toBe(true);
    expect(runner.executeJson).toHaveBeenNthCalledWith(
      1,
      'pnpm',
      expect.arrayContaining(['restore', mainDatabaseName, dispatch.wranglerArgument, '--json']),
      expect.objectContaining({ cwd: expect.stringContaining('apps/api') })
    );
    expect(runner.executeJson).toHaveBeenNthCalledWith(
      2,
      'pnpm',
      expect.arrayContaining([
        'restore',
        observabilityDatabaseName,
        dispatch.wranglerArgument,
        '--json',
      ]),
      expect.objectContaining({ cwd: expect.stringContaining('apps/api') })
    );
  });
});

describe('D1 restore validator CLI boundary', () => {
  const scriptPath = new URL('../deploy/d1-restore-input.ts', import.meta.url);
  const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
  const tsxPath = fileURLToPath(new URL('../../node_modules/.bin/tsx', import.meta.url));

  it('writes only validated single-line values to GITHUB_OUTPUT', () => {
    const directory = mkdtempSync(join(tmpdir(), 'd1-restore-valid-'));
    const outputPath = join(directory, 'github-output');
    const restorePoint = new Date(Date.now() - 60_000).toISOString();

    execFileSync(tsxPath, [scriptPath.pathname, 'validate'], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        D1_RESTORE_POINT: restorePoint,
        D1_RESTORE_ENVIRONMENT: 'production',
        D1_RESTORE_DATABASE: 'both',
        D1_RESTORE_DRY_RUN: 'true',
        D1_RESTORE_RECOVERY_WINDOW_DAYS: '30',
        GITHUB_OUTPUT: outputPath,
      },
      stdio: 'pipe',
    });

    expect(readFileSync(outputPath, 'utf8')).toBe(
      `kind=timestamp\nvalue=${restorePoint}\nenvironment=production\ndatabase=both\ndry_run=true\nrecovery_window_days=30\n`
    );
  });

  it.each([
    '2026-08-07T06:16:19Z; touch D1_RESTORE_CANARY',
    '2026-08-07T06:16:19Z && touch D1_RESTORE_CANARY',
    '$(touch D1_RESTORE_CANARY)',
    '`touch D1_RESTORE_CANARY`',
    '2026-08-07T06:16:19Z\n::error::forged',
    '2026-08-07T06:16:19Z|touch D1_RESTORE_CANARY',
    '2026-08-07T06:16:19Z> D1_RESTORE_CANARY',
    '--bookmark=00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683',
    '2026-08-07T06:16:19Z || touch D1_RESTORE_CANARY',
    '2026-08-07T06:16:19Z${IFS}touch${IFS}D1_RESTORE_CANARY',
    '2026-08-07T06:16:19Z*',
    '2026-08-07T06:16:19Z\\',
    '2026-08-07T06:16:19Z%0Atouch%20D1_RESTORE_CANARY',
  ])('rejects an adversarial payload through the real CLI without executing it: %j', (payload) => {
    const directory = mkdtempSync(join(tmpdir(), 'd1-restore-invalid-'));
    const outputPath = join(directory, 'github-output');
    const canaryPath = join(directory, 'D1_RESTORE_CANARY');
    const fixturePayload = payload.replaceAll('D1_RESTORE_CANARY', canaryPath);
    const result = spawnSync(tsxPath, [scriptPath.pathname, 'validate'], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        D1_RESTORE_POINT: fixturePayload,
        D1_RESTORE_ENVIRONMENT: 'production',
        D1_RESTORE_DATABASE: 'both',
        D1_RESTORE_DRY_RUN: 'true',
        D1_RESTORE_RECOVERY_WINDOW_DAYS: '30',
        GITHUB_OUTPUT: outputPath,
      },
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain(fixturePayload);
    expect(existsSync(outputPath)).toBe(false);
    expect(existsSync(canaryPath)).toBe(false);
  });

  it.each([
    ['D1_RESTORE_ENVIRONMENT', 'production; touch D1_RESTORE_CANARY'],
    ['D1_RESTORE_DATABASE', 'both$(touch D1_RESTORE_CANARY)'],
    ['D1_RESTORE_DRY_RUN', 'true\n::error::forged'],
    ['D1_RESTORE_RECOVERY_WINDOW_DAYS', '30 && touch D1_RESTORE_CANARY'],
  ])('rejects an adversarial %s value through the real CLI', (field, payload) => {
    const directory = mkdtempSync(join(tmpdir(), 'd1-restore-field-invalid-'));
    const outputPath = join(directory, 'github-output');
    const canaryPath = join(directory, 'D1_RESTORE_CANARY');
    const fixturePayload = payload.replaceAll('D1_RESTORE_CANARY', canaryPath);
    const environment = {
      ...process.env,
      D1_RESTORE_POINT: new Date(Date.now() - 60_000).toISOString(),
      D1_RESTORE_ENVIRONMENT: 'production',
      D1_RESTORE_DATABASE: 'both',
      D1_RESTORE_DRY_RUN: 'true',
      D1_RESTORE_RECOVERY_WINDOW_DAYS: '30',
      GITHUB_OUTPUT: outputPath,
      [field]: fixturePayload,
    };

    const result = spawnSync(tsxPath, [scriptPath.pathname, 'validate'], {
      cwd: repositoryRoot,
      env: environment,
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain(fixturePayload);
    expect(existsSync(outputPath)).toBe(false);
    expect(existsSync(canaryPath)).toBe(false);
  });

  function executableCliFixture() {
    const directory = mkdtempSync(join(tmpdir(), 'd1-restore-cli-'));
    const pnpmPath = join(directory, 'pnpm');
    const argvPath = join(directory, 'argv.jsonl');
    writeFileSync(
      pnpmPath,
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.D1_TEST_ARGV_PATH, JSON.stringify(args) + '\\n');
if (args.includes('restore')) {
  const result = process.env.D1_TEST_RESPONSE_MODE === 'missing-previous'
    ? { bookmark: '${CURRENT_BOOKMARK}' }
    : { bookmark: '${CURRENT_BOOKMARK}', previous_bookmark: '${PREVIOUS_BOOKMARK}', message: 'restored' };
  process.stdout.write(JSON.stringify(result));
} else {
  process.stdout.write(JSON.stringify({ bookmark: '${CURRENT_BOOKMARK}' }));
}
`,
      'utf8'
    );
    chmodSync(pnpmPath, 0o755);
    return { directory, argvPath };
  }

  function runOperationalCli(
    command: 'preflight' | 'restore',
    database: 'main' | 'observability' | 'both',
    dryRun: boolean,
    fixture: ReturnType<typeof executableCliFixture>,
    extraEnvironment: NodeJS.ProcessEnv = {}
  ) {
    return spawnSync(tsxPath, [scriptPath.pathname, command], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        PATH: `${fixture.directory}:${process.env.PATH ?? ''}`,
        D1_TEST_ARGV_PATH: fixture.argvPath,
        D1_RESTORE_KIND: 'timestamp',
        D1_RESTORE_VALUE: new Date(Date.now() - 60_000).toISOString(),
        D1_RESTORE_ENVIRONMENT: 'production',
        D1_RESTORE_DATABASE: database,
        D1_RESTORE_DRY_RUN: String(dryRun),
        D1_RESTORE_RECOVERY_WINDOW_DAYS: '30',
        D1_MAIN_DATABASE_NAME: 'SAM production.main (legacy)',
        D1_OBSERVABILITY_DATABASE_NAME: 'SAM production.observability (legacy)',
        ...extraEnvironment,
      },
      encoding: 'utf8',
    });
  }

  it.each([
    ['main', ['SAM production.main (legacy)']],
    ['observability', ['SAM production.observability (legacy)']],
    ['both', ['SAM production.main (legacy)', 'SAM production.observability (legacy)']],
  ] as const)('executes preflight for exactly the %s target set', (database, expectedTargets) => {
    const fixture = executableCliFixture();
    const result = runOperationalCli('preflight', database, true, fixture);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject(
      expectedTargets.map((databaseName) => ({ databaseName, targetBookmark: CURRENT_BOOKMARK }))
    );
    const calls = readFileSync(fixture.argvPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
    expect(calls.map((args) => args[5])).toEqual(expectedTargets);
    expect(calls.every((args) => args.includes('--json'))).toBe(true);
  });

  it.each([
    ['main', ['SAM production.main (legacy)']],
    ['observability', ['SAM production.observability (legacy)']],
    ['both', ['SAM production.main (legacy)', 'SAM production.observability (legacy)']],
  ] as const)(
    'executes restore for exactly the %s target set with undo evidence',
    (database, expectedTargets) => {
      const fixture = executableCliFixture();
      const result = runOperationalCli('restore', database, false, fixture);

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject(
        expectedTargets.map((databaseName) => ({
          databaseName,
          previousBookmark: PREVIOUS_BOOKMARK,
        }))
      );
      const calls = readFileSync(fixture.argvPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[]);
      expect(calls.map((args) => args[5])).toEqual(expectedTargets);
    }
  );

  it.each(['main', 'observability', 'both'] as const)(
    'blocks executable restore for a %s dry run before invoking Wrangler',
    (database) => {
      const fixture = executableCliFixture();
      const result = runOperationalCli('restore', database, true, fixture);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('dry run is enabled');
      expect(existsSync(fixture.argvPath)).toBe(false);
    }
  );

  it('fails closed when executable restore output omits the undo bookmark', () => {
    const fixture = executableCliFixture();
    const result = runOperationalCli('restore', 'main', false, fixture, {
      D1_TEST_RESPONSE_MODE: 'missing-previous',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('omitted a valid previous bookmark');
    expect(result.stdout).toBe('');
  });
});
