import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  assertSonarCoverageConfiguration,
  findJavaScriptCoverageReportPaths,
  prepareJavaScriptCoverageReports,
  validateGoCoverageReport,
} from './check-sonar-coverage';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const EXPECTED_JAVASCRIPT_REPORTS = [
  'apps/api/coverage/lcov.info',
  'apps/tail-worker/coverage/lcov.info',
  'apps/web/coverage/lcov.info',
  'apps/www/coverage/lcov.info',
  'infra/coverage/lcov.info',
  'packages/acp-client/coverage/lcov.info',
  'packages/cloud-init/coverage/lcov.info',
  'packages/eslint-plugin-sam/coverage/lcov.info',
  'packages/providers/coverage/lcov.info',
  'packages/shared/coverage/lcov.info',
  'packages/terminal/coverage/lcov.info',
  'packages/ui/coverage/lcov.info',
];
const temporaryRoots: string[] = [];

interface FixtureOptions {
  goCoverage?: string;
  javascriptCoverage?: string | null;
  sonarGoPath?: string;
  sonarJavaScriptPaths?: string[];
}

type WorkflowJob = Record<string, unknown>;
type WorkflowStep = Record<string, unknown>;

interface WorkflowDefinition {
  jobs?: Record<string, WorkflowJob>;
  on?: Record<string, unknown>;
}

function write(root: string, path: string, contents: string): void {
  const absolutePath = join(root, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents);
}

function createOutsideSource(filename: string, contents: string): string {
  const outsideRoot = mkdtempSync(join(tmpdir(), 'sam-sonar-outside-'));
  temporaryRoots.push(outsideRoot);
  write(outsideRoot, filename, contents);
  return join(outsideRoot, filename);
}

function createFixture(options: FixtureOptions = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'sam-sonar-coverage-'));
  temporaryRoots.push(root);
  write(root, 'pnpm-workspace.yaml', "packages:\n  - 'apps/*'\n  - 'packages/*'\n");
  write(
    root,
    'apps/covered/package.json',
    JSON.stringify({
      name: '@fixture/covered',
      scripts: { 'test:coverage': 'vitest run --coverage' },
    })
  );
  write(
    root,
    'packages/no-coverage/package.json',
    JSON.stringify({ name: '@fixture/no-coverage', scripts: { test: 'vitest run' } })
  );
  write(root, 'apps/covered/src/index.ts', 'export const covered = true;\n');
  write(root, 'packages/cli/go.mod', 'module example.test/sam-cli\n\ngo 1.24.0\n');
  write(root, 'packages/cli/main.go', 'package main\n\nfunc main() {}\n');

  const javascriptPaths = options.sonarJavaScriptPaths ?? ['apps/covered/coverage/lcov.info'];
  write(
    root,
    'sonar-project.properties',
    [
      `sonar.javascript.lcov.reportPaths=${javascriptPaths.join(',')}`,
      `sonar.go.coverage.reportPaths=${options.sonarGoPath ?? 'packages/cli/coverage.out'}`,
      '',
    ].join('\n')
  );

  if (options.javascriptCoverage !== null) {
    write(
      root,
      'apps/covered/coverage/lcov.info',
      options.javascriptCoverage ?? 'TN:\nSF:src/index.ts\nDA:1,1\nLF:1\nLH:1\nend_of_record\n'
    );
  }
  if (options.goCoverage !== undefined) {
    write(root, 'packages/cli/coverage.out', options.goCoverage);
  }

  return root;
}

function workflowDefinition(): WorkflowDefinition {
  return parse(
    readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8')
  ) as WorkflowDefinition;
}

function workflowJobs(): Record<string, WorkflowJob> {
  const workflow = workflowDefinition();
  if (!workflow.jobs) throw new Error('CI workflow is missing jobs.');
  return workflow.jobs;
}

function normalizedJobCondition(job: WorkflowJob): string {
  if (typeof job.if !== 'string') throw new Error('CI job is missing an if condition.');
  return job.if.replace(/\s+/gu, ' ').trim();
}

function workflowSteps(job: WorkflowJob): WorkflowStep[] {
  if (!Array.isArray(job.steps)) throw new Error('CI job is missing steps.');
  if (!job.steps.every((step): step is WorkflowStep => typeof step === 'object' && step !== null)) {
    throw new Error('CI job has a malformed step.');
  }
  return job.steps;
}

