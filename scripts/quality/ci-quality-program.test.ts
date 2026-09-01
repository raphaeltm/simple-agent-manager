import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const ci = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const parsedRootManifest: unknown = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
);
if (
  typeof parsedRootManifest !== 'object' ||
  parsedRootManifest === null ||
  !('scripts' in parsedRootManifest) ||
  typeof parsedRootManifest.scripts !== 'object' ||
  parsedRootManifest.scripts === null
) {
  throw new Error('Root package manifest scripts are invalid.');
}
const rootScripts = Object.fromEntries(
  Object.entries(parsedRootManifest.scripts).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string'
  )
);

function jobBlock(workflow: string, jobName: string): string {
  const match = workflow.match(
    new RegExp(String.raw`\n  ${jobName}:\n[\s\S]*?(?=\n  [a-zA-Z0-9_-]+:\n|\n*$)`)
  );
  expect(match?.[0], `missing ${jobName} job`).toBeDefined();
  if (!match) throw new Error(`Missing ${jobName} job.`);
  return match[0];
}

describe('deterministic quality-program CI wiring', () => {
  it('uses the same check:fast leaf commands in the blocking lint job', () => {
    expect(rootScripts['check:fast']).toBe(
      'pnpm format:check && pnpm lint:oxlint && pnpm lint && pnpm quality:type-boundaries'
    );
    const lint = jobBlock(ci, 'lint');
    const commands = [
      'pnpm format:check',
      'pnpm lint:oxlint',
      'pnpm lint',
      'pnpm quality:type-boundaries',
    ];
    let previous = -1;
    for (const command of commands) {
      const current = lint.indexOf(`run: ${command}\n`);
      expect(current, `${command} must be an executable lint-job leaf`).toBeGreaterThan(previous);
      previous = current;
    }
    expect(lint).toContain('run: pnpm --filter @simple-agent-manager/eslint-plugin-sam test');
    expect(lint).toContain('pnpm lint:oxlint:sam-shadow');
    expect(lint).toContain('continue-on-error: true');
  });

  it('blocks current-tree/PR-range secrets and changed Go modules through privacy-safe wrappers', () => {
    const secretScan = jobBlock(ci, 'secret-scan');
    expect(secretScan).toContain('fetch-depth: 0');
    expect(secretScan).toContain('pnpm quality:gitleaks:current');
    expect(secretScan).toContain('pnpm quality:gitleaks:pr');
    expect(secretScan).not.toContain('upload-artifact');

    const govulncheck = jobBlock(ci, 'go-vulnerability-diff');
    expect(govulncheck).toContain('needs: [changes]');
    expect(govulncheck).toContain("needs.changes.outputs.go-modules == 'true'");
    expect(govulncheck).toContain('pnpm quality:govulncheck-diff');
  });

  it('enforces dependency evidence and blocks apps/api/src semantic findings', () => {
    const quality = jobBlock(ci, 'code-quality');
    expect(quality).toContain('fetch-depth: 0');
    expect(quality).toContain('needs: [changes]');
    expect(quality).toContain("needs.changes.outputs.repo-quality == 'true'");
    expect(quality).toContain('pnpm quality:direct-dependency-evidence');
    expect(quality).toContain('pnpm quality:runtime-boundary-semantics');
  });

  it('keeps marketing-site changes on a narrow CI path', () => {
    const changes = jobBlock(ci, 'changes');
    expect(changes).toContain('ci-workflow: ${{ steps.filter.outputs.ci-workflow }}');
    expect(changes).toContain('marketing-site: ${{ steps.filter.outputs.marketing-site }}');
    expect(changes).toContain('repo-quality: ${{ steps.filter.outputs.repo-quality }}');
    expect(changes).toContain('ci-workflow:');
    expect(changes).toContain('marketing-site:');
    expect(changes).toContain("- 'apps/www/**'");
    expect(changes).toContain("- '!scripts/quality/ci*.test.ts'");

    const workflow = jobBlock(ci, 'ci-workflow');
    expect(workflow).toContain('needs: [changes]');
    expect(workflow).toContain("needs.changes.outputs.ci-workflow == 'true'");
    expect(workflow).toContain(
      'pnpm exec vitest run --config scripts/quality/vitest.config.ts ci-quality-program.test.ts ci-worker-suite.test.ts ci-workspace-surfaces.test.ts'
    );

    const marketing = jobBlock(ci, 'marketing-site');
    expect(marketing).toContain('needs: [changes]');
    expect(marketing).toContain("needs.changes.outputs.marketing-site == 'true'");
    expect(marketing).toContain('pnpm --filter @simple-agent-manager/www lint');
    expect(marketing).toContain('pnpm --filter @simple-agent-manager/www typecheck');
    expect(marketing).toContain(
      'pnpm --filter @simple-agent-manager/www build && pnpm --filter @simple-agent-manager/www check:links'
    );
    expect(marketing).toContain('pnpm --filter @simple-agent-manager/www test:browser');

    for (const jobName of [
      'lint',
      'typecheck',
      'test',
      'build',
      'workspace-quality-surfaces',
      'code-quality',
    ]) {
      const job = jobBlock(ci, jobName);
      expect(job, `${jobName} should be repo-quality gated`).toContain('needs: [changes]');
      expect(job, `${jobName} should not run for marketing-only changes`).toContain(
        "needs.changes.outputs.repo-quality == 'true'"
      );
    }

    expect(jobBlock(ci, 'durable-object-workers')).toContain("needs.changes.outputs.api == 'true'");
    expect(jobBlock(ci, 'pulumi-infra')).toContain("needs.changes.outputs.infra == 'true'");
    expect(jobBlock(ci, 'deploy-scripts')).toContain("needs.changes.outputs.deploy-scripts == 'true'");

    const expensiveFilterSnippet = changes.slice(changes.indexOf('filters: |'));
    for (const filterName of [
      'api',
      'vm-agent',
      'devcontainer',
      'devcontainer-volume-mount',
      'infra',
      'repo-quality',
      'web-ui',
      'go-modules',
    ]) {
      const nextFilter = expensiveFilterSnippet.match(
        new RegExp(String.raw`\n            ${filterName}:\n([\s\S]*?)(?=\n            [a-zA-Z0-9_-]+:\n|\n\n|\n  [a-zA-Z0-9_-]+:)`)
      );
      expect(nextFilter?.[1] ?? '', `${filterName} must not fan out on ci.yml`).not.toContain(
        ".github/workflows/ci.yml"
      );
    }
  });
});
