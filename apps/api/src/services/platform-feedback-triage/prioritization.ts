import type { Env } from '../../env';
import { parseStoredIncidentResolutionReferences } from '../platform-feedback-incident-resolution-references';
import {
  getIncidentConfig,
  shouldReopenIncidentForOccurrence,
} from '../platform-feedback-incidents';
import { severityRank } from './grouping';
import type { ExistingTriagePriorityRow, FeedbackErrorGroup } from './types';

export function prioritizeFeedbackGroups(
  groups: FeedbackErrorGroup[],
  existingRows: Map<string, ExistingTriagePriorityRow>,
  now: number
): FeedbackErrorGroup[] {
  return [...groups].sort((left, right) => {
    const leftExisting = existingRows.get(left.signature);
    const rightExisting = existingRows.get(right.signature);
    const leftEligible =
      !leftExisting?.budget_deferred_until || leftExisting.budget_deferred_until <= now ? 1 : 0;
    const rightEligible =
      !rightExisting?.budget_deferred_until || rightExisting.budget_deferred_until <= now ? 1 : 0;
    const eligibilityDelta = rightEligible - leftEligible;
    if (eligibilityDelta !== 0) return eligibilityDelta;

    const severityDelta = severityRank(right.severity) - severityRank(left.severity);
    if (severityDelta !== 0) return severityDelta;

    const leftNovel = leftExisting?.diagnosis_id || leftExisting?.idea_id ? 0 : 1;
    const rightNovel = rightExisting?.diagnosis_id || rightExisting?.idea_id ? 0 : 1;
    const noveltyDelta = rightNovel - leftNovel;
    if (noveltyDelta !== 0) return noveltyDelta;

    const leftOccurrences = leftExisting?.occurrence_count ?? left.count;
    const rightOccurrences = rightExisting?.occurrence_count ?? right.count;
    const repeatDelta = leftOccurrences - rightOccurrences;
    if (repeatDelta !== 0) return repeatDelta;

    return right.lastSeenAt - left.lastSeenAt;
  });
}

export function shouldReopenExistingTriage(
  env: Env,
  existing: ExistingTriagePriorityRow | undefined,
  group: FeedbackErrorGroup
): boolean {
  if (!existing) return true;
  if (!['resolved', 'expired'].includes(existing.queue_state ?? '')) return true;

  return shouldReopenIncidentForOccurrence({
    queueState: existing.queue_state,
    rejectedAt: existing.rejected_at,
    resolvedAt: existing.resolved_at,
    expiredAt: existing.expired_at,
    source: existing.source ?? group.source,
    resolutionNote: existing.resolution_note,
    resolvedTaskOutputPrUrl: existing.resolved_task_output_pr_url,
    resolutionReferences: parseStoredIncidentResolutionReferences(existing.resolution_references),
    occurrence: {
      timestamp: group.lastSeenAt,
      nodeAgentVersion: group.evidence.find((item) => item.timestamp === group.lastSeenAt)
        ?.nodeAgentVersion,
    },
    config: getIncidentConfig(env),
    requiredVmAgentVersion: env.VM_AGENT_REQUIRED_VERSION,
  });
}
