import type { Env } from '../../env';
import { log } from '../../lib/logger';
import {
  type IdeaWorkSnapshotReader,
  loadOwnedIdeas,
  releaseEngagedIncidentIdeas,
  updateOwnedIncidentIdea,
} from '../platform-feedback-incidents';
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
  /** Title to write instead of the stored summary (used before the summary is updated). */
  title?: string;
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
      title: (input.title ?? row.summary).slice(0, input.ideaTitleMaxLength),
      description: ideaDescription(input.group, input.diagnosisId, {
        occurrenceCount: row.occurrence_count,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
      }),
    },
    input.writtenAt
  );
}

/**
 * Before the hourly runner rewrites an incident's idea, checks the Durable Object for chat
 * links, notes, files or pull requests, which do not move `tasks.updated_at`. An engaged idea
 * is released and left alone. A failed read also leaves it alone this hour (fail closed: the
 * write is the irreversible side). One read per recurring signature, at most the group limit.
 */
export async function ownedIdeaStillUntouched(
  env: Env,
  projectId: string,
  signature: string,
  readEngagement?: IdeaWorkSnapshotReader
): Promise<boolean> {
  try {
    const owned = await loadOwnedIdeas(env, [signature]);
    if (owned.length === 0) return false;
    const released = await releaseEngagedIncidentIdeas(env, projectId, owned, readEngagement);
    return released.length === 0;
  } catch (error) {
    log.warn('platform-feedback-triage.idea-engagement-check-failed', {
      signature: signature.slice(0, 16),
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
