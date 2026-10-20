/**
 * One view model for the three stored kinds of automation, so every screen reads the same
 * words: a trigger (recurring, GitHub, webhook or incident), a one-time schedule, and a
 * standing watch. Pure functions only; the hooks in `data.ts` feed them.
 *
 * Every automation is "when X → do Y". `when` and `action` are those two halves in plain words;
 * the raw configuration stays on the source record for the Advanced sections.
 */
import {
  DEFAULT_PROJECT_EVENT_WATCH_MAX_EXECUTIONS,
  DEFAULT_TRIGGER_AUTO_PAUSE_AFTER_FAILURES,
  type ProjectSchedule,
  type ProjectScheduledAction,
  type ProjectStandingWatch,
  type TriggerExecutionResponse,
  type TriggerResponse,
} from '@simple-agent-manager/shared';

import { describeCron } from '../../components/triggers/schedule-cron';
import type { AutomationKind } from '../../lib/automation-routes';
import {
  describeEventFilter,
  githubTriggerWhen,
  INCIDENT_TRIGGER_WHEN,
  webhookTriggerWhen,
} from './describe';
import { dateTimeLabel, viewerZone } from './time';

/** What starts an automation, which is also how the overview groups it. */
export type StartKind = 'schedule' | 'once' | 'github' | 'webhook' | 'event' | 'incident';

/**
 * - `on` / `paused` / `off`: recurring and reacting automations.
 * - `scheduled`, `late`, `starting`: a one-time automation that has not run yet.
 * - `done`, `cancelled`, `ended`: nothing more will happen.
 */
export type AutomationState =
  'on' | 'paused' | 'off' | 'scheduled' | 'late' | 'starting' | 'done' | 'cancelled' | 'ended';

export type AttentionFix = 'resume' | 'review-runs' | 'raise-limit' | 'check-receipt' | 'review';

export interface Attention {
  tone: 'danger' | 'warning';
  title: string;
  body: string;
  fix: AttentionFix;
  /** When the problem was last observed; newest first in "Needs your attention". */
  at: number;
}

export type AutomationAction =
  | { kind: 'start'; prompt: string; agentProfileId: string | null; skillId: string | null }
  | { kind: 'message'; prompt: string; sessionId: string };

type Source =
  | { kind: 'trigger'; trigger: TriggerResponse }
  | { kind: 'schedule'; schedule: ProjectSchedule }
  | { kind: 'watch'; watch: ProjectStandingWatch };

export type AutomationItem = Source & {
  id: string;
  start: StartKind;
  name: string;
  /** "Weekdays at 9:00 AM", "When an issue is opened", "Tue, Oct 21, 9:00 AM GMT+2". */
  when: string;
  /** A qualifier for `when`, e.g. "Europe/Paris time" when it is not the viewer's zone. */
  whenNote?: string;
  action: AutomationAction;
  state: AutomationState;
  /** One plain sentence about the state, when it needs one. */
  stateNote?: string;
  nextAt: number | null;
  lastRunAt: number | null;
  createdAt: number;
  createdBy: string;
  attention: Attention | null;
};

export const isFinished = (item: AutomationItem) =>
  item.state === 'done' || item.state === 'cancelled' || item.state === 'ended';
export const isStopped = (item: AutomationItem) => item.state === 'paused' || item.state === 'off';
export const isReaction = (item: AutomationItem) =>
  item.start === 'github' ||
  item.start === 'webhook' ||
  item.start === 'event' ||
  item.start === 'incident';

const ms = (iso: string | null | undefined) => {
  const value = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(value) ? value : null;
};

function toAction(action: ProjectScheduledAction): AutomationAction {
  return action.kind === 'message_session'
    ? { kind: 'message', prompt: action.prompt, sessionId: action.sessionId }
    : {
        kind: 'start',
        prompt: action.prompt,
        agentProfileId: action.agentProfileId,
        skillId: action.skillId,
      };
}

/** The first line of a prompt, for automations that have no name of their own. */
export function titleFromPrompt(prompt: string, fallback: string): string {
  const line = prompt
    .split('\n')
    .map((part) => part.trim())
    .find(Boolean);
  if (!line) return fallback;
  if (line.length > 80) return `${line.slice(0, 79).trimEnd()}…`;
  // A sentence makes a fine name, but names do not end with a full stop.
  return line.replace(/\.$/, '');
}

const zoneNote = (zone: string) => (zone && zone !== viewerZone() ? `${zone} time` : undefined);

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

