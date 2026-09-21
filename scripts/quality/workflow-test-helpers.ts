/**
 * Shared parsing helpers for tests that assert on `.github/workflows/*`.
 *
 * These lived separately in `deployment-workflow-hardening.test.ts` and
 * `deploy-safety.test.ts` and had already drifted — one matched `*.yml`, the
 * other `*.ya?ml`, so a `.yaml` workflow would have been silently skipped by
 * one scanner and checked by the other. Keep every workflow scanner pointed at
 * this module so "what counts as a workflow file" has exactly one answer.
 */
import { readdirSync, readFileSync } from 'node:fs';

import { parse } from 'yaml';

export interface WorkflowStep {
  name?: string;
  if?: string;
  run?: string;
  env?: Record<string, unknown>;
}

export interface ParsedWorkflow {
  on?: { workflow_dispatch?: { inputs?: Record<string, unknown> } };
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  jobs?: Record<string, { environment?: string; steps?: WorkflowStep[] }>;
}

export function workflowSource(path: string): string {
  return readFileSync(new URL(`../../.github/workflows/${path}`, import.meta.url), 'utf8');
}

export function parsedWorkflow(path: string): ParsedWorkflow {
  return parse(workflowSource(path)) as ParsedWorkflow;
}

export function workflowFileNames(): string[] {
  return readdirSync(new URL('../../.github/workflows/', import.meta.url))
    .filter((path) => /\.ya?ml$/u.test(path))
    .sort();
}

export function allWorkflowRunBlocks(): Array<{ path: string; stepName: string; run: string }> {
  return workflowFileNames().flatMap((path) => {
    const parsed = parsedWorkflow(path);
    return Object.values(parsed.jobs ?? {}).flatMap((job) =>
      (job.steps ?? []).flatMap((step) =>
        typeof step.run === 'string'
          ? [{ path, stepName: step.name ?? '<unnamed step>', run: step.run }]
          : []
      )
    );
  });
}

export function namedStep(parsed: ParsedWorkflow, name: string): WorkflowStep {
  const step = Object.values(parsed.jobs ?? {})
    .flatMap((job) => job.steps ?? [])
    .find((candidate) => candidate.name === name);
  if (!step) throw new Error(`Workflow step not found: ${name}`);
  return step;
}

/**
 * The `run:` script of a named step. Throws rather than returning empty when
 * the step is missing or has no script, so a renamed or restructured step
 * fails the calling test instead of silently asserting on nothing.
 */
export function namedStepRun(parsed: ParsedWorkflow, name: string): string {
  const { run } = namedStep(parsed, name);
  if (!run) throw new Error(`Workflow step has no run block: ${name}`);
  return run;
}
