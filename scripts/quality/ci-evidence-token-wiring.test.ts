/**
 * Workflow contract test for the PR-evidence live-state reads.
 *
 * Why this exists: `pr-evidence-source.ts` returns null from `fetchLiveState`
 * unless BOTH `GITHUB_TOKEN` and `GITHUB_REPOSITORY` are present. `GITHUB_REPOSITORY`
 * is ambient in Actions; `GITHUB_TOKEN` is NOT — it must be mapped explicitly from
 * `github.token`. And `GET /repos/{owner}/{repo}/pulls/{n}` needs `pull-requests: read`,
 * which the workflow's top-level `permissions: contents: read` does not grant.
 *
 * The first cut of this feature shipped with neither wired. Every unit test passed,
 * because each one hand-supplied a token in its `env` — so the suite proved the
 * resolver worked while the feature was inert in the only configuration that ships
 * (.claude/rules/69: a path that only activates under a configuration the tests do
 * not use; .claude/rules/62: a test that reaches the feature by a path production
 * never takes).
 *
 * This asserts the wiring itself, so a silent regression fails CI.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const WORKFLOW_PATH = join(__dirname, '..', '..', '.github', 'workflows', 'ci.yml');

// Both evidence checks run as steps of one job (they used to be two jobs).
const EVIDENCE_JOB = 'pr-evidence';
const TOKEN_STEPS = ['Validate agent preflight evidence', 'Validate specialist review evidence'];

function readWorkflow(): string {
  return readFileSync(WORKFLOW_PATH, 'utf8');
}

/** Extract a job block: from `  <id>:` to the next 2-space-indented job key. */
function jobBlock(workflow: string, jobId: string): string {
  const start = workflow.indexOf(`\n  ${jobId}:`);
  expect(start, `job ${jobId} not found in ci.yml`).toBeGreaterThan(-1);
  const rest = workflow.slice(start + 1);
  const next = rest.search(/\n {2}[a-z0-9_-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next);
}

/** Extract one step block of a job, from `- name: <step>` to the next step. */
function stepBlock(job: string, stepName: string): string {
  const start = job.indexOf(`      - name: ${stepName}\n`);
  expect(start, `step ${stepName} not found`).toBeGreaterThan(-1);
  const rest = job.slice(start + 1);
  const next = rest.search(/\n {6}- /);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('PR evidence checks are wired for live PR reads', () => {
  it(`${EVIDENCE_JOB} grants pull-requests: read`, () => {
    const job = jobBlock(readWorkflow(), EVIDENCE_JOB);
    // Job-level `permissions` REPLACES the top-level block, so contents: read
    // must be restated for actions/checkout.
    expect(job).toMatch(/^ {4}permissions:$/m);
    expect(job).toMatch(/^ {6}pull-requests: read$/m);
    expect(job).toMatch(/^ {6}contents: read$/m);
  });

  for (const stepName of TOKEN_STEPS) {
    it(`passes GITHUB_TOKEN to "${stepName}"`, () => {
      const step = stepBlock(jobBlock(readWorkflow(), EVIDENCE_JOB), stepName);
      expect(step).toMatch(/GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
    });
  }

  it('finds the job and both steps (guards against a broken extractor reporting all-clear)', () => {
    const job = jobBlock(readWorkflow(), EVIDENCE_JOB);
    expect(job.length).toBeGreaterThan(200);
    for (const stepName of TOKEN_STEPS) expect(stepBlock(job, stepName).length).toBeGreaterThan(40);
  });
});
