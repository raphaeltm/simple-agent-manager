import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { compilePattern } from './agent-instructions';
import { jobsRunning, pathFilters, simulate } from './ci-job-simulator';

const ci = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const e2eSmoke = readFileSync(
  new URL('../../.github/workflows/e2e-smoke.yml', import.meta.url),
  'utf8'
);
const codSpeed = readFileSync(
  new URL('../../.github/workflows/codspeed.yml', import.meta.url),
  'utf8'
);
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
      'pnpm format:check && pnpm lint:oxlint && pnpm lint && pnpm quality:type-boundaries && pnpm quality:runtime-state-files'
    );
    const lint = jobBlock(ci, 'lint');
    const commands = [
      'pnpm format:check',
      'pnpm lint:oxlint',
      'pnpm lint',
      'pnpm quality:type-boundaries',
      'pnpm quality:runtime-state-files',
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
    expect(quality).toContain('run: pnpm quality:runtime-tunables');
    expect(quality).toContain('check-runtime-tunables.test.ts');
    const changes = jobBlock(ci, 'changes');
    expect(changes).toContain("- 'scripts/quality/check-runtime-tunables*'");
    expect(changes).toContain("- 'scripts/quality/runtime-tunables-baseline.json'");
  });

  it('keeps public-site changes on a narrow CI path', () => {
    const changes = jobBlock(ci, 'changes');
    expect(changes).toContain('ci-workflow: ${{ steps.filter.outputs.ci-workflow }}');
    expect(changes).toContain('repo-quality: ${{ steps.filter.outputs.repo-quality }}');
    expect(changes).toContain(
      "public-site: ${{ github.event_name == 'push' && 'true' || steps.filter.outputs.public-site }}"
    );
    expect(changes).toContain('ci-workflow:');
    expect(changes).toContain("- 'apps/www/**'");
    expect(changes).not.toContain("- 'scripts/**'");

    // CI-routing changes run the wiring tests inside Code Quality Checks (the
    // separate CI Workflow job was folded in to save a runner slot).
    const codeQuality = jobBlock(ci, 'code-quality');
    expect(codeQuality).toContain("needs.changes.outputs.ci-workflow == 'true'");
    for (const testFile of [
      'ci-quality-program.test.ts',
      'ci-worker-suite.test.ts',
      'check-runtime-tunables.test.ts',
      'ci-workspace-surfaces.test.ts',
      'ci-browser-install.test.ts',
      'ci-evidence-token-wiring.test.ts',
      'ci-test-shards.test.ts',
      'ci-draft-and-gate.test.ts',
      'ci-suite-selection.test.ts',
    ]) {
      expect(codeQuality, `wiring test ${testFile} must run in CI`).toContain(testFile);
    }
    expect(ci).not.toMatch(/\n {2}ci-workflow:\n/u);

    // The public-site job replaced Marketing Site and keeps its www lint and type check
    // for changes the root Lint and Build and Type Check jobs do not run for.
    expect(ci).not.toMatch(/\n {2}marketing-site:\n/u);
    const surfaces = jobBlock(ci, 'workspace-quality-surfaces');
    expect(surfaces).toContain("needs.changes.outputs.public-site == 'true'");
    expect(surfaces).toContain('run: pnpm --filter @simple-agent-manager/www lint');
    expect(surfaces).toContain('run: pnpm --filter @simple-agent-manager/www typecheck');
    expect(surfaces.match(/if: needs\.changes\.outputs\.repo-quality != 'true'/gu)).toHaveLength(2);

    for (const jobName of ['lint', 'typecheck', 'code-quality']) {
      const job = jobBlock(ci, jobName);
      expect(job, `${jobName} should be repo-quality gated`).toMatch(/needs: \[changes[\],]/u);
      expect(job, `${jobName} should not run for public-site-only changes`).toContain(
        "needs.changes.outputs.repo-quality == 'true'"
      );
    }
    // Test suites are selected by package dependency (ci-suite-selection.test.ts).
    for (const [jobName, output] of [
      ['test-api', 'api-unit'],
      ['test-web', 'web'],
      ['test-packages', 'packages'],
    ]) {
      expect(jobBlock(ci, jobName!)).toContain(`needs.changes.outputs.${output} == 'true'`);
    }

    expect(jobBlock(ci, 'durable-object-worker-shards')).toContain(
      "needs.changes.outputs.api == 'true'"
    );
    expect(jobBlock(ci, 'pulumi-infra')).toContain("needs.changes.outputs.infra == 'true'");
    expect(jobBlock(ci, 'deploy-scripts')).toContain(
      "needs.changes.outputs.deploy-scripts == 'true'"
    );

    // Read from the parsed filters, so a YAML anchor (`api: &api`) or alias cannot hide a
    // filter from this check.
    const filters = pathFilters();
    for (const filterName of [
      'api',
      'api-unit',
      'web',
      'public-site',
      'packages',
      'vm-agent',
      'devcontainer',
      'devcontainer-volume-mount',
      'infra',
      'repo-quality',
      'web-ui',
      'go-modules',
    ]) {
      const patterns = (filters[filterName] ?? []).flat(Infinity);
      expect(patterns.length, `${filterName} filter exists`).toBeGreaterThan(0);
      expect(patterns, `${filterName} must not fan out on ci.yml`).not.toContain(
        '.github/workflows/ci.yml'
      );
    }
  });

  it('keeps VM smoke off marketing-site and CI-routing-only pull requests', () => {
    expect(e2eSmoke).toContain('paths:');
    expect(e2eSmoke).not.toContain('paths-ignore:');
    expect(e2eSmoke).toContain("- 'apps/api/**'");
    expect(e2eSmoke).toContain("- 'packages/vm-agent/**'");
    expect(e2eSmoke).toContain("- 'scripts/e2e/**'");
    expect(e2eSmoke).not.toContain("- 'apps/www/**'");
    expect(e2eSmoke).not.toContain("- '.github/workflows/ci.yml'");
    expect(e2eSmoke).not.toContain("- '.github/workflows/e2e-smoke.yml'");
  });

  it('keeps CodSpeed off marketing-site and CI-routing-only pull requests', () => {
    expect(codSpeed).toContain('pull_request:');
    expect(codSpeed).toContain('paths:');
    expect(codSpeed).toContain("- 'packages/shared/**'");
    expect(codSpeed).not.toContain("- 'apps/www/**'");
    expect(codSpeed).not.toContain("- '.github/workflows/ci.yml'");
    expect(codSpeed).not.toContain("- '.github/workflows/codspeed.yml'");
  });
});

