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
import { parse } from 'yaml';

import { workflowSource } from './workflow-test-helpers';

interface Job {
  name?: string;
  needs?: string | string[];
  if?: string;
  steps?: Array<{ name?: string; if?: string; run?: string }>;
}

interface Workflow {
  on: { pull_request?: { types?: string[] } };
  concurrency: { group: string; 'cancel-in-progress': string };
  jobs: Record<string, Job>;
}

const CANONICAL = 'raphaeltm/simple-agent-manager';
const REQUIRED_CHECK = 'Durable Object Workers';
const QUICK_JOBS = ['changes', 'pr-evidence', 'lint', 'secret-scan', 'typecheck', 'code-quality'];
const ALL_FILTERS = [
  'api',
  'vm-agent',
  'cli',
  'devcontainer',
  'devcontainer-volume-mount',
  'infra',
  'deploy-scripts',
  'ci-workflow',
  'marketing-site',
  'repo-quality',
  'web-ui',
  'browser-install',
  'go-modules',
];

interface Scenario {
  eventName: 'pull_request' | 'push' | 'workflow_dispatch';
  draft?: boolean;
  repository?: string;
  filters: string[];
}

function loadWorkflow(source = workflowSource('ci.yml')): Workflow {
  return parse(source) as Workflow;
}

function needsOf(job: Job): string[] {
  if (!job.needs) return [];
  return Array.isArray(job.needs) ? job.needs : [job.needs];
}

function githubContext(scenario: Scenario) {
  return {
    event_name: scenario.eventName,
    repository: scenario.repository ?? CANONICAL,
    ref: scenario.eventName === 'pull_request' ? 'refs/pull/1/merge' : 'refs/heads/main',
    sha: 'a'.repeat(40),
    event:
      scenario.eventName === 'pull_request'
        ? { pull_request: { draft: scenario.draft ?? false } }
        : {},
  };
}

/**
 * Evaluates the subset of the GitHub Actions expression language that ci.yml uses
 * (`==`, `!=`, `&&`, `||`, `!`, parentheses, quoted strings, property paths with
 * hyphenated keys, `always()`, `cancelled()`). Property access on a missing object
 * yields null, as it does in Actions. Throws on anything else, so an unsupported
 * construct fails the test instead of being misread.
 */
function evaluate(
  expression: string,
  context: Record<string, unknown>,
  functions: Record<string, () => boolean> = {}
): unknown {
  const source = expression
    .trim()
    .replace(/^\$\{\{([\s\S]*)\}\}$/u, '$1')
    .trim();
  const tokenPattern = /'[^']*'|==|!=|&&|\|\||[()!]|[A-Za-z_][\w.-]*\(\)|[A-Za-z_][\w.-]*/gu;
  const tokens = source.match(tokenPattern);
  if (!tokens || source.replace(tokenPattern, '').trim() !== '') {
    throw new Error(`Unsupported expression syntax: ${source}`);
  }
  let position = 0;
  const peek = () => tokens[position];
  const next = () => tokens[position++] ?? '';

  const lookup = (path: string): unknown => {
    let value: unknown = context;
    for (const key of path.split('.')) {
      if (value === null || value === undefined || typeof value !== 'object') return null;
      value = (value as Record<string, unknown>)[key];
    }
    return value ?? null;
  };
  const truthy = (value: unknown) =>
    value !== null && value !== false && value !== '' && value !== 0;
  const loose = (value: unknown) => (typeof value === 'string' ? value.toLowerCase() : value);

  const primary = (): unknown => {
    const token = next();
    if (token === '(') {
      const value = or();
      if (next() !== ')') throw new Error(`Missing ) in ${source}`);
      return value;
    }
    if (token === '!') return !truthy(primary());
    if (token.startsWith("'")) return token.slice(1, -1);
    if (token.endsWith('()')) {
      const fn = functions[token.slice(0, -2)];
      if (!fn) throw new Error(`Unsupported function ${token} in ${source}`);
      return fn();
    }
    if (token === 'true') return true;
    if (token === 'false') return false;
    return lookup(token);
  };
  const comparison = (): unknown => {
    let left = primary();
    while (peek() === '==' || peek() === '!=') {
      const operator = next();
      const right = primary();
      left = operator === '==' ? loose(left) === loose(right) : loose(left) !== loose(right);
    }
    return left;
  };
  const and = (): unknown => {
    let left = comparison();
    while (peek() === '&&') {
      next();
      const right = comparison();
      left = truthy(left) ? right : left;
    }
    return left;
  };
  const or = (): unknown => {
    let left = and();
    while (peek() === '||') {
      next();
      const right = and();
      left = truthy(left) ? left : right;
    }
    return left;
  };
  const value = or();
  if (position !== tokens.length) throw new Error(`Trailing tokens in ${source}`);
  return value;
}

