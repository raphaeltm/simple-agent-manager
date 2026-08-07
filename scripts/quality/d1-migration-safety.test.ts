import { describe, expect, it } from 'vitest';

import {
  type D1MigrationSafetyRunner,
  type D1TableCount,
  discoverProtectedTables,
  runSafeRemoteMigrations,
  verifyNoUnexpectedProtectedTableDecrease,
} from '../deploy/d1-migration-safety';

class FakeRunner implements D1MigrationSafetyRunner {
  public readonly commands: string[] = [];

  constructor(
    private readonly tablesByDb: Record<string, string[] | string[][]>,
    private readonly countsByDbAndTable: Record<string, number[]>
  ) {}

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
    const key = `${dbName}:${table}`;
    const counts = this.countsByDbAndTable[key];
    if (!counts || counts.length === 0) throw new Error(`count failure for ${key}`);
    return [{ results: [{ count: counts.shift() }] }];
  }

  execute(command: string, args: string[]): void {
    this.commands.push([command, ...args].join(' '));
  }

  nowIso(): string {
    return '2026-08-05T00:00:00Z';
  }
}

function count(database: string, binding: string, table: string, value: number): D1TableCount {
  return { database, binding, table, count: value };
}

describe('D1 migration safety gates', () => {
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
    const runner = new FakeRunner({ main: ['users'] }, {});

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
    const malformedRunner = new FakeRunner({ main: ['users'] }, { 'main:users': [4, 3] });

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
        main: ['users'],
        obs: ['platform_errors'],
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

  it('orders backup/counts before migrations and post-count verification after migrations', () => {
    const runner = new FakeRunner(
      { main: ['users'] },
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
