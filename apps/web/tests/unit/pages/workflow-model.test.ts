/**
 * The Workflows view model: stages, progress, plain-language explanations, links. These are the
 * words people read to decide what to do, so each state is pinned to its exact sentence.
 */
import type { WorkflowRunDetail, WorkflowStepDetail } from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import {
  artifactLink,
  libraryFilePath,
  pullRequestLink,
} from '../../../src/pages/automation/workflows/links';
import {
  activityText,
  attentionStep,
  blockingStep,
  explainStep,
  progressSentence,
  runHeadline,
  stagesOf,
  stageTitle,
  startsAfterLine,
  stepStatusMeta,
  workflowProgress,
} from '../../../src/pages/automation/workflows/model';

const NOW = Date.parse('2026-10-21T20:00:00Z');
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const MIN = 60_000;

function step(
  overrides: Partial<WorkflowStepDetail> & Pick<WorkflowStepDetail, 'key'>
): WorkflowStepDetail {
  return {
    title: overrides.key,
    kind: 'agent',
    status: 'waiting',
    reason: null,
    ordinal: 0,
    after: [],
    instructions: 'Do it',
    agent: { profileId: 'p', profileName: 'Writer', agentType: 'claude-code', model: null },
    attemptId: `a-${overrides.key}`,
    taskId: null,
    sessionId: null,
    taskStatus: null,
    launchAttempts: 0,
    startedAt: null,
    finishedAt: null,
    updatedAt: iso(0),
    output: null,
    wait: null,
    ...overrides,
  };
}

function run(
  steps: WorkflowStepDetail[],
  overrides: Partial<WorkflowRunDetail> = {}
): WorkflowRunDetail {
  return {
    id: 'run-1',
    title: 'Release notes',
    goal: 'Ship them',
    status: 'active',
    startedByUserId: 'owner',
    createdAt: iso(-60 * MIN),
    updatedAt: iso(0),
    deadlineAt: iso(60 * MIN),
    startedFrom: null,
    maxParallelSteps: 2,
    steps,
    activity: [],
    ...overrides,
  };
}

describe('stages', () => {
  it('groups a fan-out and fan-in by when each step can run', () => {
    const steps = [
      step({ key: 'merge', ordinal: 3, after: ['a', 'b'] }),
      step({ key: 'plan', ordinal: 0 }),
      step({ key: 'b', ordinal: 2, after: ['plan'] }),
      step({ key: 'a', ordinal: 1, after: ['plan'] }),
    ];
    expect(stagesOf(steps).map((stage) => stage.map((s) => s.key))).toEqual([
      ['plan'],
      ['a', 'b'],
      ['merge'],
    ]);
  });

  it('puts a step after its latest prerequisite, not its first', () => {
    const steps = [
      step({ key: 'draft', ordinal: 0 }),
      step({ key: 'review', ordinal: 1, after: ['draft'] }),
      step({ key: 'revise', ordinal: 2, after: ['draft', 'review'] }),
    ];
    expect(stagesOf(steps).map((stage) => stage.map((s) => s.key))).toEqual([
      ['draft'],
      ['review'],
      ['revise'],
    ]);
  });

  it('ignores an unknown prerequisite and survives a cycle in malformed data', () => {
    const steps = [
      step({ key: 'x', ordinal: 0, after: ['missing'] }),
      step({ key: 'y', ordinal: 1, after: ['z'] }),
      step({ key: 'z', ordinal: 2, after: ['y'] }),
    ];
    expect(
      stagesOf(steps)
        .flat()
        .map((s) => s.key)
        .sort()
    ).toEqual(['x', 'y', 'z']);
  });

  it('titles stages as a recipe and stays quiet for a single step', () => {
    expect(stageTitle(0, 3, 1)).toBe('First');
    expect(stageTitle(1, 3, 2)).toBe('Then · at the same time');
    expect(stageTitle(2, 3, 1)).toBe('Finally');
    expect(stageTitle(0, 1, 3)).toBe('All at the same time');
    expect(stageTitle(0, 1, 1)).toBeNull();
  });

  it('says "starts after" only when a step does not wait for the whole stage before it', () => {
    const titleOf = (key: string) => key.toUpperCase();
    const previous = [step({ key: 'a' }), step({ key: 'b' })];
    expect(startsAfterLine(step({ key: 'c', after: ['a', 'b'] }), previous, titleOf)).toBeNull();
    expect(startsAfterLine(step({ key: 'c', after: ['a'] }), previous, titleOf)).toBe(
      'Starts after “A”'
    );
    expect(startsAfterLine(step({ key: 'c', after: ['a', 'x', 'y'] }), previous, titleOf)).toBe(
      'Starts after “A”, “X” and “Y”'
    );
    expect(startsAfterLine(step({ key: 'c' }), previous, titleOf)).toBeNull();
  });
});

