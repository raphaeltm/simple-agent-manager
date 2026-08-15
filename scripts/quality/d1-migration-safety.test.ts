import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_D1_MIGRATION_CHURNING_TABLE_MAX_DECREASE_PERCENT,
  type D1MigrationSafetyRunner,
  type D1TableCount,
  discoverProtectedTables,
  parseAllowlist,
  parseChurningTableMaxDecreasePercent,
  parseChurningTableSelectors,
  parseWranglerJsonOutput,
  runSafeRemoteMigrations,
  verifyNoUnexpectedProtectedTableDecrease,
} from '../deploy/d1-migration-safety';

class FakeRunner implements D1MigrationSafetyRunner {
  public readonly commands: string[] = [];
  private readonly migrationCountsByDb = new Map<string, number>();

  constructor(
    private readonly tablesByDb: Record<string, string[] | string[][]>,
    private readonly countsByDbAndTable: Record<string, number[]>,
    private readonly pendingMigrationsByDb: Record<string, number> = {}
  ) {
    for (const [database, configuredTables] of Object.entries(tablesByDb)) {
      const firstTables = Array.isArray(configuredTables[0])
        ? (configuredTables[0] as string[])
        : (configuredTables as string[]);
      this.migrationCountsByDb.set(database, firstTables.includes('d1_migrations') ? 100 : 0);
    }
  }

  executeJson(command: string, args: string[]): unknown {
    this.commands.push([command, ...args].join(' '));
    const dbName = args[4];
    const sql = args.at(-2) ?? '';

    if (sql.includes('sqlite_master')) {
      const configured = this.tablesByDb[dbName] as string[] | string[][];
      const tables = Array.isArray(configured[0])
        ? ((configured as string[][]).shift() ?? [])
        : (configured as string[]);
      return [{ results: tables.map((name) => ({ name })) }];
    }

    const countMatch = sql.match(/SELECT COUNT\(\*\) as count FROM "([^"]+)"/);
    if (!countMatch) throw new Error(`unexpected SQL: ${sql}`);

    const table = countMatch[1];
    if (table === 'd1_migrations') {
      return [{ results: [{ count: this.migrationCountsByDb.get(dbName) ?? 0 }] }];
    }

    const key = `${dbName}:${table}`;
    const counts = this.countsByDbAndTable[key];
    if (!counts || counts.length === 0) throw new Error(`count failure for ${key}`);
    return [{ results: [{ count: counts.shift() }] }];
  }

  execute(command: string, args: string[]): void {
    this.commands.push([command, ...args].join(' '));
    if (args.includes('migrations') && args.includes('apply')) {
      const dbName = args[5];
      const applied = this.pendingMigrationsByDb[dbName] ?? 1;
      this.migrationCountsByDb.set(dbName, (this.migrationCountsByDb.get(dbName) ?? 0) + applied);
    }
  }

  nowIso(): string {
    return '2026-08-05T00:00:00Z';
  }
}

function count(database: string, binding: string, table: string, value: number): D1TableCount {
  return { database, binding, table, count: value };
}