/**
 * Finished runs only, newest first: a queued or skipped run says nothing about whether the
 * automation works.
 */
const finishedRuns = (runs: TriggerExecutionResponse[]) =>
  runs.filter((run) => run.status === 'completed' || run.status === 'failed');

/** How many of the newest finished runs failed in a row. */
export function failureStreak(runs: TriggerExecutionResponse[]): number {
  let streak = 0;
  for (const run of finishedRuns(runs)) {
    if (run.status !== 'failed') break;
    streak++;
  }
  return streak;
}

/**
 * Triggers have no "paused automatically" flag, so this never claims who paused one. It states
 * the facts: the trigger is paused, and its last N finished runs failed.
 */
export function triggerAttention(
  trigger: TriggerResponse,
  runs: TriggerExecutionResponse[] | undefined,
  threshold = DEFAULT_TRIGGER_AUTO_PAUSE_AFTER_FAILURES
): Attention | null {
  if (!runs || trigger.status === 'disabled') return null;
  const streak = failureStreak(runs);
  if (streak < threshold) return null;
  const latest = finishedRuns(runs)[0];
  const at = ms(latest?.completedAt ?? latest?.scheduledAt) ?? Date.now();
  const reason = latest?.errorMessage ? `The last error was: ${latest.errorMessage}` : '';
  if (trigger.status === 'paused') {
    return {
      tone: 'danger',
      title: `Paused · its last ${streak} runs failed`,
      body: `${reason ? `${reason} ` : ''}Fix the cause, then resume it. Resuming starts the count again.`,
      fix: 'resume',
      at,
    };
  }
  return {
    tone: 'warning',
    title: `Its last ${streak} runs failed`,
    body: reason || 'Check the recent runs to see what went wrong.',
    fix: 'review-runs',
    at,
  };
}

export function triggerWhen(trigger: TriggerResponse): { when: string; whenNote?: string } {
  switch (trigger.sourceType) {
    case 'github':
      return {
        when: trigger.githubConfig
          ? githubTriggerWhen(trigger.githubConfig.eventType, trigger.githubConfig.filters)
          : 'When something happens on GitHub',
      };
    case 'webhook':
      return { when: webhookTriggerWhen(trigger.webhookConfig?.sourceLabel) };
    case 'incident':
      return { when: INCIDENT_TRIGGER_WHEN };
    default: {
      const cron = trigger.cronExpression ?? '';
      const described = cron ? describeCron(cron) : '';
      // describeCron echoes expressions it cannot read; the API's own wording covers those.
      const readable =
        described && described !== cron && described !== 'Invalid expression'
          ? described
          : (trigger.cronHumanReadable ?? (cron || 'No schedule'));
      return { when: readable, whenNote: zoneNote(trigger.cronTimezone) };
    }
  }
}

export function fromTrigger(
  trigger: TriggerResponse,
  runs?: TriggerExecutionResponse[]
): AutomationItem {
  const start: StartKind =
    trigger.sourceType === 'cron'
      ? 'schedule'
      : trigger.sourceType === 'incident'
        ? 'incident'
        : trigger.sourceType;
  const state: AutomationState =
    trigger.status === 'active' ? 'on' : trigger.status === 'paused' ? 'paused' : 'off';
  return {
    kind: 'trigger',
    trigger,
    id: trigger.id,
    start,
    name: trigger.name,
    ...triggerWhen(trigger),
    action: {
      kind: 'start',
      prompt: trigger.promptTemplate,
      agentProfileId: trigger.agentProfileId,
      skillId: trigger.skillId,
    },
    state,
    // The state pill already says "Paused" or "Off"; the note says what that means.
    stateNote:
      state === 'paused'
        ? 'Nothing starts until it is resumed'
        : state === 'off'
          ? 'Nothing starts until it is turned on'
          : undefined,
    nextAt: state === 'on' && trigger.sourceType === 'cron' ? ms(trigger.nextFireAt) : null,
    lastRunAt: ms(trigger.lastTriggeredAt),
    createdAt: ms(trigger.createdAt) ?? 0,
    createdBy: trigger.userId,
    attention: triggerAttention(trigger, runs),
  };
}

// ---------------------------------------------------------------------------
// One-time schedules
// ---------------------------------------------------------------------------

