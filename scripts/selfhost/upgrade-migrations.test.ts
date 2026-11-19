import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runCommand } from './backup-cli';
import type { BoxContext } from './backup-lib';
import { installedMigrations, migrationsFrom, sourceMigrations } from './upgrade-migrations';

const HISTORY = [
  { tag: 'v1', new_sqlite_classes: ['ProjectData'] },
  { tag: 'selfhost-hosted-git-v1', new_sqlite_classes: ['HostedGitRepo'] },
];
let root: string;
let config: Record<string, unknown>;
let pointer: Record<string, unknown>;
let manifest: Record<string, unknown>;
let requests: string[];
let failRead: boolean;

const context = (scheme = 'gs'): BoxContext => ({
  box: { CELLD_BUCKET: `${scheme}://fleet/owned`, S3_ENDPOINT: 'http://localhost:9000' },
  envFile: join(root, 'env'),
  stateDir: root,
  composeFiles: ['compose.yml'],
  now: () => 0,
  log: () => {
    throw new Error('Migration preflight must not log any control object');
  },
  run: (command, args) => {
    if (command === 'pnpm') return { status: 0, stdout: JSON.stringify(HISTORY), stderr: '' };
    const key = args.at(-1) ?? '';
    requests.push(key);
    if (failRead) return { status: 1, stdout: '', stderr: 'do-not-print-secret' };
    return {
      status: 0,
      stdout: JSON.stringify(key.endsWith('current.json') ? pointer : manifest),
      stderr: '',
    };
  },
});
const installConfig = () =>
  writeFileSync(join(root, 'project/wrangler.json'), JSON.stringify(config));

beforeEach(() => {
  for (const name of Object.keys(process.env)) {
    if (name === 'CI' || name === 'GITHUB_ACTIONS' || name.startsWith('RUNNER_'))
      vi.stubEnv(name, undefined);
  }
  mkdirSync(resolve('.tmp'), { recursive: true });
  root = mkdtempSync(join(resolve('.tmp'), 'migration-check-'));
  mkdirSync(join(root, 'project'));
  config = {
    name: 'sam',
    migrations: structuredClone(HISTORY),
    vars: { secret: 'do-not-print-secret' },
  };
  pointer = { script_name: 'sam', version: 'abc', prefix: 'deploy/sam/abc' };
  manifest = {
    script_name: 'sam',
    version: 'abc',
    sqlite_classes: [
      'ProjectData',
      'HostedGitRepo',
      '__D1Database',
      '__KvNamespace',
      '__Queue',
      '__Workflow.sam',
    ],
  };
  requests = [];
  failRead = false;
  installConfig();
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('installed migration state', () => {
  it.each(['gs', 's3'])(
    'reads the exact %s active pointer and manifest and accepts deployed hosted git',
    (scheme) => {
      expect(installedMigrations(context(scheme))).toEqual(HISTORY);
      expect(requests.map((key) => key.replace(/^(gs:\/\/|src\/)/, ''))).toEqual([
        'fleet/owned/deploy/current.json',
        'fleet/owned/deploy/sam/abc/manifest.json',
      ]);
    }
  );

  it.each(['unknown-tag', 'out-of-order', 'hosted-git-tag'])(
    'rejects installed %s tampering before reading manifests',
    (kind) => {
      const history = config.migrations as typeof HISTORY;
      if (kind === 'unknown-tag') history[0]!.tag = 'unknown';
      if (kind === 'out-of-order') history.reverse();
      if (kind === 'hosted-git-tag') history[1]!.tag = 'selfhost-hosted-git-v999';
      installConfig();
      expect(() => installedMigrations(context())).toThrow(/installed tags differ/);
      expect(requests).toEqual([]);
    }
  );

  it('refuses missing generated state rather than assuming source history was deployed', () => {
    rmSync(join(root, 'project/wrangler.json'));
    expect(() => installedMigrations(context())).toThrow(/missing installed generated config/);
  });

  it.each(['different-script', 'version-mismatch', 'missing-class', 'extra-class'])(
    'rejects %s in real deployment state',
    (kind) => {
      if (kind === 'different-script') manifest.script_name = 'foreign';
      if (kind === 'version-mismatch') manifest.version = 'other';
      if (kind === 'missing-class') manifest.sqlite_classes = ['ProjectData', '__D1Database'];
      if (kind === 'extra-class')
        manifest.sqlite_classes = ['ProjectData', 'HostedGitRepo', 'UnknownClass'];
      expect(() => installedMigrations(context())).toThrow(/active deployment/);
      expect(requests).toHaveLength(2);
    }
  );

  it('rejects a pointer escaping its exact deployment prefix', () => {
    pointer.prefix = '../foreign';
    expect(() => installedMigrations(context())).toThrow(/pointer does not match/);
    expect(requests).toHaveLength(1);
  });

  it('withholds command diagnostics that may contain a secret', () => {
    failRead = true;
    expect(() => installedMigrations(context())).toThrow(
      'DO migration preflight refused: cannot read active deployment state'
    );
  });

  it('uses the real current translator and emits only migration declarations', () => {
    const migrations = sourceMigrations({ ...context(), run: runCommand });
    expect(migrations.length).toBeGreaterThan(20);
    expect(migrations[0]?.tag).toBe('v1');
    expect(migrations.flatMap((entry) => entry.new_sqlite_classes)).toContain('ProjectData');
    expect(
      migrations.every((entry) => Object.keys(entry).sort().join(',') === 'new_sqlite_classes,tag')
    ).toBe(true);
  });
});

it.each([
  [
    { tag: 'duplicate', new_sqlite_classes: [] },
    { tag: 'duplicate', new_sqlite_classes: [] },
  ],
  [{ tag: 'v1', new_sqlite_classes: ['Same', 'Same'] }],
  [
    { tag: 'v1', new_sqlite_classes: ['Same'] },
    { tag: 'v2', new_sqlite_classes: ['Same'] },
  ],
  [{ tag: 'v1', new_classes: ['Unsafe'] }],
  [{ tag: 'v1', new_sqlite_classes: [], deleted_classes: ['Data'] }],
])('rejects invalid migration declarations %#', (...history) => {
  expect(() => migrationsFrom(history)).toThrow(/DO migration preflight refused/);
});