describe('D1 migration safety gates', () => {
  it('parses the first complete Wrangler JSON document when diagnostics follow it', () => {
    const output = `[
      {
        "results": [{"value": "bracket ] and quote \\" stay inside the string"}],
        "success": true
      }
    ]
    Wrangler wrote a trailing diagnostic after the JSON response`;

    expect(parseWranglerJsonOutput(output)).toEqual([
      {
        results: [{ value: 'bracket ] and quote " stay inside the string' }],
        success: true,
      },
    ]);
  });

  it('rejects Wrangler output that does not begin with a JSON object or array', () => {
    expect(() => parseWranglerJsonOutput('warning before output\n[{"results": []}]')).toThrow(
      /did not begin with JSON/
    );
  });

  it('rejects an incomplete Wrangler JSON document', () => {
    expect(() => parseWranglerJsonOutput('[{"results": []}')).toThrow(/incomplete JSON/);
  });

  it('dynamically discovers protected user tables and excludes SQLite/system tables', () => {
    const runner = new FakeRunner(
      { main: ['sqlite_sequence', 'users', 'd1_migrations', 'projects'] },
      {}
    );

    expect(
      discoverProtectedTables(runner, 'staging', { binding: 'DATABASE', name: 'main' })
    ).toEqual(['projects', 'users']);
  });

  it('fails closed on small-table row-count decreases', () => {
    expect(() =>
      verifyNoUnexpectedProtectedTableDecrease(
        [count('main', 'DATABASE', 'users', 2)],
        [count('main', 'DATABASE', 'users', 1)]
      )
    ).toThrow(/Protected table row-count decrease/);
  });

  it('fails closed on protected-table count failures', () => {
    const runner = new FakeRunner({ main: ['d1_migrations', 'users'] }, {});

    expect(() =>
      runSafeRemoteMigrations({
        environment: 'staging',
        databases: [{ binding: 'DATABASE', name: 'main' }],
        runner,
      })
    ).toThrow(/count failure for main:users/);
  });

  it('allows a clean install, then requires migrations to create protected tables', () => {
    const runner = new FakeRunner(
      { main: [[], ['d1_migrations', 'users']] },
      { 'main:users': [0] }
    );

    runSafeRemoteMigrations({
      environment: 'staging',
      databases: [{ binding: 'DATABASE', name: 'main' }],
      runner,
    });

    expect(runner.commands.filter((command) => command.includes('migrations apply'))).toHaveLength(
      1
    );
  });

  it('fails closed when an initialized upgrade database has no protected tables', () => {
    const runner = new FakeRunner({ main: ['d1_migrations'] }, {});

    expect(() =>
      runSafeRemoteMigrations({
        environment: 'production',
        databases: [{ binding: 'DATABASE', name: 'main' }],
        runner,
      })
    ).toThrow(/refusing to treat an upgrade as a clean install/);
    expect(runner.commands.some((command) => command.includes('migrations apply'))).toBe(false);
  });

  it('fails closed when a clean install remains empty after migrations', () => {
    const runner = new FakeRunner({ main: [[], ['d1_migrations']] }, {});

    expect(() =>
      runSafeRemoteMigrations({
        environment: 'staging',
        databases: [{ binding: 'DATABASE', name: 'main' }],
        runner,
      })
    ).toThrow(/No protected tables discovered.*refusing to migrate/);
    expect(runner.commands.filter((command) => command.includes('migrations apply'))).toHaveLength(
      1
    );
  });

  it('fails closed when a post-migration protected-table count cannot be read', () => {
    const runner = new FakeRunner({ main: ['d1_migrations', 'users'] }, { 'main:users': [3] });

    expect(() =>
      runSafeRemoteMigrations({
        environment: 'production',
        databases: [{ binding: 'DATABASE', name: 'main' }],
        runner,
      })
    ).toThrow(/count failure for main:users/);
    expect(runner.commands.filter((command) => command.includes('migrations apply'))).toHaveLength(
      1
    );
  });

  it('parses only JSON arrays for CLI decrease allowlists', () => {
    expect(parseAllowlist(undefined)).toEqual([]);
    expect(() => parseAllowlist('{"database":"main"}')).toThrow(/must be a JSON array/);
    expect(() => parseAllowlist('{not-json')).toThrow();
  });

  it('validates configurable churning-table selectors and decrease thresholds', () => {
    expect(parseChurningTableSelectors(undefined)).toEqual(
      expect.arrayContaining([
        'DATABASE.deployment_releases',
        'DATABASE.session_snapshots',
        'DATABASE.project_files',
      ])
    );
    expect(parseChurningTableSelectors(undefined)).toContain(
      'OBSERVABILITY_DATABASE.platform_errors'
    );
    expect(
      parseChurningTableSelectors(' DATABASE.sessions,OBSERVABILITY_DATABASE.platform_errors ')
    ).toEqual(['DATABASE.sessions', 'OBSERVABILITY_DATABASE.platform_errors']);
    expect(() => parseChurningTableSelectors('DATABASE.users')).toThrow(/not a reviewed churning/);
    expect(() => parseChurningTableSelectors('DATABASE.accounts')).toThrow(
      /not a reviewed churning/
    );
    expect(() => parseChurningTableSelectors('platform_errors')).toThrow(
      /Expected <binding>\.<table>/
    );

    expect(parseChurningTableMaxDecreasePercent(undefined)).toBe(
      DEFAULT_D1_MIGRATION_CHURNING_TABLE_MAX_DECREASE_PERCENT
    );
    expect(parseChurningTableMaxDecreasePercent('12.5')).toBe(12.5);
    expect(() => parseChurningTableMaxDecreasePercent('-1')).toThrow(/between 0 and 100/);
    expect(() => parseChurningTableMaxDecreasePercent('101')).toThrow(/between 0 and 100/);
    expect(() => parseChurningTableMaxDecreasePercent('not-a-number')).toThrow(/between 0 and 100/);
  });

  it.each(['deployment_releases', 'session_snapshots', 'project_files'])(
    'accepts routine retention churn for reviewed DATABASE.%s',
    (table) => {
      expect(() =>
        verifyNoUnexpectedProtectedTableDecrease(
          [count('main', 'DATABASE', table, 10)],
          [count('main', 'DATABASE', table, 5)],
          [],
          [`DATABASE.${table}`],
          50
        )
      ).not.toThrow();
    }
  );

  it('blocks a churning-table decrease above the configured percentage limit', () => {
    expect(() =>
      verifyNoUnexpectedProtectedTableDecrease(
        [count('obs', 'OBSERVABILITY_DATABASE', 'platform_errors', 10)],
        [count('obs', 'OBSERVABILITY_DATABASE', 'platform_errors', 4)],
        [],
        ['OBSERVABILITY_DATABASE.platform_errors'],
        50
      )
    ).toThrow(/60\.000% decrease exceeds 50%/);

    expect(() =>
      verifyNoUnexpectedProtectedTableDecrease(
        [count('obs', 'OBSERVABILITY_DATABASE', 'platform_errors', 10)],
        [count('obs', 'OBSERVABILITY_DATABASE', 'platform_errors', 5)],
        [],
        ['OBSERVABILITY_DATABASE.platform_errors'],
        50
      )
    ).not.toThrow();
  });

  it('allows reviewed explicit row-count decrease allowlist entries', () => {
    expect(() =>
      verifyNoUnexpectedProtectedTableDecrease(
        [count('main', 'DATABASE', 'expired_events', 8)],
        [count('main', 'DATABASE', 'expired_events', 3)],
        [
          {
            database: 'main',
            table: 'expired_events',
            reviewedBy: 'reviewer@example.com',
            reason: 'Migration intentionally purges expired rows.',
          },
        ]
      )
    ).not.toThrow();
  });

  it('rejects malformed or duplicate decrease allowlist entries before migrations run', () => {
    const malformedRunner = new FakeRunner(
      { main: ['d1_migrations', 'users'] },
      { 'main:users': [4, 3] }
    );

    expect(() =>
      runSafeRemoteMigrations({
        environment: 'production',
        databases: [{ binding: 'DATABASE', name: 'main' }],
        runner: malformedRunner,
        allowlist: [
          {
            database: 'main',
            table: 'users',
            reviewedBy: '   ',
            reason: 'planned cleanup',
          },
        ],
      })
    ).toThrow(/requires non-empty string/);
    expect(malformedRunner.commands.some((command) => command.includes('migrations apply'))).toBe(
      false
    );

    expect(() =>
      verifyNoUnexpectedProtectedTableDecrease(
        [count('main', 'DATABASE', 'users', 4)],
        [count('main', 'DATABASE', 'users', 3)],
        [
          {
            database: 'main',
            table: 'users',
            reviewedBy: 'reviewer@example.com',
            reason: 'planned cleanup',
          },
          {
            database: 'main',
            table: 'users',
            reviewedBy: 'reviewer@example.com',
            reason: 'duplicate entry',
          },
        ]
      )
    ).toThrow(/Duplicate D1 migration decrease allowlist entry/);
  });

  it('counts and verifies both main and observability databases', () => {
    const runner = new FakeRunner(
      {
        main: ['d1_migrations', 'users'],
        obs: ['d1_migrations', 'platform_errors'],
      },
      {
        'main:users': [4, 4],
        'obs:platform_errors': [7, 7],
      }
    );

    runSafeRemoteMigrations({
      environment: 'production',
      databases: [
        { binding: 'DATABASE', name: 'main' },
        { binding: 'OBSERVABILITY_DATABASE', name: 'obs' },
      ],
      runner,
    });

    expect(runner.commands.join('\n')).toContain('main');
    expect(runner.commands.join('\n')).toContain('obs');
    expect(runner.commands.filter((command) => command.includes('migrations apply'))).toHaveLength(
      2
    );
  });

  it('does not block on a small churning-table decrease when no migrations were applied', () => {
    const runner = new FakeRunner(
      { obs: ['d1_migrations', 'platform_errors'] },
      { 'obs:platform_errors': [6306, 6305] },
      { obs: 0 }
    );

    expect(() =>
      runSafeRemoteMigrations({
        environment: 'staging',
        databases: [{ binding: 'OBSERVABILITY_DATABASE', name: 'obs' }],
        runner,
      })
    ).not.toThrow();
  });

  it('skips the post-migration comparison when the migration ledger does not advance', () => {
    const runner = new FakeRunner(
      { obs: ['d1_migrations', 'platform_errors'] },
      { 'obs:platform_errors': [6306] },
      { obs: 0 }
    );

    runSafeRemoteMigrations({
      environment: 'staging',
      databases: [{ binding: 'OBSERVABILITY_DATABASE', name: 'obs' }],
      runner,
    });

    expect(
      runner.commands.filter(
        (command) => command.includes('COUNT(*)') && command.includes('platform_errors')
      )
    ).toHaveLength(1);
  });

  it('compares only the database whose migration ledger advances', () => {
    const runner = new FakeRunner(
      {
        main: ['d1_migrations', 'users'],
        obs: ['d1_migrations', 'platform_errors'],
      },
      {
        'main:users': [4, 4],
        'obs:platform_errors': [6306],
      },
      { main: 1, obs: 0 }
    );

    runSafeRemoteMigrations({
      environment: 'staging',
      databases: [
        { binding: 'DATABASE', name: 'main' },
        { binding: 'OBSERVABILITY_DATABASE', name: 'obs' },
      ],
      runner,
    });

    const applicationCounts = runner.commands.filter((command) =>
      command.includes('SELECT COUNT(*)')
    );
    expect(applicationCounts.filter((command) => command.includes('FROM "users"'))).toHaveLength(2);
    expect(
      applicationCounts.filter((command) => command.includes('FROM "platform_errors"'))
    ).toHaveLength(1);
  });

  it('allows a small decrease in a churning table when a migration was applied', () => {
    const runner = new FakeRunner(
      { obs: ['d1_migrations', 'platform_errors'] },
      { 'obs:platform_errors': [6306, 6305] }
    );

    expect(() =>
      runSafeRemoteMigrations({
        environment: 'production',
        databases: [{ binding: 'OBSERVABILITY_DATABASE', name: 'obs' }],
        runner,
      })
    ).not.toThrow();
  });

  it('blocks protected-business-table loss and prints recovery timestamp and commands', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const runner = new FakeRunner(
      {
        main: ['d1_migrations', 'users'],
        obs: ['d1_migrations', 'platform_errors'],
      },
      {
        'main:users': [2, 1],
        'obs:platform_errors': [6306, 6305],
      }
    );

    try {
      expect(() =>
        runSafeRemoteMigrations({
          environment: 'production',
          databases: [
            { binding: 'DATABASE', name: 'main' },
            { binding: 'OBSERVABILITY_DATABASE', name: 'obs' },
          ],
          runner,
        })
      ).toThrow(/DATABASE\.users: 2 -> 1/);

      const recoveryOutput = errorSpy.mock.calls.flat().join('\n');
      expect(recoveryOutput).toContain('Pre-migration timestamp: 2026-08-05T00:00:00Z');
      expect(recoveryOutput).toContain('d1 time-travel restore main');
      expect(recoveryOutput).toContain('d1 time-travel restore obs');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('orders backup/counts before migrations and post-count verification after migrations', () => {
    const runner = new FakeRunner(
      { main: ['d1_migrations', 'users'] },
      {
        'main:users': [3, 3],
      }
    );

    runSafeRemoteMigrations({
      environment: 'staging',
      databases: [{ binding: 'DATABASE', name: 'main' }],
      runner,
    });

    const preCountIndex = runner.commands.findIndex((command) => command.includes('COUNT(*)'));
    const migrationIndex = runner.commands.findIndex((command) =>
      command.includes('migrations apply')
    );
    const postCountIndex = runner.commands.findLastIndex((command) => command.includes('COUNT(*)'));

    expect(preCountIndex).toBeGreaterThanOrEqual(0);
    expect(migrationIndex).toBeGreaterThan(preCountIndex);
    expect(postCountIndex).toBeGreaterThan(migrationIndex);
  });
});