describe('progress and headlines', () => {
  it('counts every state once and words it for the run status', () => {
    const steps = [
      step({ key: 'a', status: 'completed' }),
      step({ key: 'b', status: 'running' }),
      step({ key: 'c', status: 'starting' }),
      step({ key: 'd', status: 'failed' }),
      step({ key: 'e', status: 'blocked' }),
      step({ key: 'f', status: 'waiting' }),
    ];
    const progress = workflowProgress(steps);
    expect(progress).toEqual({ total: 6, done: 1, active: 2, waiting: 1, failed: 1, blocked: 1 });
    expect(progressSentence(progress, 'active')).toBe(
      '1 of 6 steps done · 2 running · 1 failed · 1 blocked · 1 waiting'
    );
    // A stopped run has nothing "waiting" to report.
    expect(progressSentence(progress, 'needs_attention')).toBe(
      '1 of 6 steps done · 2 running · 1 failed · 1 blocked'
    );
    expect(
      progressSentence(workflowProgress([step({ key: 'a', status: 'completed' })]), 'completed')
    ).toBe('The step is done');
  });

  it('headlines the failure, the work in progress, a hold, or completion', () => {
    expect(
      runHeadline({
        status: 'needs_attention',
        steps: [
          step({ key: 'fix', title: 'Fix it', status: 'failed' }),
          step({ key: 'ship', status: 'blocked' }),
          step({ key: 'tell', status: 'blocked' }),
        ],
      })
    ).toBe('“Fix it” failed · 2 steps did not start');
    expect(
      runHeadline({
        status: 'active',
        steps: [
          step({ key: 'a', title: 'Review', status: 'running' }),
          step({ key: 'b', title: 'Check', status: 'running' }),
          step({ key: 'c', status: 'waiting' }),
        ],
      })
    ).toBe('Working on “Review” and 1 more · 0 of 3 done');
    expect(
      runHeadline({
        status: 'active',
        steps: [step({ key: 'ci', title: 'Wait for CI', kind: 'wait', status: 'running' })],
      })
    ).toBe('Listening on “Wait for CI” · 0 of 1 done');
    expect(
      runHeadline({
        status: 'active',
        steps: [step({ key: 'a', status: 'waiting', reason: 'Waiting for project task capacity' })],
      })
    ).toBe('Held: Waiting for project task capacity');
    expect(
      runHeadline({
        status: 'completed',
        steps: [step({ key: 'a', status: 'completed' }), step({ key: 'b', status: 'completed' })],
      })
    ).toBe('All 2 steps done');
    expect(runHeadline({ status: 'needs_attention', steps: [] })).toBe(
      'Stopped before every step finished'
    );
  });

  it('points attention at the first failure, else the first blocked step', () => {
    const failed = step({ key: 'b', status: 'failed' });
    expect(attentionStep([step({ key: 'a', status: 'blocked' }), failed])).toBe(failed);
    const blocked = step({ key: 'a', status: 'blocked' });
    expect(attentionStep([step({ key: 'z', status: 'completed' }), blocked])).toBe(blocked);
    expect(attentionStep([step({ key: 'a', status: 'completed' })])).toBeNull();
  });
});