export function scheduleAttention(
  schedule: ProjectSchedule,
  now: number,
  windowMs: number
): Attention | null {
  if (now - schedule.updatedAt > windowMs) return null;
  if (schedule.state === 'ambiguous') {
    return {
      tone: 'warning',
      title: 'Could not confirm it ran',
      body: 'It may have started. Check the result before scheduling it again.',
      fix: 'check-receipt',
      at: schedule.updatedAt,
    };
  }
  if (schedule.state === 'failed') {
    return {
      tone: 'danger',
      title: 'Did not run',
      body: schedule.lastError ?? 'SAM could not start it before it gave up.',
      fix: schedule.execution?.retrySubmissionAllowed ? 'check-receipt' : 'review',
      at: schedule.updatedAt,
    };
  }
  if (schedule.state === 'expired') {
    return {
      tone: 'warning',
      title: 'Expired before it could run',
      body: schedule.lastError ?? 'It waited past its give-up time without starting.',
      fix: 'review',
      at: schedule.updatedAt,
    };
  }
  return null;
}

function scheduleState(schedule: ProjectSchedule, now: number): AutomationState {
  switch (schedule.state) {
    case 'pending':
      return schedule.dueAt > now ? 'scheduled' : 'late';
    case 'processing':
      return 'starting';
    case 'admitted':
    case 'failed':
    case 'ambiguous':
      return 'done';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'ended';
  }
}

const SCHEDULE_NOTES: Partial<Record<ProjectSchedule['state'], string>> = {
  admitted: 'Ran',
  failed: 'Did not run',
  ambiguous: 'Ran, but could not be confirmed',
  expired: 'Expired before it could run',
};

export function fromSchedule(
  schedule: ProjectSchedule,
  now: number,
  attentionWindowMs: number
): AutomationItem {
  const state = scheduleState(schedule, now);
  const action = toAction(schedule.action);
  return {
    kind: 'schedule',
    schedule,
    id: schedule.id,
    start: 'once',
    name:
      schedule.reason?.trim() ||
      titleFromPrompt(action.prompt, action.kind === 'message' ? 'Message a chat' : 'Start a chat'),
    // In the viewer's own time, like everything else in lists; the stored zone is in Advanced.
    when: dateTimeLabel(schedule.dueAt),
    action,
    state,
    stateNote:
      state === 'late'
        ? `It keeps trying until ${dateTimeLabel(schedule.expiresAt)}`
        : state === 'starting'
          ? 'Starting now'
          : schedule.state === 'cancelled' && schedule.lastError
            ? `Reason: ${schedule.lastError}`
            : SCHEDULE_NOTES[schedule.state],
    nextAt:
      state === 'scheduled' || state === 'late' ? (schedule.nextAttemptAt ?? schedule.dueAt) : null,
    lastRunAt: state === 'done' ? schedule.updatedAt : null,
    createdAt: schedule.createdAt,
    createdBy: schedule.creatorUserId,
    attention: scheduleAttention(schedule, now, attentionWindowMs),
  };
}

// ---------------------------------------------------------------------------
// Standing watches
// ---------------------------------------------------------------------------

/**
 * Why the watch runner pauses a watch on its own. Must match the reasons in
 * `apps/api/src/durable-objects/project-data/project-standing-watches-runner.ts`
 * (`STANDING_WATCH_TARGET_NOT_OWNED` and the revoked-access pause). A person's own pause reason
 * is stored in the same field, so only these two read as problems.
 */
export const WATCH_TARGET_NOT_OWNED = 'Standing watch creator does not own the target chat';
export const WATCH_CREATOR_ACCESS_REVOKED = 'Creator project access was revoked';

const RUNNER_PAUSES: Record<string, string> = {
  [WATCH_TARGET_NOT_OWNED]:
    'The person who created it no longer owns the chat it messages. Only they can point it at another chat; anyone who can edit automation can stop it.',
  [WATCH_CREATOR_ACCESS_REVOKED]:
    'The person who created it no longer has access to this project, so it cannot run. Create a new watch to keep it going, or stop this one.',
};

/** Which of SAM's own pauses holds this watch, if any (a person's pause reason is not one). */
export function watchRunnerPause(
  watch: ProjectStandingWatch
): 'target-not-owned' | 'creator-access-revoked' | null {
  if (watch.state !== 'paused') return null;
  if (watch.lastError === WATCH_TARGET_NOT_OWNED) return 'target-not-owned';
  if (watch.lastError === WATCH_CREATOR_ACCESS_REVOKED) return 'creator-access-revoked';
  return null;
}

