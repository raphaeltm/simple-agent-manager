import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import { expectJsonRecord } from '../lib/runtime-validation';
import type { RecoveryContext } from './session-recovery-context';

/**
 * How far back through `tasks.recovery_source_task_id` a wake looks for the run that started the
 * conversation. Every sleep→wake cycle adds one link, so this bounds the lookup on a very
 * long-lived conversation. Past it the original intent is unknown, which means `preferred`.
 */
export const DEFAULT_SESSION_RECOVERY_LINEAGE_MAX_DEPTH = 256;

const RECOVERY_TRIGGER = 'session-recovery';

/**
 * Whether a woken (or eviction-recovered) conversation must return to its previous location, or
 * only prefer it.
 *
 *   required   the conversation's ROOT run explicitly asked for that location (an API/MCP
 *              `vmLocation`), so the wake keeps it as a hard constraint.
 *   preferred  every other case. The location ranks reusable hosts first, but offerings and
 *              hosts elsewhere stay eligible.
 *
 * Only the root counts. Before 2026-09-25 every wake recorded `explicitVmLocation: true` because
 * the wake itself pinned the old location, so reading the immediate predecessor would carry that
 * self-made pin down every existing chain. That pin dropped 8 of 12 permitted offerings from a
 * production wake's fallback chain and made a healthy host in another region "outside the
 * current pool allocation authority". Restore does not need the old region: snapshots live in
 * R2, keyed by session and generation (`session-snapshot-artifacts.ts`).
 */
export type RecoveryLocationIntent = 'required' | 'preferred';

type RecoveryLocationEnv = Pick<Env, 'DATABASE' | 'SESSION_RECOVERY_LINEAGE_MAX_DEPTH'>;

export async function resolveRecoveryLocationIntent(
  env: RecoveryLocationEnv,
  context: Pick<RecoveryContext, 'project' | 'sourceTask'>
): Promise<RecoveryLocationIntent> {
  const sourceTask = context.sourceTask;
  if (!sourceTask) return 'preferred';
  if (sourceTask.triggeredBy !== RECOVERY_TRIGGER) {
    return explicitLocationRequirement(sourceTask.placementExplanationJson);
  }

  const maxDepth = parsePositiveInt(
    env.SESSION_RECOVERY_LINEAGE_MAX_DEPTH,
    DEFAULT_SESSION_RECOVERY_LINEAGE_MAX_DEPTH
  );
  // One bounded round trip. Each step stays inside this project, and the depth bound also ends the
  // walk on a corrupt cycle. A failed read is not guessed around: it throws before the wake is
  // claimed, so `ensureSessionRecovery` defers it as `session_recovery_placement_transient`
  // without spending the wake budget.
  const root = await env.DATABASE.prepare(
    `WITH RECURSIVE lineage(id, recovery_source_task_id, triggered_by, placement_explanation_json, depth) AS (
         SELECT id, recovery_source_task_id, triggered_by, placement_explanation_json, 0
           FROM tasks
          WHERE id = ? AND project_id = ?
         UNION ALL
         SELECT parent.id, parent.recovery_source_task_id, parent.triggered_by,
                parent.placement_explanation_json, lineage.depth + 1
           FROM tasks parent
           JOIN lineage ON parent.id = lineage.recovery_source_task_id
          WHERE lineage.triggered_by = ?
            AND parent.project_id = ?
            AND lineage.depth < ?
       )
       SELECT placement_explanation_json AS placementExplanationJson
         FROM lineage
        WHERE triggered_by IS NOT ?
        ORDER BY depth
        LIMIT 1`
  )
    .bind(
      sourceTask.id,
      context.project.id,
      RECOVERY_TRIGGER,
      context.project.id,
      maxDepth,
      RECOVERY_TRIGGER
    )
    .first<{ placementExplanationJson: string | null }>();
  // No root within reach (a broken or over-long chain) means the original intent is unknown.
  return root ? explicitLocationRequirement(root.placementExplanationJson) : 'preferred';
}

/**
 * `required` only when a run's recorded placement says the caller explicitly asked for its
 * location. Missing, malformed or pre-2026-09-20 explanations (the field did not exist before
 * #2108) are not evidence of a request.
 */
function explicitLocationRequirement(
  placementExplanationJson: string | null
): RecoveryLocationIntent {
  if (!placementExplanationJson) return 'preferred';
  try {
    const explicitVmLocation = expectJsonRecord(
      JSON.parse(placementExplanationJson),
      'session_recovery.placement_explanation'
    ).explicitVmLocation;
    return explicitVmLocation === true ? 'required' : 'preferred';
  } catch {
    return 'preferred';
  }
}
