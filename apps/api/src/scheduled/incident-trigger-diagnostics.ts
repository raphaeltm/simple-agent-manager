/**
 * Decline logging and pre-dispatch ownership checks for the incident sweep
 * (`incident-triggers.ts`). Kept apart so the sweep reads as admission policy.
 */
import type { Env } from '../env';
import { log } from '../lib/logger';
import { resolveFleetOpsSettings } from '../services/fleet-ops/settings';
import {
  explainUndispatchableIncidents,
  type IdeaWorkSnapshotReader,
  type IncidentBacklogSummary,
  type IncidentConfig,
  loadOwnedIdeas,
  releaseEngagedIncidentIdeas,
} from '../services/platform-feedback-incidents';

const HOUR_MS = 60 * 60 * 1000;

export type IncidentSweepDeclineCause =
  | 'no_dispatchable_incidents'
  | 'no_active_trigger'
  /** Dispatchable incidents existed, but admission, rate limit or a check held them back. */
  | 'not_admitted';

/** Holds that are deliberate: they do not warn even when old (the anomaly still lists them). */
const EXPECTED_HOLDS = new Set([
  'rejected',
  'dispatch_attempts_exhausted',
  'budget_deferred',
  'stale_singleton',
  'below_min_severity',
  'tracked_work',
]);

/**
 * Logs why the sweep is not dispatching (rule 70 requirement 3): one aggregate read over the
 * pending queue, naming the filter that holds each incident back. Warns when an incident that is
 * NOT under a deliberate hold has waited past the stall window without a single dispatch
 * (no active trigger, or admission, rate limit or a failed check kept holding it). Every stalled
 * incident, whatever holds it, is listed by the `incident_dispatch_stalled` anomaly. Logging
 * never aborts the sweep. Returns the stalled count.
 */
export async function logIncidentDispatchDecline(
  env: Env,
  input: {
    projectId: string;
    config: IncidentConfig;
    now: number;
    cause: IncidentSweepDeclineCause;
    triggerIds: string[];
  }
): Promise<number> {
  try {
    const settings = await resolveFleetOpsSettings(env);
    const stallWindowMs = settings.incidentDispatchStallHours * HOUR_MS;
    const breakdown = await explainUndispatchableIncidents(
      env,
      input.config,
      input.now,
      stallWindowMs
    );
    if (breakdown.pending === 0) return 0;
    const unexpectedStalls = Object.entries(breakdown.stalledByReason)
      .filter(([reason]) => !EXPECTED_HOLDS.has(reason))
      .reduce((sum, [, count]) => sum + count, 0);
    const fields = {
      projectId: input.projectId,
      cause: input.cause,
      triggerIds: input.triggerIds,
      pendingIncidents: breakdown.pending,
      stalledIncidents: breakdown.stalled,
      stalledByReason: breakdown.stalledByReason,
      stallWindowHours: settings.incidentDispatchStallHours,
      reasons: breakdown.reasons,
    };
    log.info('incident_trigger_sweep.declined', fields);
    if (unexpectedStalls > 0) log.warn('incident_trigger_sweep.dispatch_stalled', fields);
    return breakdown.stalled;
  } catch (error) {
    log.error('incident_trigger_sweep.decline_explain_failed', {
      projectId: input.projectId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

const MAX_RELEASE_PASSES = 3;

/**
 * Releases engaged ideas among the incidents about to be dispatched and rebuilds the batch,
 * until a pass releases nothing (bounded), so incidents pulled in by a rebuild are checked too.
 * Returns `summary: null` when the Durable Object read failed; the caller must not dispatch.
 */
export async function releaseEngagedIdeasUntilStable(
  env: Env,
  input: {
    projectId: string;
    summary: IncidentBacklogSummary;
    rebuild: () => Promise<IncidentBacklogSummary>;
    readEngagement?: IdeaWorkSnapshotReader;
  }
): Promise<{ summary: IncidentBacklogSummary | null; released: number }> {
  let summary = input.summary;
  let released = 0;
  try {
    for (let pass = 0; pass < MAX_RELEASE_PASSES && summary.pendingCount > 0; pass += 1) {
      const owned = await loadOwnedIdeas(
        env,
        summary.incidents.map((incident) => incident.id)
      );
      const signatures = await releaseEngagedIncidentIdeas(
        env,
        input.projectId,
        owned,
        input.readEngagement
      );
      if (signatures.length === 0) return { summary, released };
      released += signatures.length;
      summary = await input.rebuild();
    }
    // Still releasing after the last pass: dispatch nothing this tick; the next tick continues.
    return summary.pendingCount === 0 ? { summary, released } : { summary: null, released };
  } catch (error) {
    log.error('incident_trigger_sweep.engagement_check_failed', {
      projectId: input.projectId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { summary: null, released };
  }
}
