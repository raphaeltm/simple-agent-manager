/**
 * Behavioral tests for which CI jobs run on which events, and for the merge gate.
 *
 * Why this exists: draft pull requests run only quick checks, and ruleset "Main"
 * requires exactly one check, "Durable Object Workers". A skipped job reports
 * success, so a draft run that skipped the suite, or a ready run on a PR that did
 * not touch the API, could otherwise leave the required check green while tests
 * never ran (or failed). These tests evaluate the real `if:` and `name:` expressions
 * from ci.yml for realistic events instead of grepping for substrings, and run the
 * gate's real shell step against fixtures.
 */
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import {
  allFilters,
  changesOutputs,
  evaluate,
  evaluateName,
  githubContext,
  jobsRunning,
  loadWorkflow,
  needsOf,
  type Scenario,
  simulate,
  started,
} from './ci-job-simulator';
import { workflowSource } from './workflow-test-helpers';

const REQUIRED_CHECK = 'Durable Object Workers';
const QUICK_JOBS = ['changes', 'pr-evidence', 'lint', 'secret-scan', 'typecheck', 'code-quality'];
const ALL_FILTERS = allFilters();

describe('pull request triggers and concurrency', () => {
  it('runs on ready_for_review in addition to the default pull_request types', () => {
    expect(loadWorkflow().on.pull_request?.types).toEqual([
      'opened',
      'synchronize',
      'reopened',
      'ready_for_review',
    ]);
  });

  it('groups pull requests per PR and every other event per commit', () => {
    const { group, 'cancel-in-progress': cancel } = loadWorkflow().concurrency;
    const groupFor = (scenario: Scenario) =>
      group.replace(/\$\{\{([^}]*)\}\}/gu, (_, expression: string) =>
        String(evaluate(expression, { github: githubContext(scenario) }))
      );
    const pr = { eventName: 'pull_request', filters: [] } as const;
    const push = { eventName: 'push', filters: [] } as const;
    expect(groupFor(pr)).toBe('ci-refs/pull/1/merge');
    expect(groupFor(push)).toBe(`ci-${'a'.repeat(40)}`);
    expect(evaluate(cancel, { github: githubContext(pr) })).toBe(true);
    expect(evaluate(cancel, { github: githubContext(push) })).toBe(false);
  });
});

describe('draft pull requests run only the quick checks', () => {
  it('starts exactly the quick set on a draft PR that changes everything', () => {
    const results = simulate({ eventName: 'pull_request', draft: true, filters: ALL_FILTERS });
    expect(started(results).sort()).toEqual([...QUICK_JOBS].sort());
  });

  it('starts the full suite once the same PR is ready for review', () => {
    const results = simulate({ eventName: 'pull_request', draft: false, filters: ALL_FILTERS });
    expect(started(results).sort()).toEqual(Object.keys(loadWorkflow().jobs).sort());
  });

  it.each([
    ['public-site-only', ['public-site', 'packages'], ['changes', 'pr-evidence', 'secret-scan']],
    ['CI-routing-only', ['ci-workflow'], ['changes', 'pr-evidence', 'secret-scan', 'code-quality']],
    [
      'browser helper and public site',
      ['browser-install', 'public-site'],
      ['changes', 'pr-evidence', 'secret-scan'],
    ],
  ])('a draft %s PR starts only its quick jobs', (_, filters, expected) => {
    const results = simulate({ eventName: 'pull_request', draft: true, filters });
    expect(started(results).sort()).toEqual([...expected].sort());
  });

  it.each([
    [
      'public-site-only (an apps/www change)',
      ['public-site', 'packages'],
      [
        'changes',
        'pr-evidence',
        'secret-scan',
        'workspace-quality-surfaces',
        'test-packages',
        'test',
        'durable-object-workers',
      ],
    ],
    [
      'CI-routing-only',
      ['ci-workflow'],
      ['changes', 'pr-evidence', 'secret-scan', 'code-quality', 'durable-object-workers'],
    ],
  ])('a ready %s PR starts exactly its jobs', (_, filters, expected) => {
    const results = simulate({ eventName: 'pull_request', filters });
    expect(started(results).sort()).toEqual([...expected].sort());
  });

  it('every quick job is also a job the ready run starts (liveness control)', () => {
    const results = simulate({ eventName: 'pull_request', draft: false, filters: ALL_FILTERS });
    for (const id of QUICK_JOBS) expect(results.get(id), id).toBe('success');
  });

  it('a draft that also drops the draft guard from a full-suite job is caught', () => {
    const source = workflowSource('ci.yml').replace(
      "&& !github.event.pull_request.draft && needs.changes.outputs.deploy-scripts == 'true'",
      "&& needs.changes.outputs.deploy-scripts == 'true'"
    );
    const results = simulate(
      { eventName: 'pull_request', draft: true, filters: ALL_FILTERS },
      loadWorkflow(source)
    );
    expect(started(results)).toContain('deploy-scripts');
    expect(started(results).sort()).not.toEqual([...QUICK_JOBS].sort());
  });
});