function namedStep(job: WorkflowJob, name: string): WorkflowStep {
  const step = workflowSteps(job).find((candidate) => candidate.name === name);
  if (!step) throw new Error(`CI job is missing the ${name} step.`);
  return step;
}

function serialized(value: unknown): string {
  return JSON.stringify(value);
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Sonar coverage report contract', () => {
  it('retains existing coverage reporters and restores cached coverage outputs', () => {
    const rootManifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const turbo = JSON.parse(readFileSync(join(REPO_ROOT, 'turbo.json'), 'utf8')) as {
      tasks: Record<string, { outputs?: string[] }>;
    };

    expect(rootManifest.scripts['test:coverage']).toBe(
      'turbo run test:coverage -- --coverage.reporter=text --coverage.reporter=json --coverage.reporter=html --coverage.reporter=lcov'
    );
    expect(turbo.tasks['test:coverage'].outputs).toEqual(['coverage/**']);
  });

  it('discovers only Vitest coverage workspaces at deterministic sorted paths', () => {
    const root = createFixture();

    expect(findJavaScriptCoverageReportPaths(root)).toEqual(['apps/covered/coverage/lcov.info']);
  });

  it('discovers every checked-in Vitest coverage workspace', () => {
    expect(findJavaScriptCoverageReportPaths(REPO_ROOT)).toEqual(EXPECTED_JAVASCRIPT_REPORTS);
  });

  it('keeps generated marketing assets out of the source coverage report', () => {
    const config = readFileSync(join(REPO_ROOT, 'apps/www/vitest.config.ts'), 'utf8');

    expect(config).toContain("include: ['src/**/*.ts']");
    expect(config).not.toContain('public/**');
  });

  it('normalizes workspace-relative LCOV sources to repository-relative paths', () => {
    const root = createFixture();

    expect(prepareJavaScriptCoverageReports(root, { normalize: true })).toEqual({
      reports: ['apps/covered/coverage/lcov.info'],
      sourceFiles: 1,
      lineRecords: 1,
    });
    expect(readFileSync(join(root, 'apps/covered/coverage/lcov.info'), 'utf8')).toContain(
      'SF:apps/covered/src/index.ts'
    );
  });

  it('accepts normalized LCOV reports without rewriting them', () => {
    const coverage = 'TN:\nSF:apps/covered/src/index.ts\nDA:1,1\nLF:1\nLH:1\nend_of_record\n';
    const root = createFixture({ javascriptCoverage: coverage });

    prepareJavaScriptCoverageReports(root, { normalize: false });

    expect(readFileSync(join(root, 'apps/covered/coverage/lcov.info'), 'utf8')).toBe(coverage);
  });

  it('rejects a missing JavaScript coverage report', () => {
    const root = createFixture({ javascriptCoverage: null });

    expect(() => prepareJavaScriptCoverageReports(root, { normalize: true })).toThrow(
      'Missing JavaScript coverage report: apps/covered/coverage/lcov.info'
    );
  });

  it.each([
    ['', 'is empty'],
    ['TN:\nSF:src/index.ts\nend_of_record\n', 'has no DA line records'],
    ['TN:\nSF:src/index.ts\nDA:not-a-line\nend_of_record\n', 'malformed DA record'],
    ['TN:\nSF:\nDA:1,1\nend_of_record\n', 'has an empty SF record'],
    [
      'TN:\nSF:src/index.ts\nSF:src/index.ts\nDA:1,1\nend_of_record\n',
      'has an unterminated record',
    ],
    ['TN:\nend_of_record\n', 'has an orphaned record end'],
    ['TN:\n', 'has no SF source records'],
  ])('rejects unusable JavaScript coverage: %s', (coverage, expectedMessage) => {
    const root = createFixture({ javascriptCoverage: coverage });

    expect(() => prepareJavaScriptCoverageReports(root, { normalize: true })).toThrow(
      expectedMessage
    );
  });

  it('rejects LCOV sources that do not point to repository files', () => {
    const outsideSource = createOutsideSource('outside.ts', 'export const outside = true;\n');
    const root = createFixture({
      javascriptCoverage: `TN:\nSF:${outsideSource}\nDA:1,1\nLF:1\nLH:1\nend_of_record\n`,
    });

    expect(() => prepareJavaScriptCoverageReports(root, { normalize: true })).toThrow(
      'does not resolve to a repository source file'
    );
  });

  it('rejects LCOV sources whose in-repository symlink resolves outside the repository', () => {
    const outsideSource = createOutsideSource(
      'symlink-target.ts',
      'export const outside = true;\n'
    );
    const root = createFixture({
      javascriptCoverage: 'TN:\nSF:src/symlink.ts\nDA:1,1\nLF:1\nLH:1\nend_of_record\n',
    });
    symlinkSync(outsideSource, join(root, 'apps/covered/src/symlink.ts'));

    expect(() => prepareJavaScriptCoverageReports(root, { normalize: true })).toThrow(
      'does not resolve to a repository source file'
    );
  });

  it('rejects Sonar properties that drift from discovered report paths', () => {
    const root = createFixture({
      sonarJavaScriptPaths: ['coverage/combined/lcov.info'],
    });

    expect(() =>
      assertSonarCoverageConfiguration(root, findJavaScriptCoverageReportPaths(root))
    ).toThrow('sonar.javascript.lcov.reportPaths must exactly equal');
  });

  it('rejects Sonar properties that drift from the canonical Go report path', () => {
    const root = createFixture({ sonarGoPath: 'coverage/go.out' });

    expect(() =>
      assertSonarCoverageConfiguration(root, findJavaScriptCoverageReportPaths(root))
    ).toThrow('sonar.go.coverage.reportPaths must exactly equal packages/cli/coverage.out');
  });

  it('accepts a non-empty Go coverage report whose sources resolve through go.mod', () => {
    const root = createFixture({
      goCoverage: 'mode: atomic\nexample.test/sam-cli/main.go:3.13,3.15 1 1\n',
    });

    expect(() => validateGoCoverageReport(root)).not.toThrow();
  });

  it.each([
    [undefined, 'Missing Go coverage report: packages/cli/coverage.out'],
    ['', 'Go coverage report is empty'],
    ['mode: invalid\nexample.test/sam-cli/main.go:3.13,3.15 1 1\n', 'invalid mode header'],
    ['mode: atomic\n', 'has no coverage records'],
    ['mode: atomic\nnot-a-coverage-record\n', 'malformed Go coverage record'],
    ['mode: atomic\nexample.test/sam-cli/missing.go:1.1,1.2 1 0\n', 'does not resolve'],
  ])('rejects an unusable Go coverage report', (goCoverage, expectedMessage) => {
    const root = createFixture({ goCoverage });

    expect(() => validateGoCoverageReport(root)).toThrow(expectedMessage);
  });

  it('rejects existing Go coverage sources outside the repository', () => {
    const outsideSource = createOutsideSource('outside.go', 'package outside\n');
    const root = createFixture({
      goCoverage: `mode: atomic\n${outsideSource}:1.1,1.2 1 1\n`,
    });

    expect(() => validateGoCoverageReport(root)).toThrow(
      'does not resolve to a repository source file'
    );
  });
});

