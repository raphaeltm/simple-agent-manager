/**
 * Wiring tests for the sharded unit-test jobs and the final `Test` job.
 *
 * The API and web suites run as Vitest shards that each upload a blob report with
 * coverage; the `Test` job merges them and enforces each package's coverage
 * thresholds. Two failure modes would stay green without these tests:
 *   - a shard count changed in one place only (matrix, --shard flag, blob count), so
 *     part of a suite silently never runs;
 *   - thresholds zeroed or dropped in the merge, so coverage is no longer enforced.
 * The last group runs the workflow's exact shard and merge commands against a real
 * small package, so the blob/coverage mechanics are exercised, not just described.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { workflowSource } from './workflow-test-helpers';

interface Step {
  name?: string;
  if?: string;
  run?: string;
  uses?: string;
  'working-directory'?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}

interface Job {
  name?: string;
  needs?: string[];
  if?: string;
  'timeout-minutes'?: number;
  strategy?: { 'fail-fast'?: boolean; matrix?: { shard?: number[] } };
  steps?: Step[];
}

const REPO_ROOT = join(__dirname, '..', '..');

function jobs(source = workflowSource('ci.yml')): Record<string, Job> {
  return (parse(source) as { jobs: Record<string, Job> }).jobs;
}

function step(job: Job, name: string): Step {
  const found = job.steps?.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing step ${name}`);
  return found;
}

const SUITES = [
  {
    job: 'test-api',
    dir: 'apps/api',
    shards: 3,
    run: 'Run API unit test shard with coverage',
    merge: 'Merge API shards and enforce API coverage thresholds',
  },
  {
    job: 'test-web',
    dir: 'apps/web',
    shards: 2,
    run: 'Run web unit test shard with coverage',
    merge: 'Merge web shards and enforce web coverage thresholds',
  },
] as const;

function expectShardWiring(source?: string): void {
  const all = jobs(source);
  const test = all.test!;
  for (const suite of SUITES) {
    const job = all[suite.job]!;
    const shards = job.strategy?.matrix?.shard ?? [];
    expect(shards, `${suite.job} matrix`).toEqual(
      Array.from({ length: suite.shards }, (_, i) => i + 1)
    );
    expect(job.strategy?.['fail-fast'], `${suite.job} fail-fast`).toBe(false);
    expect(job['timeout-minutes'], `${suite.job} timeout`).toBeLessThanOrEqual(20);

    const run = step(job, suite.run);
    expect(run['working-directory']).toBe(suite.dir);
    expect(run.env?.TEST_SHARD).toBe('${{ matrix.shard }}');
    expect(run.run).toContain(`--shard="\${TEST_SHARD}/${suite.shards}"`);
    expect(run.run).toContain('--reporter=blob');
    expect(run.run).toContain('--coverage ');
    for (const metric of ['statements', 'branches', 'functions', 'lines']) {
      expect(run.run, `${suite.job} must zero the ${metric} threshold per shard`).toContain(
        `--coverage.thresholds.${metric}=0`
      );
    }

    const upload = job.steps?.find((candidate) =>
      candidate.uses?.startsWith('actions/upload-artifact@')
    );
    expect(upload?.with?.path).toBe(`${suite.dir}/.vitest-reports/`);
    expect(upload?.with?.['if-no-files-found']).toBe('error');

    const merge = step(test, suite.merge);
    expect(merge['working-directory']).toBe(suite.dir);
    expect(merge.run).toContain(
      `test "$(find .vitest-reports -name 'blob-*.json' | wc -l)" -eq ${suite.shards}`
    );
    expect(merge.run).toContain('pnpm exec vitest run --merge-reports --coverage');
    expect(merge.run, 'the merge must enforce the configured thresholds').not.toContain(
      'thresholds'
    );
  }

  expect(test.name).toBe('Test');
  expect(test.needs).toEqual(['changes', 'test-api', 'test-web', 'test-packages']);
  expect(test.if).toMatch(/^always\(\) && /u);
  expect(test['timeout-minutes']).toBeLessThanOrEqual(15);

  const packages = step(all['test-packages']!, 'Run package tests with coverage');
  expect(packages.run).toContain(
    "pnpm test:coverage --filter='!@simple-agent-manager/api' --filter='!@simple-agent-manager/web'"
  );
}

describe('sharded unit test wiring', () => {
  it('keeps matrix, --shard and blob counts in step and enforces thresholds on the merge', () => {
    expectShardWiring();
  });

  it.each([
    ['an API shard dropped from the matrix', 'shard: [1, 2, 3]', 'shard: [1, 2]'],
    [
      'a web shard count changed in one place',
      '--shard="${TEST_SHARD}/2"',
      '--shard="${TEST_SHARD}/3"',
    ],
    [
      'thresholds zeroed in the merge',
      '          pnpm exec vitest run --merge-reports --coverage\n',
      '          pnpm exec vitest run --merge-reports --coverage --coverage.thresholds.lines=0\n',
    ],
    [
      'the merge blob count relaxed',
      "-name 'blob-*.json' | wc -l)\" -eq 3",
      "-name 'blob-*.json' | wc -l)\" -ge 1",
    ],
    ['a shard that keeps a per-shard threshold', '--coverage.thresholds.lines=0', ''],
  ])('rejects %s', (_, from, to) => {
    const source = workflowSource('ci.yml');
    const weakened = source.replace(from, to);
    expect(weakened).not.toBe(source);
    expect(() => expectShardWiring(weakened)).toThrow();
  });

  it('fails the Test job unless every shard job succeeded', () => {
    const run = step(jobs().test!, 'Require every test shard to pass').run!;
    const status = (api: string, web: string, packages: string) =>
      spawnSync('bash', ['-c', run], {
        env: { ...process.env, API_RESULT: api, WEB_RESULT: web, PACKAGES_RESULT: packages },
      }).status;
    expect(status('success', 'success', 'success')).toBe(0);
    for (const bad of ['failure', 'cancelled', 'skipped', '']) {
      expect(status(bad, 'success', 'success'), `api ${bad}`).not.toBe(0);
      expect(status('success', bad, 'success'), `web ${bad}`).not.toBe(0);
      expect(status('success', 'success', bad), `packages ${bad}`).not.toBe(0);
    }
  });
});

/**
 * Runs the API job's shard command and the Test job's API merge step, verbatim, in
 * packages/shared (small, fast, with real thresholds: 83/30/60/83). Three shards
 * and a merge take a few seconds.
 */
