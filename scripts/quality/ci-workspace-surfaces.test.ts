import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const CI_WORKFLOW_PATH = new URL('../../.github/workflows/ci.yml', import.meta.url);

function jobBlock(workflow: string, jobName: string): string {
  const pattern = new RegExp(String.raw`\n  ${jobName}:\n[\s\S]*?(?=\n  [a-zA-Z0-9_-]+:\n|\n*$)`);
  const match = workflow.match(pattern);

  expect(match?.[0], `missing ${jobName} job`).toBeDefined();
  return match![0];
}

function expectBlockingWorkspaceSurfaces(workflow: string): void {
  const job = jobBlock(workflow, 'workspace-quality-surfaces');
  const requiredCommands = [
    'pnpm quality:workspace-test-surfaces',
    'pnpm --filter @simple-agent-manager/ui build-storybook',
    'pnpm --filter @simple-agent-manager/www build && pnpm --filter @simple-agent-manager/www check:links',
    'pnpm --filter @simple-agent-manager/ui test:storybook',
    'pnpm --filter @simple-agent-manager/www test:browser',
    'pnpm quality:browser-evidence',
  ];

  for (const command of requiredCommands) {
    expect(job, `missing blocking command: ${command}`).toContain(`run: ${command}`);
  }

  expect(job).not.toContain('continue-on-error');
  expect(job).toContain('path: .codex/tmp/playwright-screenshots/');
  expect(job).toContain('if-no-files-found: error');
}

describe('CI workspace quality surface wiring', () => {
  it('runs each deterministic workspace surface as a blocking command', () => {
    expectBlockingWorkspaceSurfaces(readFileSync(CI_WORKFLOW_PATH, 'utf8'));
  });

  it('fails if a required workspace command is omitted from the job', () => {
    const incompleteWorkflow = readFileSync(CI_WORKFLOW_PATH, 'utf8').replace(
      '        run: pnpm --filter @simple-agent-manager/ui build-storybook\n',
      ''
    );

    expect(() => expectBlockingWorkspaceSurfaces(incompleteWorkflow)).toThrow(
      'missing blocking command: pnpm --filter @simple-agent-manager/ui build-storybook'
    );
  });
});
