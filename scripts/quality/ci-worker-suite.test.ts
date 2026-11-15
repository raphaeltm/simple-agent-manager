import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { BaseSequencer, type TestSpecification, type Vitest } from 'vitest/node';

import { loadShardTimings, planShards } from '../../apps/api/tests/workers/support/shard-plan';
import TimingBalancedSequencer from '../../apps/api/tests/workers/support/timing-balanced-sequencer';

const CI_WORKFLOW_PATH = new URL('../../.github/workflows/ci.yml', import.meta.url);

function readCiWorkflow(): string {
  return readFileSync(CI_WORKFLOW_PATH, 'utf8');
}

function jobBlock(workflow: string, jobName: string): string {
  const pattern = new RegExp(String.raw`\n  ${jobName}:\n[\s\S]*?(?=\n  [a-zA-Z0-9_-]+:\n|\n*$)`);
  const match = workflow.match(pattern);

  expect(match?.[0], `missing ${jobName} job`).toBeDefined();
  return match![0];
}

function stepBlock(job: string, stepName: string): string {
  const pattern = new RegExp(
    String.raw`\n      - name: ${stepName}\n[\s\S]*?(?=\n      - name:|\n  [a-zA-Z0-9_-]+:\n|\n*$)`
  );
  const match = job.match(pattern);

  expect(match?.[0], `missing ${stepName} step`).toBeDefined();
  return match![0];
}

function withoutWorkerSuiteStep(workflow: string): string {
  const job = jobBlock(workflow, 'durable-object-worker-shards');
  return workflow.replace(stepBlock(job, 'Run Worker and Durable Object suites'), '\n');
}

function expectRequiredWorkerSuiteWiring(workflow: string): void {
  const job = jobBlock(workflow, 'durable-object-worker-shards');
  const step = stepBlock(job, 'Run Worker and Durable Object suites');

  expect(job).toContain("needs.changes.outputs.api == 'true'");
  expect(job).toContain('needs: [changes]');
  // The job must carry a JOB-level bound — an unbounded required check can hang
  // for the 6h GitHub ceiling, and a step-level `timeout-minutes` does not cap
  // the job's wall time. Anchor to the 4-space job-property indent so a deeper
  // step-level bound cannot satisfy this while the job-level one is missing.
  // The exact value is tuning, not contract, so assert the bound exists and
  // stays sane rather than pinning a magic number (#2016). The <= 30 ceiling is
  // specific to THIS job; other jobs legitimately run longer (playwright: 45).
  const timeoutMatch = job.match(/^ {4}timeout-minutes: (\d+)$/m);
  expect(timeoutMatch).not.toBeNull();
  const timeoutMinutes = Number(timeoutMatch![1]);
  expect(timeoutMinutes).toBeGreaterThan(0);
  expect(timeoutMinutes).toBeLessThanOrEqual(30);
  expect(step).toContain('run: pnpm --filter @simple-agent-manager/api test:workers');
  expect(step).not.toContain('continue-on-error');
  expect(job).toContain('fail-fast: false');
  expect(job).toContain('shard: [1, 2, 3, 4, 5, 6]');
  expect(step).toContain('WORKERS_SHARD: ${{ matrix.shard }}');
  expect(step).toContain('--shard="${WORKERS_SHARD}/6"');
  expect(step).toContain('--reporter=./tests/workers/timing-reporter.ts');
  // The required check now gates the whole suite (scripts/quality/ci-draft-and-gate.test.ts);
  // for API changes it must still demand that every Workers shard succeeded.
  const gate = jobBlock(workflow, 'durable-object-workers');
  expect(gate).toContain("&& 'Durable Object Workers' ||");
  expect(gate).toContain('      - durable-object-worker-shards\n');
  expect(gate).toContain('if: always()');
  expect(gate).not.toContain('continue-on-error');
  const shardStep = stepBlock(gate, 'Require every Workers shard to pass');
  expect(shardStep).toContain("if: needs.changes.outputs.api == 'true'");
  expect(shardStep).toContain('SHARD_RESULT: ${{ needs.durable-object-worker-shards.result }}');
  const command = shardStep.match(/run: (.+)/)?.[1];
  expect(command).toBeDefined();
  for (const result of ['success', 'failure', 'cancelled', 'skipped', '']) {
    const execution = spawnSync('bash', ['-c', command!], {
      env: { ...process.env, SHARD_RESULT: result },
    });
    expect(execution.status === 0, `aggregate status for ${result}`).toBe(result === 'success');
  }
}

describe('CI Worker and Durable Object suite wiring', () => {
  it('runs the actual API workers-pool script in the required Durable Object Workers job', () => {
    expectRequiredWorkerSuiteWiring(readCiWorkflow());
  });

  it('fails when the workflow only mentions test:workers outside the executable job step', () => {
    const workflowWithoutExecutableStep = `${withoutWorkerSuiteStep(readCiWorkflow())}

# Non-executing mention that must not satisfy this guard:
# pnpm --filter @simple-agent-manager/api test:workers
`;

    expect(() => expectRequiredWorkerSuiteWiring(workflowWithoutExecutableStep)).toThrow(
      'missing Run Worker and Durable Object suites step'
    );
  });
});