describe('what a step is doing', () => {
  it('names the prerequisites a waiting step still needs', () => {
    const steps = [
      step({ key: 'a', title: 'Draft', status: 'completed' }),
      step({ key: 'b', title: 'Review', status: 'running' }),
      step({ key: 'c', title: 'Check', status: 'waiting' }),
      step({ key: 'd', after: ['a', 'b', 'c'] }),
    ];
    expect(explainStep(steps[3]!, run(steps)).text).toBe(
      'Starts after “Review” and “Check” finish.'
    );
  });

  it('tells a ready step held by the engine from one that is about to start', () => {
    const parent = step({ key: 'a', status: 'completed' });
    const held = step({ key: 'b', after: ['a'], reason: 'Waiting for project task capacity' });
    expect(explainStep(held, run([parent, held])).text).toBe(
      'Ready, but held: Waiting for project task capacity'
    );
    const ready = step({ key: 'b', after: ['a'] });
    expect(explainStep(ready, run([parent, ready])).text).toBe(
      'Ready. SAM starts it shortly; at most 2 steps run at once.'
    );
    expect(explainStep(ready, run([parent, ready], { maxParallelSteps: null })).text).toBe(
      'Ready. SAM starts it shortly.'
    );
  });

  it('reports launch retries and the last launch problem', () => {
    const starting = step({
      key: 'a',
      status: 'starting',
      launchAttempts: 3,
      reason: 'Repository check timed out',
    });
    expect(explainStep(starting, run([starting])).text).toBe(
      'Starting its agent (try 3). Last problem: Repository check timed out'
    );
  });

  it("quotes the engine's failure reason and explains a blocked step by its cause", () => {
    const failed = step({ key: 'fix', title: 'Fix it', status: 'failed', reason: 'Task failed' });
    const blocked = step({
      key: 'ship',
      status: 'blocked',
      after: ['fix'],
      reason: 'Blocked: fix did not succeed',
    });
    const later = step({ key: 'tell', status: 'blocked', after: ['ship'] });
    const detail = run([failed, blocked, later]);
    expect(explainStep(failed, detail)).toEqual({ text: 'Task failed', tone: 'danger' });
    expect(explainStep(blocked, detail).text).toBe(
      'Did not start because “Fix it” did not succeed.'
    );
    // Two levels down still points at the step that actually failed.
    expect(blockingStep(later, detail.steps)?.key).toBe('fix');
    expect(blockingStep(failed, detail.steps)).toBeNull();
  });

  it('describes an event-wait step listening, heard, and timed out', () => {
    const wait = {
      description: 'CI to finish on pull request #2405',
      source: 'github',
      eventTypes: ['check_suite.completed'],
      subject: { type: 'pull_request', id: '2405' },
      listeningSince: iso(-10 * MIN),
      timeoutAt: iso(50 * MIN),
      matchedEvent: null,
      timedOut: false,
    };
    const listening = step({ key: 'ci', kind: 'wait', agent: null, status: 'running', wait });
    expect(explainStep(listening, run([listening]), NOW).text).toBe(
      'Listening for CI to finish on pull request #2405. Gives up in 50 min.'
    );
    expect(stepStatusMeta(listening).label).toBe('Listening');

    const heard = step({
      key: 'ci',
      kind: 'wait',
      status: 'completed',
      wait: {
        ...wait,
        matchedEvent: {
          id: 'e1',
          eventType: 'check_suite.completed',
          occurredAt: iso(-5 * MIN),
          title: 'CI passed',
        },
      },
    });
    expect(explainStep(heard, run([heard]), NOW).text).toBe('Heard “CI passed” 5 min ago.');
    expect(stepStatusMeta(heard).label).toBe('Heard it');

    const timedOut = step({
      key: 'ci',
      kind: 'wait',
      status: 'failed',
      reason: 'Timed out',
      wait: { ...wait, timedOut: true },
    });
    expect(explainStep(timedOut, run([timedOut]), NOW).text).toBe(
      'Timed out waiting for CI to finish on pull request #2405.'
    );
    expect(stepStatusMeta(timedOut).label).toBe('Timed out');
  });

  it('words lifecycle events, including ones it does not know', () => {
    const titleOf = (key: string) => (key === 'ci' ? 'Wait for CI' : 'Draft');
    const kindOf = (key: string) => (key === 'ci' ? ('wait' as const) : ('agent' as const));
    expect(activityText({ stepKey: 'draft', state: 'completed' }, titleOf, kindOf)).toBe(
      '“Draft” finished'
    );
    expect(activityText({ stepKey: 'draft', state: 'blocked' }, titleOf, kindOf)).toBe(
      '“Draft” did not start'
    );
    expect(activityText({ stepKey: 'ci', state: 'running' }, titleOf, kindOf)).toBe(
      '“Wait for CI” started listening'
    );
    expect(activityText({ stepKey: null, state: 'needs_attention' }, titleOf, kindOf)).toBe(
      'The workflow needs attention'
    );
    expect(activityText({ stepKey: 'draft', state: 'paused_by_admin' }, titleOf, kindOf)).toBe(
      '“Draft” paused by admin'
    );
  });
});

describe('output links', () => {
  it('links Library files, pull requests and http(s) URLs, and nothing else', () => {
    expect(
      artifactLink({ type: 'library_file', ref: '01M5H0Z9X1Y2Z3A4B5C6D7E8F9' }, 'p1')
    ).toMatchObject({
      kind: 'library',
      href: libraryFilePath('p1', '01M5H0Z9X1Y2Z3A4B5C6D7E8F9'),
      external: false,
    });
    expect(libraryFilePath('p1', 'F1')).toBe('/projects/p1/library?preview=F1');
    expect(
      artifactLink({ type: 'pr', ref: 'https://github.com/acme/repo/pull/12' }, 'p1')
    ).toMatchObject({
      kind: 'pull-request',
      detail: 'acme/repo/pull/12',
      external: true,
    });
    expect(artifactLink({ type: 'url', ref: 'https://example.com/report' }, 'p1')).toMatchObject({
      kind: 'url',
      href: 'https://example.com/report',
    });
    expect(artifactLink({ type: 'branch', ref: 'sam/fix' }, 'p1')).toMatchObject({
      kind: 'branch',
      href: null,
    });
    // A "library" reference that is not a Library ID is shown, not linked.
    expect(artifactLink({ type: 'library_file', ref: '../../etc/passwd' }, 'p1')).toMatchObject({
      kind: 'text',
      href: null,
    });
    // Agent-written links never become script URLs.
    expect(artifactLink({ type: 'url', ref: 'javascript:alert(1)' }, 'p1').href).toBeNull();
    expect(pullRequestLink('javascript:alert(1)')).toMatchObject({ href: null, external: false });
  });
});
