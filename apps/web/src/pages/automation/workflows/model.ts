/**
 * The Workflows pages' view model: plain words for engine states, stages for the checklist,
 * and the one-line explanations that say what a step is doing or why it stopped.
 *
 * Everything here is derived from the read contract in `@simple-agent-manager/shared`
 * (`types/workflow.ts`); nothing is invented. In particular there is no retry, skip, pause or
 * cancel: the engine has none, so the only next steps offered are opening a chat or a step.
 */
import type {
  WorkflowRunDetail,
  WorkflowRunStatus,
  WorkflowRunSummary,
  WorkflowStepDetail,
  WorkflowStepStatus,
  WorkflowStepSummary,
} from '@simple-agent-manager/shared';

import { formatDuration, formatTimeFromNow } from '../../../lib/time-utils';

export type Tone = 'muted' | 'info' | 'success' | 'warning' | 'danger';

// ---------------------------------------------------------------------------
// Words for states
// ---------------------------------------------------------------------------

/** Run states as people say them, with the shared StatusBadge status that colours them. */
export const RUN_STATUS_META: Record<WorkflowRunStatus, { label: string; badge: string }> = {
  active: { label: 'Running', badge: 'running' },
  completed: { label: 'Done', badge: 'completed' },
  needs_attention: { label: 'Needs attention', badge: 'warning' },
};

const STEP_STATUS_META: Record<WorkflowStepStatus, { label: string; badge: string; tone: Tone }> = {
  waiting: { label: 'Waiting', badge: 'pending', tone: 'muted' },
  starting: { label: 'Starting', badge: 'creating', tone: 'info' },
  running: { label: 'Running', badge: 'running', tone: 'success' },
  completed: { label: 'Done', badge: 'completed', tone: 'success' },
  failed: { label: 'Failed', badge: 'failed', tone: 'danger' },
  blocked: { label: 'Blocked', badge: 'cancelled', tone: 'muted' },
};

type StepLike = Pick<WorkflowStepSummary, 'kind' | 'status'> & {
  wait?: WorkflowStepDetail['wait'];
};

/** A step's state in words. A wait step listens rather than runs, and can time out. */
export function stepStatusMeta(step: StepLike): { label: string; badge: string; tone: Tone } {
  const meta = STEP_STATUS_META[step.status];
  if (step.kind !== 'wait') return meta;
  if (step.status === 'running') return { ...meta, label: 'Listening' };
  if (step.status === 'completed') return { ...meta, label: 'Heard it' };
  if (step.status === 'failed' && step.wait?.timedOut) return { ...meta, label: 'Timed out' };
  return meta;
}

const OPEN_STATES: ReadonlySet<WorkflowStepStatus> = new Set(['starting', 'running']);

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

export interface WorkflowProgress {
  total: number;
  done: number;
  /** Starting or running. */
  active: number;
  waiting: number;
  failed: number;
  blocked: number;
}

export function workflowProgress(steps: ReadonlyArray<{ status: WorkflowStepStatus }>) {
  const progress: WorkflowProgress = {
    total: steps.length,
    done: 0,
    active: 0,
    waiting: 0,
    failed: 0,
    blocked: 0,
  };
  for (const step of steps) {
    if (step.status === 'completed') progress.done++;
    else if (OPEN_STATES.has(step.status)) progress.active++;
    else if (step.status === 'failed') progress.failed++;
    else if (step.status === 'blocked') progress.blocked++;
    else progress.waiting++;
  }
  return progress;
}

/** "2 of 5 steps done · 1 running · 1 failed · 1 blocked". */
export function progressSentence(progress: WorkflowProgress, status: WorkflowRunStatus): string {
  if (status === 'completed' && progress.done === progress.total)
    return progress.total === 1 ? 'The step is done' : `All ${progress.total} steps done`;
  const parts = [
    `${progress.done} of ${progress.total} ${progress.total === 1 ? 'step' : 'steps'} done`,
  ];
  if (progress.active) parts.push(`${progress.active} running`);
  if (progress.failed) parts.push(`${progress.failed} failed`);
  if (progress.blocked) parts.push(`${progress.blocked} blocked`);
  if (progress.waiting && status === 'active') parts.push(`${progress.waiting} waiting`);
  return parts.join(' · ');
}

const quoted = (title: string) => `“${title}”`;