export function watchAttention(watch: ProjectStandingWatch): Attention | null {
  if (watch.state === 'revoked') return null;
  // Resuming a watch SAM paused would only pause it again, so the fix is to look at it.
  const runnerPause =
    watch.state === 'paused' && watch.lastError ? RUNNER_PAUSES[watch.lastError] : undefined;
  if (runnerPause) {
    return {
      tone: 'danger',
      title: 'Paused by SAM',
      body: runnerPause,
      fix: 'review',
      at: watch.updatedAt,
    };
  }
  if (watch.executionCount >= watch.maxExecutions) {
    const atCap = watch.maxExecutions >= DEFAULT_PROJECT_EVENT_WATCH_MAX_EXECUTIONS;
    return {
      tone: 'warning',
      title: `Used all ${watch.maxExecutions} of its runs`,
      body: atCap
        ? 'That is the most runs a watch can have. Create a new watch to keep going, or stop this one.'
        : 'It ignores new events until you give it more runs.',
      fix: atCap ? 'review' : 'raise-limit',
      at: watch.updatedAt,
    };
  }
  return null;
}

function watchStateNote(watch: ProjectStandingWatch): string {
  if (watch.state === 'revoked')
    return watch.lastError ? `Stopped for good: ${watch.lastError}` : 'Stopped for good';
  if (watch.state === 'paused') {
    if (watch.lastError && !RUNNER_PAUSES[watch.lastError]) return `Paused: ${watch.lastError}`;
    return 'Events are ignored until it is resumed';
  }
  return `${watch.executionCount} of ${watch.maxExecutions} runs used`;
}

export function fromWatch(watch: ProjectStandingWatch, lastRunAt: number | null): AutomationItem {
  const action = toAction(watch.action);
  const state: AutomationState =
    watch.state === 'active' ? 'on' : watch.state === 'paused' ? 'paused' : 'ended';
  const when = `When ${describeEventFilter(watch.filter).clause}`;
  return {
    kind: 'watch',
    watch,
    id: watch.id,
    start: 'event',
    name: watch.reason?.trim() || when,
    when,
    action,
    state,
    stateNote: watchStateNote(watch),
    nextAt: null,
    lastRunAt,
    createdAt: watch.createdAt,
    createdBy: watch.creatorUserId,
    attention: watchAttention(watch),
  };
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

export interface AutomationSources {
  triggers: TriggerResponse[];
  /** Recent runs per trigger id, when loaded. */
  runsByTrigger: Map<string, TriggerExecutionResponse[]>;
  schedules: ProjectSchedule[];
  watches: ProjectStandingWatch[];
}

/**
 * Every automation. Schedules a watch created are that watch's runs, not automations of their
 * own, so they are folded into the watch's "last ran" instead of being listed.
 */
export function buildAutomationItems(
  sources: AutomationSources,
  now: number,
  attentionWindowMs: number
): AutomationItem[] {
  const lastWatchRun = new Map<string, number>();
  for (const schedule of sources.schedules) {
    if (!schedule.watchId) continue;
    const previous = lastWatchRun.get(schedule.watchId) ?? 0;
    lastWatchRun.set(schedule.watchId, Math.max(previous, schedule.createdAt));
  }
  return [
    ...sources.triggers.map((trigger) =>
      fromTrigger(trigger, sources.runsByTrigger.get(trigger.id))
    ),
    ...sources.schedules
      .filter((schedule) => !schedule.watchId)
      .map((schedule) => fromSchedule(schedule, now, attentionWindowMs)),
    ...sources.watches.map((watch) => fromWatch(watch, lastWatchRun.get(watch.id) ?? null)),
  ];
}

export function attentionItems(items: AutomationItem[]) {
  return items
    .filter((item): item is AutomationItem & { attention: Attention } => item.attention !== null)
    .sort((a, b) => {
      if (a.attention.tone !== b.attention.tone) return a.attention.tone === 'danger' ? -1 : 1;
      return b.attention.at - a.attention.at;
    });
}

/** The next things that start on their own, soonest first. */
export function comingUp(items: AutomationItem[], limit: number) {
  return items
    .filter((item): item is AutomationItem & { nextAt: number } => item.nextAt !== null)
    .sort((a, b) => a.nextAt - b.nextAt)
    .slice(0, limit);
}

export function itemRef(item: AutomationItem): { kind: AutomationKind; id: string } {
  return { kind: item.kind, id: item.id };
}