describe('Workers shard gate discrimination', () => {
  it('rejects an aggregate that ignores failed or skipped shards', () => {
    const weakened = readCiWorkflow().replace('run: test "$SHARD_RESULT" = success', 'run: true');
    expect(() => expectRequiredWorkerSuiteWiring(weakened)).toThrow();
  });

  it('rejects an omitted shard and a disabled shard selector', () => {
    for (const weakened of [
      // Anchor on the Workers matrix: the API unit-test matrix also lists [1, 2, 3].
      readCiWorkflow().replace(
        'shard: [1, 2, 3, 4, 5, 6]\n    timeout-minutes: 30',
        'shard: [1, 2, 3, 4, 5]\n    timeout-minutes: 30'
      ),
      readCiWorkflow().replace('--shard="${WORKERS_SHARD}/6"', ''),
      readCiWorkflow().replace('WORKERS_SHARD: ${{ matrix.shard }}', ''),
    ])
      expect(() => expectRequiredWorkerSuiteWiring(weakened)).toThrow();
  });
});

describe('CI Playwright visual audit wiring', () => {
  function expectBlockingPlaywrightVisualJob(workflow: string): void {
    const job = jobBlock(workflow, 'playwright-visual');
    const selectionStep = stepBlock(job, 'Select non-quarantined Playwright visual audits');
    const runStep = stepBlock(job, 'Run Playwright visual audit tests');

    expect(job).toContain(
      "if: github.event_name == 'pull_request' && !github.event.pull_request.draft && (needs.changes.outputs.web-ui == 'true' || needs.changes.outputs.browser-install == 'true')"
    );
    expect(selectionStep).toContain(
      'pnpm exec tsx scripts/quality/select-playwright-visual-audits.ts'
    );
    expect(runStep).toContain('xargs npx playwright test');
    expect(runStep).toContain("--project='iPhone 14 (390x844)'");
    expect(runStep).not.toContain('continue-on-error');
    expect(job).not.toContain('Visual audit failures are informational');
    expect(job).not.toContain('Fail if Playwright timed out');
    expect(job).toContain('if: failure()');
  }

  it('runs selected Playwright visual audits as a blocking PR-only web-ui gate', () => {
    expectBlockingPlaywrightVisualJob(readCiWorkflow());
  });

  it('fails if Playwright is made warn-only again', () => {
    const warnOnlyWorkflow = readCiWorkflow().replace(
      '        working-directory: apps/web\n        run: |\n          xargs npx playwright test',
      '        continue-on-error: true\n        working-directory: apps/web\n        run: |\n          xargs npx playwright test'
    );

    expect(() => expectBlockingPlaywrightVisualJob(warnOnlyWorkflow)).toThrow();
  });
});

/**
 * The Workers shards split by measured per-file time. `vitest list` ignores `--shard`,
 * so these drive the real sequencer class with the real test file list; the CI run's
 * per-shard timing artifacts are the end-to-end evidence.
 */
describe('time-balanced Workers shards', () => {
  const apiRoot = fileURLToPath(new URL('../../apps/api/', import.meta.url));
  const workerFiles = (function walk(dir: string): string[] {
    return readdirSync(join(apiRoot, dir), { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(`${dir}/${entry.name}`)
        : entry.name.endsWith('.test.ts')
          ? [`${dir}/${entry.name}`]
          : []
    );
  })('tests/workers').sort();
  const timings = loadShardTimings();
  const SHARDS = 6;

  function sequencerFor(shard?: { index: number; count: number }) {
    const ctx = { config: { root: apiRoot.replace(/\/$/u, ''), shard } } as unknown as Vitest;
    return { balanced: new TimingBalancedSequencer(ctx), hashed: new BaseSequencer(ctx) };
  }
  const specs = workerFiles.map((file) => ({ moduleId: join(apiRoot, file) }) as TestSpecification);
  const pathOf = (spec: TestSpecification) => relative(apiRoot, spec.moduleId);
  const load = (files: string[]) =>
    files.reduce((sum, file) => sum + (timings.files[file] ?? 0), 0);

  it('finds the suite and has measurements for most of it (liveness)', () => {
    expect(workerFiles.length).toBeGreaterThan(150);
    const measured = workerFiles.filter((file) => file in timings.files).length;
    expect(measured / workerFiles.length).toBeGreaterThan(0.5);
  });

  it('runs every file in exactly one shard, through the real sequencer', async () => {
    const seen: string[] = [];
    for (let index = 1; index <= SHARDS; index++) {
      const shard = await sequencerFor({ index, count: SHARDS }).balanced.shard(specs);
      expect(shard.length, `shard ${index}`).toBeGreaterThan(0);
      seen.push(...shard.map(pathOf));
    }
    expect(seen.sort()).toEqual(workerFiles);
  });

  it('returns the files unchanged without --shard', async () => {
    expect(await sequencerFor().balanced.shard(specs)).toEqual(specs);
  });

  it('balances measured time far better than Vitest hash sharding', async () => {
    const max = async (kind: 'balanced' | 'hashed') => {
      const loads: number[] = [];
      for (let index = 1; index <= SHARDS; index++) {
        const shard = await sequencerFor({ index, count: SHARDS })[kind].shard(specs);
        loads.push(load(shard.map(pathOf)) + (index === 1 ? timings.shardOneExtraMs : 0));
      }
      return Math.max(...loads);
    };
    const mean = (load(workerFiles) + timings.shardOneExtraMs) / SHARDS;
    const balanced = await max('balanced');
    expect(balanced).toBeLessThanOrEqual(mean * 1.1);
    expect(balanced).toBeLessThan(await max('hashed'));
  });

  it('is the same plan for any input order, and new files get the median weight', () => {
    const shuffled = [...workerFiles].reverse();
    expect(planShards(shuffled, SHARDS, timings).shards).toEqual(
      planShards(workerFiles, SHARDS, timings).shards
    );
    const withNew = planShards(['tests/workers/new.test.ts', ...workerFiles], SHARDS, timings);
    expect(withNew.shards.flat()).toContain('tests/workers/new.test.ts');
    expect(withNew.shards.flat()).toHaveLength(workerFiles.length + 1);
  });
});
