/**
 * The hourly runner's handling of a watched incident's recurrence (`runner.ts`): record the
 * exact new occurrences (`recordWatchedRecurrence`), then refresh the signature's single idea
 * with the counts. Never reopens, diagnoses, claims or dispatches.
 */
import type { Env } from '../../env';
import {
  type IdeaWorkSnapshotReader,
  recordWatchedRecurrence,
  type WatchConfig,
} from '../platform-feedback-incidents';
import { ownedIdeaStillUntouched, refreshOwnedIdea } from './idea-refresh';
import type { ExistingTriagePriorityRow, FeedbackErrorGroup } from './types';

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
  ctx: WatchedRecurrenceContext
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
  if (!recorded || !existing.idea_id) {
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