/** The one line a list row shows under the title: what is happening, or what went wrong. */
export function runHeadline(run: Pick<WorkflowRunSummary, 'status' | 'steps'>): string {
  const progress = workflowProgress(run.steps);
  if (run.status === 'completed') return progressSentence(progress, run.status);
  const failed = run.steps.find((step) => step.status === 'failed');
  if (failed) {
    const blocked = progress.blocked
      ? ` · ${progress.blocked} ${progress.blocked === 1 ? 'step' : 'steps'} did not start`
      : '';
    return `${quoted(failed.title)} failed${blocked}`;
  }
  if (run.status === 'needs_attention') return 'Stopped before every step finished';
  const open = run.steps.filter((step) => OPEN_STATES.has(step.status));
  const [first] = open;
  if (first) {
    const verb = first.kind === 'wait' && first.status === 'running' ? 'Listening' : 'Working';
    const more = open.length > 1 ? ` and ${open.length - 1} more` : '';
    return `${verb} on ${quoted(first.title)}${more} · ${progress.done} of ${progress.total} done`;
  }
  const held = run.steps.find((step) => step.status === 'waiting' && step.reason);
  if (held?.reason) return `Waiting: ${held.reason}`;
  return `Starting the next step · ${progress.done} of ${progress.total} done`;
}

/** The step a needs-attention run is about: the first failure, else the first blocked step. */
export function attentionStep<T extends { status: WorkflowStepStatus }>(steps: T[]): T | null {
  return (
    steps.find((step) => step.status === 'failed') ??
    steps.find((step) => step.status === 'blocked') ??
    null
  );
}

// ---------------------------------------------------------------------------
// Stages (the checklist and the graph share them)
// ---------------------------------------------------------------------------

type GraphStep = Pick<WorkflowStepDetail, 'key' | 'after' | 'ordinal'>;

/**
 * Steps grouped by when they can run: a step's stage is one after its latest prerequisite's.
 * Plan order breaks ties. Unknown prerequisites (a malformed row) are ignored, never fatal.
 */
export function stagesOf<T extends GraphStep>(steps: T[]): T[][] {
  const byKey = new Map(steps.map((step) => [step.key, step]));
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (key: string): number => {
    const known = depth.get(key);
    if (known !== undefined) return known;
    const step = byKey.get(key);
    if (!step || visiting.has(key)) return 0;
    visiting.add(key);
    const parents = step.after.filter((parent) => byKey.has(parent));
    const value = parents.length ? 1 + Math.max(...parents.map(depthOf)) : 0;
    visiting.delete(key);
    depth.set(key, value);
    return value;
  };
  const stages: T[][] = [];
  for (const step of [...steps].sort((a, b) => a.ordinal - b.ordinal)) {
    const index = depthOf(step.key);
    (stages[index] ??= []).push(step);
  }
  return stages.filter((stage) => stage.length > 0);
}

/** "First", "Then · at the same time", "Finally"; null when a heading would add nothing. */
export function stageTitle(index: number, count: number, size: number): string | null {
  if (count === 1) return size > 1 ? 'All at the same time' : null;
  const base = index === 0 ? 'First' : index === count - 1 ? 'Finally' : 'Then';
  return size > 1 ? `${base} · at the same time` : base;
}

/**
 * "Starts after A and B", only when a step does not simply wait for the whole stage before it
 * (the stage heading already says that).
 */
export function startsAfterLine(
  step: Pick<WorkflowStepDetail, 'after'>,
  previousStage: ReadonlyArray<Pick<WorkflowStepDetail, 'key'>> | undefined,
  titleOf: (key: string) => string
): string | null {
  if (!step.after.length) return null;
  const previous = new Set(previousStage?.map((s) => s.key) ?? []);
  const wholeStage =
    step.after.length === previous.size && step.after.every((key) => previous.has(key));
  if (wholeStage) return null;
  return `Starts after ${joinWords(step.after.map((key) => quoted(titleOf(key))))}`;
}