describe('the required "Durable Object Workers" check', () => {
  const gateId = 'durable-object-workers';

  it('is never reported under the required name on a draft run', () => {
    const workflow = loadWorkflow();
    const draft = { eventName: 'pull_request', draft: true, filters: ALL_FILTERS } as const;
    expect(evaluateName(workflow.jobs[gateId]!, draft)).not.toBe(REQUIRED_CHECK);
    for (const [id, job] of Object.entries(workflow.jobs)) {
      expect(evaluateName(job, draft), id).not.toBe(REQUIRED_CHECK);
    }
  });

  it('is not reported under the required name on a manual dispatch run of a branch', () => {
    // A dispatch run skips the PR-only jobs, so it must not satisfy the required check.
    const gate = loadWorkflow().jobs[gateId]!;
    const dispatch = { eventName: 'workflow_dispatch', filters: ALL_FILTERS } as const;
    expect(evaluateName(gate, dispatch)).not.toBe(REQUIRED_CHECK);
    expect(simulate(dispatch).get('playwright-visual')).toBe('skipped');
  });

  it('is reported under the required name on ready PR runs and main pushes', () => {
    const gate = loadWorkflow().jobs[gateId]!;
    for (const scenario of [
      { eventName: 'pull_request', draft: false, filters: [] },
      { eventName: 'push', filters: [] },
    ] as Scenario[]) {
      expect(evaluateName(gate, scenario)).toBe(REQUIRED_CHECK);
      expect(simulate(scenario).get(gateId)).toBe('success');
    }
  });

  it('runs for PRs that do not touch the API (it used to be skipped, which reads as green)', () => {
    const results = simulate({
      eventName: 'pull_request',
      filters: ['repo-quality', 'web', 'packages'],
    });
    expect(results.get(gateId)).toBe('success');
    expect(results.get('test')).toBe('success');
    expect(results.get('durable-object-worker-shards')).toBe('skipped');
  });

  it('depends on every job except PR Evidence and itself', () => {
    const workflow = loadWorkflow();
    const expected = Object.keys(workflow.jobs).filter(
      (id) => id !== gateId && id !== 'pr-evidence'
    );
    expect(needsOf(workflow.jobs[gateId]!).sort()).toEqual(expected.sort());
  });

  it('is not started on fork main pushes (fork bypass)', () => {
    const results = simulate({
      eventName: 'push',
      repository: 'someone/fork',
      filters: ALL_FILTERS,
    });
    expect(started(results)).toEqual([]);
  });
});

/**
 * Runs the gate job's real steps (honouring each step's `if:`) against a `needs`
 * context built from the simulated job graph, the way Actions would. Returns null
 * when the gate job itself did not start.
 */
function gateVerdict(
  scenario: Scenario,
  failing: string[] = [],
  workflow = loadWorkflow()
): 'pass' | 'fail' | null {
  const results = simulate(scenario, workflow, failing);
  const gate = workflow.jobs['durable-object-workers']!;
  if (results.get('durable-object-workers') === 'skipped') return null;
  const outputs = changesOutputs(scenario, workflow);
  const needs = Object.fromEntries(
    needsOf(gate).map((need) => [
      need,
      { result: results.get(need), outputs: need === 'changes' ? outputs : {} },
    ])
  );
  for (const step of gate.steps ?? []) {
    if (step.if && !evaluate(step.if, { github: githubContext(scenario), needs })) continue;
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    env.NEEDS_JSON = JSON.stringify(needs);
    env.SHARD_RESULT = String(results.get('durable-object-worker-shards'));
    // Actions runs `run:` blocks with `bash -e`.
    if (spawnSync('bash', ['-e', '-c', step.run ?? 'false'], { env }).status !== 0) return 'fail';
  }
  return 'pass';
}

describe('gate verdicts through the simulated job graph', () => {
  const pr = (filters: string[]): Scenario => ({ eventName: 'pull_request', filters });

  const API = ['api', 'api-unit', 'repo-quality'];
  const WEB = ['web', 'packages', 'repo-quality'];

  it('passes a non-API PR whose suite passed, with the Workers shards skipped', () => {
    expect(gateVerdict(pr(WEB))).toBe('pass');
  });

  it('passes an API PR whose suite passed', () => {
    expect(gateVerdict(pr(API))).toBe('pass');
  });

  it('fails an API PR with a failing Workers shard', () => {
    expect(gateVerdict(pr(API), ['durable-object-worker-shards'])).toBe('fail');
  });

  it('fails an API PR whose Workers shards were skipped (a skipped job reads as green)', () => {
    const source = workflowSource('ci.yml').replace(
      "&& !github.event.pull_request.draft && needs.changes.outputs.api == 'true'\n    # Keep per-file",
      "&& needs.changes.outputs.api == 'never'\n    # Keep per-file"
    );
    expect(source).not.toBe(workflowSource('ci.yml'));
    expect(gateVerdict(pr(API), [], loadWorkflow(source))).toBe('fail');
  });

  it('fails a PR without Workers changes whose API unit shard failed (Test fails the gate)', () => {
    // A VM agent change runs the API unit suite (contract tests) but not the Workers suite.
    expect(gateVerdict(pr(['api-unit', 'vm-agent']), ['test-api'])).toBe('fail');
    expect(gateVerdict(pr(['api-unit', 'vm-agent']))).toBe('pass');
  });

  it('fails a web PR whose web shard failed', () => {
    expect(gateVerdict(pr(WEB), ['test-web'])).toBe('fail');
  });

  it('fails when Detect Changes fails, although every other job is then skipped', () => {
    expect(gateVerdict(pr(WEB), ['changes'])).toBe('fail');
  });

  it('fails a PR that only changes CI routing when its wiring tests fail', () => {
    expect(gateVerdict(pr(['ci-workflow']), ['code-quality'])).toBe('fail');
    expect(gateVerdict(pr(['ci-workflow']))).toBe('pass');
  });

  it('does not start on draft PRs', () => {
    expect(gateVerdict({ eventName: 'pull_request', draft: true, filters: ALL_FILTERS })).toBe(
      null
    );
  });
});

