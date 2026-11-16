/**
 * Simulates which ci.yml jobs start for an event and a set of matched path filters, by
 * evaluating the workflow's real `if:`, `name:` and `changes` job `outputs:` expressions.
 * Shared by the CI wiring tests (ci-draft-and-gate, ci-suite-selection) so there is one
 * evaluator of the Actions expression subset ci.yml uses.
 */
import { parse } from 'yaml';

import { workflowSource } from './workflow-test-helpers';

export interface CiStep {
  name?: string;
  if?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}

export interface CiJob {
  name?: string;
  needs?: string | string[];
  if?: string;
  outputs?: Record<string, string>;
  strategy?: { matrix?: { shard?: unknown[] } };
  steps?: CiStep[];
}

export interface CiWorkflow {
  on: { pull_request?: { types?: string[] } };
  concurrency: { group: string; 'cancel-in-progress': string };
  jobs: Record<string, CiJob>;
}

export interface Scenario {
  eventName: 'pull_request' | 'push' | 'workflow_dispatch';
  draft?: boolean;
  repository?: string;
  /** Names of the paths-filter filters that matched. */
  filters: string[];
}

export type JobResult = 'success' | 'failure' | 'skipped';

export const CANONICAL = 'raphaeltm/simple-agent-manager';

export function loadWorkflow(source = workflowSource('ci.yml')): CiWorkflow {
  return parse(source) as CiWorkflow;
}

/** The paths-filter block of the `changes` job, parsed (YAML aliases resolved, not flattened). */
export function pathFilters(workflow = loadWorkflow()): Record<string, unknown[]> {
  const block = workflow.jobs.changes?.steps?.find((step) => step.uses?.startsWith('dorny/'))?.with
    ?.filters;
  if (typeof block !== 'string') throw new Error('ci.yml changes job has no paths-filter block');
  return parse(block) as Record<string, unknown[]>;
}

/** Every filter name, i.e. every value `steps.filter.outputs.<name>` can take. */
export function allFilters(workflow = loadWorkflow()): string[] {
  return Object.keys(pathFilters(workflow));
}

function jobById(workflow: CiWorkflow, id: string): CiJob {
  const job = workflow.jobs[id];
  if (!job) throw new Error(`unknown job ${id}`);
  return job;
}

export function needsOf(job: CiJob): string[] {
  if (!job.needs) return [];
  return Array.isArray(job.needs) ? job.needs : [job.needs];
}

export function githubContext(scenario: Scenario) {
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
export function evaluate(
  expression: string,
  context: Record<string, unknown>,
  functions: Record<string, () => boolean> = {}
): unknown {
  const source = expression
    .trim()
    .replace(/^\$\{\{([\s\S]*)\}\}$/u, '$1')
    .trim();
  const tokenPattern = /'[^']*'|==|!=|&&|\|\||[()!]|[A-Za-z_][\w.-]*(?:\(\))?/gu;
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

export function evaluateName(job: CiJob, scenario: Scenario): string {
  return (job.name ?? '').replace(/\$\{\{([^}]*)\}\}/gu, (_, expression: string) =>
    String(evaluate(expression, { github: githubContext(scenario), matrix: {} }))
  );
}

/**
 * The `changes` job's outputs for a scenario, from its real `outputs:` expressions. A
 * filter output is 'true' when the filter matched and 'false' otherwise, as paths-filter
 * reports it.
 */
export function changesOutputs(scenario: Scenario, workflow = loadWorkflow()) {
  const filterOutputs = Object.fromEntries(
    allFilters(workflow).map((filter) => [
      filter,
      scenario.filters.includes(filter) ? 'true' : 'false',
    ])
  );
  for (const filter of scenario.filters) {
    if (!(filter in filterOutputs)) throw new Error(`unknown filter ${filter}`);
  }
  return Object.fromEntries(
    Object.entries(workflow.jobs.changes?.outputs ?? {}).map(([name, expression]) => [
      name,
      String(
        evaluate(expression, {
          github: githubContext(scenario),
          steps: { filter: { outputs: filterOutputs } },
        })
      ),
    ])
  );
}

/**
 * Simulates which jobs start for a scenario. A job runs when its `if` is true and,
 * unless the expression calls a status function, every job it needs succeeded. Jobs
 * that run are treated as succeeding unless listed in `failing`.
 */
export function simulate(
  scenario: Scenario,
  workflow = loadWorkflow(),
  failing: string[] = []
): Map<string, JobResult> {
  const outputs = changesOutputs(scenario, workflow);
  const results = new Map<string, JobResult>();
  const pending = Object.keys(workflow.jobs);
  while (pending.length > 0) {
    const index = pending.findIndex((id) =>
      needsOf(jobById(workflow, id)).every((need) => results.has(need))
    );
    const [id] = index < 0 ? [] : pending.splice(index, 1);
    if (id === undefined) throw new Error('needs graph has a cycle or an unknown job');
    const job = jobById(workflow, id);
    const needs = Object.fromEntries(
      needsOf(job).map((need) => [
        need,
        { result: results.get(need), outputs: need === 'changes' ? outputs : {} },
      ])
    );
    const condition = job.if ?? 'success()';
    // Actions adds an implicit success() unless the expression calls a status function.
    const usesStatusFunction = /\b(?:always|cancelled|failure|success)\(\)/u.test(condition);
    const needsSucceeded = needsOf(job).every((need) => results.get(need) === 'success');
    const allowed = evaluate(
      condition,
      { github: githubContext(scenario), needs },
      {
        always: () => true,
        success: () => needsSucceeded,
        failure: () => !needsSucceeded,
        cancelled: () => false,
      }
    );
    const runs = Boolean(allowed) && (usesStatusFunction || needsSucceeded);
    // A job that runs after a failed need (via a status function) reports that failure,
    // as the Test job's first step does. A need skipped by its own filter is not a
    // failure. The gate is judged by its real steps instead.
    const inheritsFailure =
      id !== 'durable-object-workers' &&
      needsOf(job).some((need) => results.get(need) === 'failure');
    let result: JobResult = 'skipped';
    if (runs) result = failing.includes(id) || inheritsFailure ? 'failure' : 'success';
    results.set(id, result);
  }
  return results;
}

export function started(results: Map<string, string>): string[] {
  return [...results].filter(([, result]) => result !== 'skipped').map(([id]) => id);
}

export function jobsRunning(
  command: string,
  results: Map<string, string>,
  workflow = loadWorkflow()
): string[] {
  return started(results).filter((id) =>
    (jobById(workflow, id).steps ?? []).some((step) => step.run?.includes(command))
  );
}

/** Jobs a run starts, counting every matrix entry. */
export function jobCount(results: Map<string, string>, workflow = loadWorkflow()): number {
  return started(results).reduce(
    (sum, id) => sum + (jobById(workflow, id).strategy?.matrix?.shard ?? [1]).length,
    0
  );
}
