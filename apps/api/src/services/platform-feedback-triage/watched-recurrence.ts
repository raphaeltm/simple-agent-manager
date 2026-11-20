/**
 * The hourly runner's handling of a watched incident's recurrence (`runner.ts`): record the
 * exact new occurrences (`recordWatchedRecurrence`), then refresh the signature's single idea
 * with the counts. Never reopens, diagnoses, claims or dispatches.
 */
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import {
  type IdeaWorkSnapshotReader,
  recordWatchedRecurrence,
  type WatchConfig,
} from '../platform-feedback-incidents';
import { sanitizeFailureReason } from './grouping';
import { ownedIdeaStillUntouched, refreshOwnedIdea } from './idea-refresh';
import type {
  ExistingTriagePriorityRow,
  FeedbackErrorGroup,
  FeedbackTriageResult,
  FeedbackTriageTrigger,
} from './types';

export interface WatchedRecurrenceContext {
  projectId: string;
  now: number;
  watchConfig: WatchConfig;
  ideaTitleMaxLength: number;
  readEngagement?: IdeaWorkSnapshotReader;
}

export interface WatchedRecurrenceResult {
  recorded: boolean;
  escalated: boolean;
  ideaUpdated: boolean;
}

export async function processWatchedRecurrence(
  env: Env,
  group: FeedbackErrorGroup,
  existing: ExistingTriagePriorityRow,
  ctx: WatchedRecurrenceContext,
  refreshIdea = true
): Promise<WatchedRecurrenceResult> {
  const outcome = await recordWatchedRecurrence(env, {
    signature: group.signature,
    occurrenceTimestamps: group.occurrenceTimestamps ?? [],
    severity: group.severity,
    evidenceRefs: JSON.stringify(group.evidence),
    now: ctx.now,
    config: ctx.watchConfig,
  });
  const recorded = outcome.recorded && outcome.newOccurrences > 0;
  if (!recorded || !existing.idea_id || !refreshIdea) {
    return { recorded, escalated: outcome.escalated, ideaUpdated: false };
  }
  const untouched = await ownedIdeaStillUntouched(
    env,
    ctx.projectId,
    group.signature,
    ctx.readEngagement
  );
  const ideaUpdated =
    untouched &&
    (await refreshOwnedIdea(env, {
      group,
      signature: group.signature,
      ideaId: existing.idea_id,
      projectId: ctx.projectId,
      diagnosisId: existing.diagnosis_id ?? 'pending',
      ideaTitleMaxLength: ctx.ideaTitleMaxLength,
      writtenAt: new Date(ctx.now).toISOString(),
      readContext: { now: ctx.now, recentWindowMs: ctx.watchConfig.recentWindowMs },
    }));
  return { recorded, escalated: outcome.escalated, ideaUpdated };
}

export interface WatchedRecorderContext extends WatchedRecurrenceContext {
  /** Idea refreshes per run (each one Durable Object read); counts are recorded regardless. */
  ideaRefreshLimit: number;
  trigger: FeedbackTriageTrigger;
  failureReasonMaxLength: number;
}

/**
 * Records watched recurrences for one runner pass into `result`. Per run: at most
 * `watchConfig.maxRecordsPerRun` signatures (2 D1 statements each) and `ideaRefreshLimit`
 * idea refreshes (about 4 D1 statements and 1 Durable Object read each). At the defaults
 * (25 and 5) that is at most ~70 D1 statements and 5 Durable Object reads an hour. Every
 * signature is isolated, so one failing write cannot stop the others, the ordinary triage
 * groups or the quiet expiry (rule 53).
 */
export function createWatchedRecorder(
  env: Env,
  result: FeedbackTriageResult,
  ctx: WatchedRecorderContext
) {
  let recordsLeft = ctx.watchConfig.maxRecordsPerRun;
  let refreshesLeft = ctx.ideaRefreshLimit;
  const record = async (group: FeedbackErrorGroup, existing: ExistingTriagePriorityRow) => {
    if (recordsLeft <= 0) {
      result.groupsSkipped += 1;
      return;
    }
    recordsLeft -= 1;
    try {
      const outcome = await processWatchedRecurrence(env, group, existing, ctx, refreshesLeft > 0);
      if (outcome.recorded) result.watchedRecurrences += 1;
      if (outcome.escalated) result.watchedEscalated += 1;
      if (outcome.ideaUpdated) {
        refreshesLeft -= 1;
        result.ideasUpdated += 1;
      } else {
        result.groupsSkipped += 1;
      }
    } catch (cause) {
      const reason = sanitizeFailureReason(cause, ctx.failureReasonMaxLength);
      result.groupsFailed += 1;
      result.failureReasons.push(reason);
      log.warn('platform-feedback-triage.watched-recurrence-failed', {
        trigger: ctx.trigger,
        signature: group.signature.slice(0, 16),
        reason,
        action: 'skipped_this_window',
      });
    }
  };
  /** Oldest occurrence in the window first: it is the one the next window will not see. */
  const recordAll = async (
    groups: readonly FeedbackErrorGroup[],
    rows: ReadonlyMap<string, ExistingTriagePriorityRow>
  ) => {
    const ordered = [...groups].sort(
      (left, right) =>
        left.firstSeenAt - right.firstSeenAt || left.signature.localeCompare(right.signature)
    );
    for (const group of ordered) {
      const existing = rows.get(group.signature);
      if (existing) await record(group, existing);
    }
  };
  return { record, recordAll };
}