function joinWords(words: string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

// ---------------------------------------------------------------------------
// What a step is doing, in one honest sentence
// ---------------------------------------------------------------------------

export interface StepExplanation {
  text: string;
  tone: Tone;
}

const time = (iso: string | null) => (iso ? Date.parse(iso) : Number.NaN);

/** How long a finished step took, or how long a started one has been going. */
export function stepDuration(step: Pick<WorkflowStepDetail, 'startedAt' | 'finishedAt'>) {
  const started = time(step.startedAt);
  if (!Number.isFinite(started)) return null;
  const finished = time(step.finishedAt);
  return formatDuration(started, Number.isFinite(finished) ? finished : null);
}

export function explainStep(
  step: WorkflowStepDetail,
  run: Pick<WorkflowRunDetail, 'steps' | 'maxParallelSteps'>,
  now = Date.now()
): StepExplanation {
  const byKey = new Map(run.steps.map((s) => [s.key, s]));
  const title = (key: string) => quoted(byKey.get(key)?.title ?? key);
  switch (step.status) {
    case 'waiting': {
      const pending = step.after.filter((key) => byKey.get(key)?.status !== 'completed');
      if (pending.length)
        return {
          text: `Starts after ${joinWords(pending.map(title))} ${pending.length === 1 ? 'finishes' : 'finish'}.`,
          tone: 'muted',
        };
      if (step.reason) return { text: `Ready, but held: ${step.reason}`, tone: 'info' };
      const cap = run.maxParallelSteps;
      return {
        text: `Ready. SAM starts it shortly${cap ? `; at most ${cap} ${cap === 1 ? 'step runs' : 'steps run'} at once` : ''}.`,
        tone: 'info',
      };
    }
    case 'starting': {
      if (step.kind === 'wait') return { text: 'Starting to listen.', tone: 'info' };
      const tries = step.launchAttempts > 1 ? ` (try ${step.launchAttempts})` : '';
      const problem = step.reason ? ` Last problem: ${step.reason}` : '';
      return { text: `Starting its agent${tries}.${problem}`, tone: 'info' };
    }
    case 'running': {
      if (step.kind === 'wait' && step.wait) {
        const timeout = Date.parse(step.wait.timeoutAt ?? '');
        const until = Number.isFinite(timeout)
          ? ` Gives up ${formatTimeFromNow(timeout, now)}.`
          : '';
        return { text: `Listening for ${step.wait.description}.${until}`, tone: 'info' };
      }
      return { text: 'The agent is working on it.', tone: 'success' };
    }
    case 'completed': {
      if (step.kind === 'wait' && step.wait?.matchedEvent) {
        const heard = step.wait.matchedEvent;
        return {
          text: `Heard ${heard.title ? quoted(heard.title) : heard.eventType} ${formatTimeFromNow(Date.parse(heard.occurredAt), now)}.`,
          tone: 'success',
        };
      }
      const took = stepDuration(step);
      return { text: took ? `Done in ${took}.` : 'Done.', tone: 'success' };
    }
    case 'failed': {
      if (step.kind === 'wait' && step.wait?.timedOut)
        return { text: `Timed out waiting for ${step.wait.description}.`, tone: 'danger' };
      return { text: step.reason ?? 'Failed without a reason.', tone: 'danger' };
    }
    case 'blocked': {
      const cause = step.after.find((key) => {
        const parent = byKey.get(key);
        return parent?.status === 'failed' || parent?.status === 'blocked';
      });
      return {
        text: cause
          ? `Did not start because ${title(cause)} did not succeed.`
          : (step.reason ?? 'Did not start because an earlier step did not succeed.'),
        tone: 'muted',
      };
    }
  }
}

/** The step a blocked step is waiting on, so the page can link to it. */
export function blockingStep(
  step: WorkflowStepDetail,
  steps: WorkflowStepDetail[]
): WorkflowStepDetail | null {
  if (step.status !== 'blocked') return null;
  const byKey = new Map(steps.map((s) => [s.key, s]));
  for (const key of step.after) {
    const parent = byKey.get(key);
    if (parent?.status === 'failed') return parent;
    if (parent?.status === 'blocked') return blockingStep(parent, steps) ?? parent;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Activity, in words
// ---------------------------------------------------------------------------

const STEP_EVENT_WORDS: Record<string, string> = {
  starting: 'started',
  running: 'is running',
  completed: 'finished',
  failed: 'failed',
  blocked: 'did not start',
};

/** "“Draft” finished", "The workflow needs attention". Unknown transitions stay generic. */
export function activityText(
  entry: { stepKey: string | null; state: string },
  titleOf: (key: string) => string,
  kindOf: (key: string) => WorkflowStepSummary['kind'] | undefined
): string {
  if (!entry.stepKey) {
    if (entry.state === 'completed') return 'The workflow finished';
    if (entry.state === 'needs_attention') return 'The workflow needs attention';
    return `The workflow changed: ${entry.state.replaceAll('_', ' ')}`;
  }
  const wait = kindOf(entry.stepKey) === 'wait';
  const verb =
    wait && entry.state === 'running'
      ? 'started listening'
      : wait && entry.state === 'completed'
        ? 'heard its event'
        : (STEP_EVENT_WORDS[entry.state] ?? entry.state.replaceAll('_', ' '));
  return `${quoted(titleOf(entry.stepKey))} ${verb}`;
}

export function activityTone(state: string): Tone {
  if (state === 'completed') return 'success';
  if (state === 'failed' || state === 'needs_attention') return 'danger';
  if (state === 'blocked') return 'muted';
  return 'info';
}