describe('gate step verdicts', () => {
  function stepRun(name: string, source?: string): string {
    const step = loadWorkflow(source).jobs['durable-object-workers']!.steps!.find(
      (candidate) => candidate.name === name
    );
    if (!step?.run) throw new Error(`missing gate step ${name}`);
    return step.run;
  }

  function verdict(run: string, needsJson: string): number | null {
    return spawnSync('bash', ['-c', run], { env: { ...process.env, NEEDS_JSON: needsJson } })
      .status;
  }

  const needs = (overrides: Record<string, string> = {}) =>
    JSON.stringify(
      Object.fromEntries(
        Object.entries({
          changes: 'success',
          lint: 'success',
          test: 'success',
          'workspace-quality-surfaces': 'skipped',
          'durable-object-worker-shards': 'skipped',
          ...overrides,
        }).map(([id, result]) => [id, { result, outputs: {} }])
      )
    );

  const run = stepRun('Require every other CI job to pass');

  it('passes when every job passed or was skipped by its filter', () => {
    expect(verdict(run, needs())).toBe(0);
  });

  it.each(['failure', 'cancelled'])('fails when a job result is %s', (result) => {
    expect(verdict(run, needs({ test: result }))).not.toBe(0);
    expect(verdict(run, needs({ 'durable-object-worker-shards': result }))).not.toBe(0);
  });

  it('fails when Detect Changes did not succeed, or the needs context is empty', () => {
    expect(verdict(run, needs({ changes: 'skipped' }))).not.toBe(0);
    expect(verdict(run, needs({ changes: 'failure' }))).not.toBe(0);
    expect(verdict(run, '')).not.toBe(0);
    expect(verdict(run, '{}')).not.toBe(0);
    expect(verdict(run, 'not json')).not.toBe(0);
  });

  it('a weakened gate is caught by these verdicts', () => {
    const weakened = stepRun(
      'Require every other CI job to pass',
      workflowSource('ci.yml').replace(
        'select(.value.result != "success" and .value.result != "skipped")',
        'select(.value.result == "never")'
      )
    );
    expect(verdict(weakened, needs({ test: 'failure' }))).toBe(0);
  });
});

describe('public-site browser tests run once per run', () => {
  const command = 'pnpm --filter @simple-agent-manager/www test:browser';

  it.each([
    ['a UI package change', ['repo-quality', 'public-site', 'web', 'web-ui', 'packages']],
    ['a public-site-only change', ['public-site', 'packages']],
    ['a browser-install helper change', ['browser-install', 'ci-workflow']],
    ['a browser-install helper and public-site change', ['browser-install', 'public-site']],
    ['a main push with everything', ALL_FILTERS],
    ['a main push that changes nothing a filter matches', []],
  ])('exactly one job runs them for %s', (label, filters) => {
    const eventName = label.startsWith('a main push') ? 'push' : 'pull_request';
    const results = simulate({ eventName, filters } as Scenario);
    expect(jobsRunning(command, results)).toHaveLength(1);
  });

  it('no job runs them for an API-only change', () => {
    const results = simulate({
      eventName: 'pull_request',
      filters: ['api', 'api-unit', 'repo-quality', 'cli'],
    });
    expect(jobsRunning(command, results)).toEqual([]);
    // Liveness: the same run does start the API suite.
    expect(started(results)).toContain('test-api');
  });

  it('the job that runs them also checks the evidence when Storybook runs', () => {
    const results = simulate({ eventName: 'pull_request', filters: ['public-site'] });
    expect(jobsRunning('pnpm quality:browser-evidence', results)).toEqual(
      jobsRunning(command, results)
    );
  });

  it('no job runs them on a draft PR', () => {
    const results = simulate({ eventName: 'pull_request', draft: true, filters: ALL_FILTERS });
    expect(jobsRunning(command, results)).toEqual([]);
  });
});
