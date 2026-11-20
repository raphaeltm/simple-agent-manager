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
  /** How long counted error ids are remembered (two triage windows). */
  dedupeHorizonMs: number;
  ideaTitleMaxLength: number;
  readEngagement?: IdeaWorkSnapshotReader;
}

export interface WatchedRecurrenceResult {
  recorded: boolean;
  escalated: boolean;
  /** An idea refresh was attempted (Durable Object read and write); spends the run's budget. */
  ideaRefreshAttempted: boolean;
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
    occurrences: group.occurrences ?? [],
    severity: group.severity,
    evidenceRefs: JSON.stringify(group.evidence),
    now: ctx.now,
    config: ctx.watchConfig,
    dedupeHorizonMs: ctx.dedupeHorizonMs,
  });
  const recorded = outcome.recorded && outcome.newOccurrences > 0;
  if (!recorded || !existing.idea_id || !refreshIdea) {
    return {
      recorded,
      escalated: outcome.escalated,
      ideaRefreshAttempted: false,
      ideaUpdated: false,
    };
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
  return { recorded, escalated: outcome.escalated, ideaRefreshAttempted: true, ideaUpdated };
}

export interface WatchedRecorderContext extends WatchedRecurrenceContext {
  /** Idea refreshes per run (each one Durable Object read); counts are recorded regardless. */
  ideaRefreshLimit: number;
  trigger: FeedbackTriageTrigger;
  failureReasonMaxLength: number;
}

/**
 * Records watched recurrences for one runner pass into `result`. Every watched signature in
 * the window is recorded (2 D1 statements each, at most one per distinct signature in the
 * triage error-limit window: 100 rows by default, so at most ~200 statements and typically a
 * handful), because a recurrence not recorded now is not in the next window. Idea refreshes
 * (about 4 D1 statements and one Durable Object read each) are capped at `ideaRefreshLimit`;
 * a skipped refresh happens at the next recurrence and the counts are already stored.
 *
 * Each signature is isolated, so one failing write cannot stop the others, the ordinary triage
 * groups or the quiet expiry (rule 53). Signatures whose recording failed are kept in
 * `unrecorded` so the quiet expiry does not end a watch that just recurred.
 */
export function createWatchedRecorder(
  env: Env,
  result: FeedbackTriageResult,
  ctx: WatchedRecorderContext
) {
  let refreshesLeft = ctx.ideaRefreshLimit;
  const unrecorded: string[] = [];
  const record = async (group: FeedbackErrorGroup, existing: ExistingTriagePriorityRow) => {
    try {
      const outcome = await processWatchedRecurrence(env, group, existing, ctx, refreshesLeft > 0);
      if (outcome.recorded) result.watchedRecurrences += 1;
      if (outcome.escalated) result.watchedEscalated += 1;
      // Any attempt spends the budget: an engaged or refused idea still cost the reads.
      if (outcome.ideaRefreshAttempted) refreshesLeft -= 1;
      if (outcome.ideaUpdated) {
        result.ideasUpdated += 1;
      } else {
        result.groupsSkipped += 1;
      }
    } catch (cause) {
      unrecorded.push(group.signature);
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
  const recordAll = async (
    groups: readonly FeedbackErrorGroup[],
    rows: ReadonlyMap<string, ExistingTriagePriorityRow>
  ) => {
    for (const group of groups) {
      const existing = rows.get(group.signature);
      if (existing) await record(group, existing);
    }
  };
  return { record, recordAll, unrecorded };
}