describe('agent instruction check selection', () => {
  const patterns = (pathFilters()['agent-instructions'] ?? []).flat(Infinity).map(String);
  const selects = (path: string) => patterns.some((pattern) => compilePattern(pattern).test(path));

  it.each([
    'CLAUDE.md',
    'AGENTS.md',
    'apps/api/AGENTS.md',
    // An override replaces AGENTS.md for Codex, so adding one must run the check that flags it.
    'AGENTS.override.md',
    'packages/cli/AGENTS.override.md',
    '.claude/rules/99-example-rule.md',
    '.claude/settings.json',
    '.claude/hooks/log-instructions-loaded.sh',
    '.claude/hooks/verify-test-quality.mjs',
    '.codex/config.toml',
    '.codex/hooks/rule-context.mjs',
    '.codex/hooks/rule-scopes.json',
    'scripts/quality/agent-instructions.ts',
    'scripts/quality/agent-context-budget.json',
    'scripts/quality/check-agent-context-budget.ts',
  ])('a change to %s selects the agent-instructions filter', (path) => {
    expect(selects(path)).toBe(true);
  });

  it('does not select the filter for ordinary source', () => {
    expect(selects('apps/api/src/index.ts')).toBe(false);
  });

  it('runs the instruction check on a draft PR that only changes instruction files', () => {
    const results = simulate({
      eventName: 'pull_request',
      draft: true,
      filters: ['agent-instructions'],
    });
    expect(jobsRunning('pnpm quality:agent-context-budget --check', results)).toEqual([
      'code-quality',
    ]);
    expect(jobsRunning('pnpm quality:agent-tooling:test', results)).toEqual(['code-quality']);
  });
});
