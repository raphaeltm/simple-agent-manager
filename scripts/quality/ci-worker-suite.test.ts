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
    /\n      - name: Run Worker and Durable Object suites\n        run: pnpm --filter @simple-agent-manager\/api test:workers\n/,
    '\n'
  );
}

function expectRequiredWorkerSuiteWiring(workflow: string): void {
  const job = jobBlock(workflow, 'durable-object-workers');
  const step = stepBlock(job, 'Run Worker and Durable Object suites');

  expect(job).toContain(
    "if: github.event_name == 'pull_request' || github.repository == 'raphaeltm/simple-agent-manager'"
  );
  expect(job).toContain('timeout-minutes: 15');
  expect(step).toContain('run: pnpm --filter @simple-agent-manager/api test:workers');
  expect(step).not.toContain('continue-on-error');
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

describe('CI Playwright visual audit wiring', () => {
  function expectBlockingPlaywrightVisualJob(workflow: string): void {
    const job = jobBlock(workflow, 'playwright-visual');
    const selectionStep = stepBlock(job, 'Select non-quarantined Playwright visual audits');
    const runStep = stepBlock(job, 'Run Playwright visual audit tests');

    expect(job).toContain("if: github.event_name == 'pull_request' && needs.changes.outputs.web-ui == 'true'");
    expect(selectionStep).toContain('pnpm exec tsx scripts/quality/select-playwright-visual-audits.ts');
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
