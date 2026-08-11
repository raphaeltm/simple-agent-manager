import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

function read(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

const selector = read('src/services/node-selector.ts');
const evaluator = read('src/services/placement-explanation.ts');
const taskRunner = [
  'node-steps.ts',
  'workspace-steps.ts',
  'placement.ts',
  'provisioning-guards.ts',
  'state-machine.ts',
]
  .map((file) => read(`src/durable-objects/task-runner/${file}`))
  .join('\n');
const trial = ['steps.ts', 'placement.ts', 'index.ts']
  .map((file) => read(`src/durable-objects/trial-orchestrator/${file}`))
  .join('\n');
const manual = ['crud.ts', 'manual-placement.ts']
  .map((file) => read(`src/routes/workspaces/${file}`))
  .join('\n');
const lifecycle = read('src/durable-objects/node-lifecycle.ts');

describe('node placement vertical wiring', () => {
  it('retains atomic warm claims in NodeLifecycle', () => {
    expect(lifecycle).toContain("state.status !== 'warm'");
    expect(lifecycle).toContain("state.status = 'active'");
    expect(lifecycle).toContain('state.claimedByTask = taskId');
  });

  it('has one reusable selector for TaskRunner, trials, and manual placement', () => {
    expect(taskRunner).toContain('selectNodeWithExplanation(');
    expect(trial).toContain('selectNodeWithExplanation(');
    expect(manual).toContain('selectNodeWithExplanation(');
  });

  it('retains the exact compatibility predicate in the canonical evaluator', () => {
    expect(evaluator).toContain('isNodeAgentVersionCompatible(');
    expect(selector).not.toContain('agentVersion ===');
  });

  it('persists TaskRunner decisions before provisioning and copies them to workspaces', () => {
    const selectIndex = taskRunner.indexOf(
      'persistTaskPlacement(state, rc, placement.explanation)'
    );
    const provisionIndex = taskRunner.indexOf("advanceToStep(state, 'node_provisioning')");
    expect(selectIndex).toBeGreaterThan(-1);
    expect(provisionIndex).toBeGreaterThan(selectIndex);
    expect(taskRunner).toContain('placementExplanationJson: state.placementExplanation');
  });

  it('persists trial and manual decisions, including failure updates', () => {
    expect(trial).toContain('UPDATE trials SET placement_explanation_json = ?');
    expect(trial).toContain('recordTrialPlacementFailure');
    expect(trial).toContain('placementExplanationJson: state.placementExplanation');
    expect(manual).toContain('placementExplanationJson: JSON.stringify(placementExplanation)');
    expect(manual).toContain("failureReason: 'readiness-timeout'");
  });

  it('logs only the allowlisted placement object at decision boundaries', () => {
    expect(taskRunner).toContain("log.info('task_runner_do.placement_decided'");
    expect(trial).toContain("log.info('trial_orchestrator_do.placement_decided'");
    expect(evaluator).not.toContain('providerError');
    expect(evaluator).not.toContain('repository');
  });
});