describe('Sonar CI wiring', () => {
  it('uploads normalized LCOV from the existing coverage job', () => {
    const testJob = workflowJobs().test;
    const job = serialized(testJob);
    const upload = namedStep(testJob, 'Upload JavaScript coverage reports');
    const inputs = upload.with as Record<string, unknown>;

    expect(job).toContain('pnpm test:coverage');
    expect(job).toContain('pnpm quality:sonar-coverage:javascript');
    expect(upload.uses).toBe('actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a');
    expect(inputs.name).toBe('js-ts-lcov');
    expect(inputs['if-no-files-found']).toBe('error');
    expect(String(inputs.path).trim().split('\n')).toEqual(EXPECTED_JAVASCRIPT_REPORTS);
  });

  it('feeds current-run JS and Go artifacts to a secret-safe scanner without rerunning tests', () => {
    const workflow = workflowDefinition();
    if (!workflow.on) throw new Error('CI workflow is missing event triggers.');
    const jobs = workflowJobs();
    const sonarJob = jobs.sonar;
    const scanner = serialized(sonarJob);
    const javascriptDownload = namedStep(sonarJob, 'Download JavaScript coverage reports');
    const goDownload = namedStep(sonarJob, 'Download Go coverage report');
    const tokenSteps = workflowSteps(sonarJob).filter((step) =>
      serialized(step).includes('secrets.SONAR_TOKEN')
    );
    const requireToken = namedStep(sonarJob, 'Require Sonar scanner token');
    const scan = namedStep(sonarJob, 'Analyze with SonarQube Cloud');

    expect(sonarJob.needs).toEqual(['changes', 'test', 'cli-test', 'sonar-go-coverage']);
    expect(sonarJob.permissions).toEqual({ contents: 'read' });
    expect(sonarJob.env).toBeUndefined();
    expect(workflow.on).toHaveProperty('pull_request');
    expect(workflow.on).not.toHaveProperty('pull_request_target');
    expect(normalizedJobCondition(sonarJob)).toBe(
      "always() && vars.SONAR_CI_ENABLED == 'true' && needs.changes.result == 'success' && needs.changes.outputs.repo-quality == 'true' && needs.test.result == 'success' && (needs.cli-test.result == 'success' || needs.sonar-go-coverage.result == 'success') && (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository)"
    );
    expect(scanner).toContain('fetch-depth');
    expect(scanner).toContain('pnpm quality:sonar-coverage');
    expect(javascriptDownload.uses).toBe(
      'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c'
    );
    expect(javascriptDownload.with).toEqual({ name: 'js-ts-lcov', path: '.' });
    expect(goDownload.with).toEqual({ name: 'cli-go-coverage', path: 'packages/cli' });
    expect(tokenSteps.map((step) => step.name)).toEqual([
      'Require Sonar scanner token',
      'Analyze with SonarQube Cloud',
    ]);
    expect(String(requireToken.run).trim()).toBe(
      [
        'if [ -z "$SONAR_TOKEN" ]; then',
        '  echo "::error::SONAR_TOKEN is required after SONAR_CI_ENABLED is enabled."',
        '  exit 1',
        'fi',
      ].join('\n')
    );
    expect(scan.uses).toBe(
      'SonarSource/sonarqube-scan-action@22918119ff8e1ca75a623e15c8296b6ea4fbe28f'
    );
    expect(scan.env).toEqual({ SONAR_TOKEN: '${{ secrets.SONAR_TOKEN }}' });
    expect(scan.with).toBeUndefined();
    const coverageRunSteps = Object.entries(jobs).flatMap(([jobName, job]) =>
      workflowSteps(job)
        .filter((step) => typeof step.run === 'string' && step.run.includes('pnpm test:coverage'))
        .map((step) => ({ jobName, stepName: step.name }))
    );
    expect(coverageRunSteps).toEqual([{ jobName: 'test', stepName: 'Run tests with coverage' }]);
  });

  it('produces Go coverage only when the scanner is enabled and CLI Test was skipped', () => {
    const jobs = workflowJobs();
    const supplementalGo = serialized(jobs['sonar-go-coverage']);
    const assertGoVersion = namedStep(jobs['sonar-go-coverage'], 'Assert Go version');
    const cliTest = serialized(jobs['cli-test']);

    expect(supplementalGo).toContain('SONAR_CI_ENABLED');
    expect(normalizedJobCondition(jobs['sonar-go-coverage'])).toBe(
      "vars.SONAR_CI_ENABLED == 'true' && needs.changes.outputs.repo-quality == 'true' && needs.changes.outputs.cli != 'true' && (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository)"
    );
    expect(supplementalGo).toContain('go test -coverprofile=coverage.out -covermode=atomic ./...');
    expect(supplementalGo).toContain('go tool cover -func=coverage.out');
    expect(supplementalGo).toContain('cli-go-coverage');
    expect(assertGoVersion.run).toBe('test "$(go env GOVERSION)" = "go${GO_VERSION}"');
    expect(cliTest).toContain('go tool cover -func=coverage.out');
    expect(cliTest).toContain('cli-go-coverage');
  });

  it('routes scanner inputs through repository-quality changes without making docs expensive', () => {
    const jobs = workflowJobs();
    const filterStep = workflowSteps(jobs.changes).find((step) => step.id === 'filter');
    if (!filterStep) throw new Error('Change detection job is missing its filter step.');
    const inputs = filterStep.with as Record<string, unknown>;
    const filters = parse(String(inputs.filters)) as Record<string, string[]>;

    expect(filters['repo-quality']).toEqual(
      expect.arrayContaining([
        'apps/www/package.json',
        'apps/www/vitest.config.ts',
        'apps/www/src/**/*.{ts,tsx,js,jsx,astro}',
        'sonar-project.properties',
        'scripts/quality/check-sonar-coverage.ts',
        'scripts/quality/sonar-coverage-pipeline.test.ts',
      ])
    );
    expect(filters['repo-quality']).not.toContain('apps/www/src/content/docs/**');
    expect(filters['repo-quality']).not.toContain('scripts/quality/README.md');
  });
});
