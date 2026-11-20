import type { Env } from '../../env';
import { updateOwnedIncidentIdea } from '../platform-feedback-incidents';
import { ideaDescription } from './grouping';
import type { FeedbackErrorGroup } from './types';

export interface RefreshOwnedIdeaInput {
  group: FeedbackErrorGroup;
  signature: string;
  ideaId: string;
  projectId: string;
  diagnosisId: string;
  ideaTitleMaxLength: number;
  writtenAt: string;
}

/**
 * Rewrites an incident's own idea from the latest grouping window and the stored totals. The
 * title is the stored summary, so a legacy idea keeps a readable title once its row has one.
 */
export async function refreshOwnedIdea(env: Env, input: RefreshOwnedIdeaInput): Promise<boolean> {
  const row = await env.DATABASE.prepare(
    `SELECT summary, occurrence_count, first_seen_at, last_seen_at
     FROM platform_feedback_triages WHERE signature = ?`
  )
    .bind(input.signature)
    .first<{
      summary: string;
      occurrence_count: number;
      first_seen_at: number;
      last_seen_at: number;
    }>();
  if (!row) return false;
  return updateOwnedIncidentIdea(
    env,
    { signature: input.signature, ideaId: input.ideaId, projectId: input.projectId },
    {
      title: row.summary.slice(0, input.ideaTitleMaxLength),
      description: ideaDescription(input.group, input.diagnosisId, {
        occurrenceCount: row.occurrence_count,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
      }),
    },
    input.writtenAt
  );
}