describe('shard and merge commands against a real package', () => {
  const packageDir = join(REPO_ROOT, 'packages/shared');
  const reports = join(packageDir, '.vitest-reports');
  const coverage = join(packageDir, 'coverage');
  const coverageExisted = existsSync(coverage);
  const all = jobs();
  const shardCommand = step(all['test-api']!, 'Run API unit test shard with coverage').run!;
  const mergeCommand = step(all.test!, 'Merge API shards and enforce API coverage thresholds').run!;

  const exec = (command: string, extra: Record<string, string> = {}) =>
    spawnSync('bash', ['-c', command], {
      cwd: packageDir,
      env: { ...process.env, ...extra },
      encoding: 'utf8',
      timeout: 120_000,
    });

  afterAll(() => {
    rmSync(reports, { recursive: true, force: true });
    // coverage/ is gitignored; remove it only if this test created it.
    if (!coverageExisted) rmSync(coverage, { recursive: true, force: true });
  });

  it('each shard passes despite covering only part of the package', () => {
    rmSync(reports, { recursive: true, force: true });
    for (const shard of ['1', '2', '3']) {
      const result = exec(shardCommand, { TEST_SHARD: shard });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    }
    expect(readdirSync(reports).sort()).toEqual([
      'blob-1-3.json',
      'blob-2-3.json',
      'blob-3-3.json',
    ]);
  }, 180_000);

  it('the merge step passes with every shard and enforces the thresholds', () => {
    const result = exec(mergeCommand);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/Test Files\s+\d+ passed/u);
  }, 120_000);

  it('the merge step fails when a shard report is missing', () => {
    unlinkSync(join(reports, 'blob-3-3.json'));
    expect(exec(mergeCommand).status).not.toBe(0);
    // Without the count check, the thresholds alone still reject a partial merge.
    const thresholdsOnly = exec('pnpm exec vitest run --merge-reports --coverage');
    expect(thresholdsOnly.status).not.toBe(0);
    expect(thresholdsOnly.stdout + thresholdsOnly.stderr).toMatch(
      /does not meet global threshold/u
    );
  }, 120_000);
});