function evaluateName(job: Job, scenario: Scenario): string {
  return (job.name ?? '').replace(/\$\{\{([^}]*)\}\}/gu, (_, expression: string) =>
    String(evaluate(expression, { github: githubContext(scenario), matrix: {} }))
  );
}

/**
 * Simulates which jobs start for a scenario. A job runs when its `if` is true and,
 * unless the expression calls always(), every job it needs succeeded. Jobs that run
 * are treated as succeeding unless listed in `failing`.
 */
function simulate(
  scenario: Scenario,
  workflow = loadWorkflow(),
  failing: string[] = []
): Map<string, 'success' | 'failure' | 'skipped'> {
  const outputs = Object.fromEntries(
    ALL_FILTERS.map((filter) => [filter, scenario.filters.includes(filter) ? 'true' : 'false'])
  );
  const results = new Map<string, 'success' | 'failure' | 'skipped'>();
  const pending = Object.keys(workflow.jobs);
  while (pending.length > 0) {
    const index = pending.findIndex((id) =>
      needsOf(workflow.jobs[id]!).every((need) => results.has(need))
    );
    expect(index, 'needs graph has a cycle or an unknown job').toBeGreaterThanOrEqual(0);
    const id = pending.splice(index, 1)[0]!;
    const job = workflow.jobs[id]!;
    const needs = Object.fromEntries(
      needsOf(job).map((need) => [
        need,
        { result: results.get(need), outputs: need === 'changes' ? outputs : {} },
      ])
    );
    const condition = job.if ?? 'success()';
    const usesAlways = /\balways\(\)/u.test(condition);
    const needsSucceeded = needsOf(job).every((need) => results.get(need) === 'success');
    const allowed = evaluate(
      condition,
      { github: githubContext(scenario), needs },
      { always: () => true, success: () => needsSucceeded, cancelled: () => false }
    );
    const runs = Boolean(allowed) && (usesAlways || needsSucceeded);
    results.set(id, runs ? (failing.includes(id) ? 'failure' : 'success') : 'skipped');
  }
  return results;
}

function started(results: Map<string, string>): string[] {
  return [...results].filter(([, result]) => result !== 'skipped').map(([id]) => id);
}

function jobsRunning(command: string, results: Map<string, string>, workflow = loadWorkflow()) {
  return started(results).filter((id) =>
    (workflow.jobs[id]!.steps ?? []).some((step) => step.run?.includes(command))
  );
}

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
    const expected = Object.keys(loadWorkflow().jobs).filter((id) => id !== 'marketing-site');
    expect(started(results).sort()).toEqual(expected.sort());
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
    const results = simulate({ eventName: 'pull_request', filters: ['repo-quality'] });
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

  it('still runs, and so can fail, when a full-suite job fails', () => {
    const results = simulate(
      { eventName: 'pull_request', filters: ['repo-quality'] },
      loadWorkflow(),
      ['test-api']
    );
    expect(results.get('test')).toBe('success'); // runs (always()) and then fails its own check
    expect(results.get(gateId)).toBe('success'); // started; its step decides the verdict
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
          'marketing-site': 'skipped',
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
    ['repo-quality and marketing changes', ['repo-quality', 'marketing-site', 'web-ui']],
    ['repo-quality only', ['repo-quality']],
    ['marketing-only', ['marketing-site']],
    ['browser-install helper only', ['browser-install', 'ci-workflow']],
    ['main push with everything', ALL_FILTERS],
  ])('exactly one job runs them for %s', (_, filters) => {
    const eventName = filters === ALL_FILTERS ? 'push' : 'pull_request';
    const results = simulate({ eventName, filters } as Scenario);
    expect(jobsRunning(command, results)).toHaveLength(1);
  });

  it('the job that runs them also checks the evidence when Storybook runs', () => {
    const results = simulate({ eventName: 'pull_request', filters: ['repo-quality'] });
    expect(jobsRunning('pnpm quality:browser-evidence', results)).toEqual(
      jobsRunning(command, results)
    );
  });

  it('no job runs them on a draft PR', () => {
    const results = simulate({ eventName: 'pull_request', draft: true, filters: ALL_FILTERS });
    expect(jobsRunning(command, results)).toEqual([]);
  });
});

describe('runner budget', () => {
  it('a ready PR that changes everything starts at most 28 jobs (29 before the split)', () => {
    const workflow = loadWorkflow();
    const results = simulate({ eventName: 'pull_request', filters: ALL_FILTERS });
    const matrixSize = (id: string) =>
      (
        (workflow.jobs[id] as { strategy?: { matrix?: { shard?: unknown[] } } }).strategy?.matrix
          ?.shard ?? [1]
      ).length;
    const jobs = started(results).reduce((sum, id) => sum + matrixSize(id), 0);
    expect(jobs).toBeLessThanOrEqual(28);
  });
});
