/**
 * What automations did, newest first: trigger runs and finished one-time actions (including the
 * actions standing watches started), merged into one timeline for "Recently" and History.
 */
import type {
  ProjectSchedule,
  TriggerExecutionResponse,
  TriggerResponse,
} from '@simple-agent-manager/shared';

import type { AutomationKind } from '../../lib/automation-routes';
import { executionOutcome, executionText, type Outcome } from './describe';

export interface ActivityEntry {
  id: string;
  at: number;
  outcome: Outcome;
  text: string;
  /** The automation this belongs to (a watch, for the actions it started). */
  owner: { kind: AutomationKind; id: string };
  /** Where the work happened, when SAM knows. */
  chat: { taskId?: string; sessionId?: string } | null;
}

const ms = (iso: string | null | undefined) => {
  const value = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(value) ? value : null;
};

export function runEntry(trigger: TriggerResponse, run: TriggerExecutionResponse): ActivityEntry {
  return {
    id: `run:${run.id}`,
    at: ms(run.completedAt) ?? ms(run.startedAt) ?? ms(run.scheduledAt) ?? 0,
    outcome: executionOutcome(run),
    text: executionText(run),
    owner: { kind: 'trigger', id: trigger.id },
    chat: executionChat(run),
  };
}

/** Only link the current target; a rejected target is retained solely for audit. */
export function executionChat(run: TriggerExecutionResponse): ActivityEntry['chat'] {
  if (run.status === 'waiting' || run.skipReason === 'target_unavailable') return null;
  const taskId = run.routedTaskId ?? run.taskId;
  return run.routedSessionId ? { sessionId: run.routedSessionId } : taskId ? { taskId } : null;
}

const SCHEDULE_OUTCOMES: Partial<Record<ProjectSchedule['state'], Outcome>> = {
  admitted: 'ok',
  failed: 'failed',
  ambiguous: 'unknown',
  expired: 'skipped',
};

/** A finished one-time action, or null while it is still waiting or was cancelled. */
export function scheduleEntry(schedule: ProjectSchedule): ActivityEntry | null {
  const outcome = SCHEDULE_OUTCOMES[schedule.state];
  if (!outcome) return null;
  const message = schedule.action.kind === 'message_session';
  const text =
    schedule.state === 'admitted'
      ? message
        ? 'Sent its message to the chat'
        : 'Started a chat'
      : schedule.state === 'failed'
        ? `Did not run${schedule.lastError ? `: ${schedule.lastError}` : ''}`
        : schedule.state === 'ambiguous'
          ? 'May have run, but SAM could not confirm it'
          : 'Expired before it could run';
  const sessionId =
    schedule.resultSessionId ??
    schedule.execution?.sessionId ??
    (schedule.action.kind === 'message_session' ? schedule.action.sessionId : null);
  return {
    id: `schedule:${schedule.id}`,
    at: schedule.updatedAt,
    outcome,
    text,
    owner: schedule.watchId
      ? { kind: 'watch', id: schedule.watchId }
      : { kind: 'schedule', id: schedule.id },
    chat: sessionId ? { sessionId } : null,
  };
}

export function buildActivity(
  triggers: TriggerResponse[],
  runsByTrigger: Map<string, TriggerExecutionResponse[]>,
  schedules: ProjectSchedule[]
): ActivityEntry[] {
  const entries: ActivityEntry[] = [];
  for (const trigger of triggers)
    for (const run of runsByTrigger.get(trigger.id) ?? []) entries.push(runEntry(trigger, run));
  for (const schedule of schedules) {
    const entry = scheduleEntry(schedule);
    if (entry) entries.push(entry);
  }
  return entries.sort((a, b) => b.at - a.at);
}

export const isProblem = (entry: ActivityEntry) =>
  entry.outcome === 'failed' || entry.outcome === 'unknown';
