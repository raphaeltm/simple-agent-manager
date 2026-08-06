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
