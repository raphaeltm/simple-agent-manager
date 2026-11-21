/**
 * Which incident ideas are the pipeline's own bookkeeping, and which are tracked work.
 *
 * The hourly diagnosis runner (`platform-feedback-triage/runner.ts`) and the user-report path
 * (`user-report.ts`) each file one draft idea per incident signature and store it as
 * `platform_feedback_triages.idea_id`. That idea is a readable record of the signature, not a
 * sign that anyone is working on it. Counting it as tracked work made every incident exclude
 * itself from dispatch (idea 01M2CKJMNNE0FGASV18J0GFRAT).
 *
 * The condition is "nobody but the pipeline has touched this idea". It is read from two places:
 *
 * - D1: every write the pipeline makes to its idea records the `tasks.updated_at` it wrote in
 *   `platform_feedback_triages.idea_owned_at`. Any edit, status change or priority change by a
 *   person or agent (`idea-core.ts prepareIdeaUpdate`, `idea-transitions.ts`) moves
 *   `updated_at`, so the two no longer match and the idea counts as tracked work again.
 * - The ProjectData Durable Object: chat links, notes, file and PR links are stored there and do
 *   not move `updated_at`. `releaseEngagedIncidentIdeas` reads them directly
 *   (`getIdeaWorkSnapshots`) before the pipeline dispatches or cleans up, and releases any idea
 *   with engagement by setting `idea_owned_at` to `IDEA_RELEASED_MARKER`. Release is one-way:
 *   the pipeline never takes an idea back.
 */
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { resolveAdminSettingDetailsMany } from '../admin-settings-resolution';
import { getIdeaWorkSnapshots } from '../project-data';
import { placeholders } from './state';

/** `tasks.triggered_by` on ideas the incident pipeline files. */
export const PIPELINE_IDEA_TRIGGERED_BY = 'incident';

/**
 * `idea_owned_at` after a release. It never equals a `tasks.updated_at` timestamp, so the idea
 * is not owned, and it is not NULL, so legacy adoption (which only considers NULL rows that
 * predate ownership tracking) never takes it back.
 */
export const IDEA_RELEASED_MARKER = 'released';

/**
 * SQL: the idea `taskAlias` is owned by the triage row `triageRef`. Both arguments are SQL
 * identifiers chosen by the caller, never input.
 */
export function pipelineOwnsIdeaSql(triageRef: string, taskAlias: string): string {
  return `(${triageRef}.idea_owned_at IS NOT NULL
    AND ${taskAlias}.triggered_by = '${PIPELINE_IDEA_TRIGGERED_BY}'
    AND ${taskAlias}.updated_at = ${triageRef}.idea_owned_at)`;
}

export interface IdeaEngagementSnapshot {
  sessions: ReadonlyArray<{ strong: boolean }>;
  updates: number;
  fileIds: readonly string[];
  pullRequestUrls: readonly string[];
}

/** A strong chat link, a note, a file or a pull request means someone took the idea up. */
export function ideaHasEngagement(snapshot: IdeaEngagementSnapshot | undefined): boolean {
  if (!snapshot) return false;
  return (
    snapshot.sessions.some((session) => session.strong) ||
    snapshot.updates > 0 ||
    snapshot.fileIds.length > 0 ||
    snapshot.pullRequestUrls.length > 0
  );
}

export type IdeaWorkSnapshotReader = (
  env: Env,
  projectId: string,
  ideaIds: readonly string[]
) => Promise<Record<string, IdeaEngagementSnapshot>>;

/** Reads link and note state for `ideaIds` in one Durable Object call per batch. */
export const readIdeaEngagement: IdeaWorkSnapshotReader = async (env, projectId, ideaIds) => {
  if (ideaIds.length === 0) return {};
  const [targetLimit, perTargetCap] = await resolveAdminSettingDetailsMany(env, [
    'operations.resourceLinkBatchTargetLimit',
    'operations.resourceLinkBatchPerTargetCap',
  ]);
  return getIdeaWorkSnapshots(env, projectId, ideaIds, {
    maxTargets: Number(targetLimit?.value),
    perTargetCap: Number(perTargetCap?.value),
  });
};

export interface OwnedIdeaRef {
  signature: string;
  ideaId: string;
}

/**
 * Loads the triage rows among `signatures` whose idea the pipeline still owns in D1.
 */
export async function loadOwnedIdeas(env: Env, signatures: string[]): Promise<OwnedIdeaRef[]> {
  if (signatures.length === 0) return [];
  const rows = await env.DATABASE.prepare(
    `SELECT triage.signature, triage.idea_id
     FROM platform_feedback_triages triage
     JOIN tasks idea ON idea.id = triage.idea_id
     WHERE triage.signature IN (${placeholders(signatures)})
       AND ${pipelineOwnsIdeaSql('triage', 'idea')}`
  )
    .bind(...signatures)
    .all<{ signature: string; idea_id: string }>();
  return (rows.results ?? []).map((row) => ({ signature: row.signature, ideaId: row.idea_id }));
}

/**
 * Releases every owned idea in `owned` that a person or agent has engaged with in the Durable
 * Object, so it counts as tracked work from now on. Returns the released signatures.
 */
export async function releaseEngagedIncidentIdeas(
  env: Env,
  projectId: string,
  owned: OwnedIdeaRef[],
  readEngagement: IdeaWorkSnapshotReader = readIdeaEngagement
): Promise<string[]> {
  if (owned.length === 0) return [];
  const snapshots = await readEngagement(
    env,
    projectId,
    owned.map((ref) => ref.ideaId)
  );
  const engaged = owned.filter((ref) => ideaHasEngagement(snapshots[ref.ideaId]));
  if (engaged.length === 0) return [];
  const statements = engaged.map((ref) =>
    env.DATABASE.prepare(
      `UPDATE platform_feedback_triages SET idea_owned_at = ?, updated_at = CURRENT_TIMESTAMP
       WHERE signature = ? AND idea_id = ?`
    ).bind(IDEA_RELEASED_MARKER, ref.signature, ref.ideaId)
  );
  await env.DATABASE.batch(statements);
  log.info('platform_feedback_incident.idea_released', {
    projectId,
    released: engaged.length,
    ideaIds: engaged.map((ref) => ref.ideaId),
  });
  return engaged.map((ref) => ref.signature);
}
