import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

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
  return workflow.replace(
    /\n {6}- name: Run Worker and Durable Object suites\n {8}run: pnpm --filter @simple-agent-manager\/api test:workers[^\n]*\n/,
    '\n'
  );
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
  expect(job).toContain('shard: [1, 2, 3]');
  expect(step).toContain('--shard=${{ matrix.shard }}/3');
  expect(step).toContain('--reporter=./tests/workers/timing-reporter.ts');
  const gate = jobBlock(workflow, 'durable-object-workers');
  expect(gate).toContain('name: Durable Object Workers');
  expect(gate).toContain('needs: [changes, durable-object-worker-shards]');
  expect(gate).toContain('if: always()');
  expect(gate).toContain("needs.changes.outputs.api == 'true'");
  expect(gate).toContain('SHARD_RESULT: ${{ needs.durable-object-worker-shards.result }}');
  expect(gate).not.toContain('continue-on-error');
  const command = stepBlock(gate, 'Require every Workers shard to pass').match(/run: (.+)/)?.[1];
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
      readCiWorkflow().replace('shard: [1, 2, 3]', 'shard: [1, 2]'),
      readCiWorkflow().replace('--shard=${{ matrix.shard }}/3', ''),
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
      "if: github.event_name == 'pull_request' && needs.changes.outputs.web-ui == 'true'"
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
