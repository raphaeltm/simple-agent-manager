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
  type IncidentConfig,
  type IncidentListItem,
  loadOwnedIdeas,
  releaseEngagedIncidentIdeas,
} from '../services/platform-feedback-incidents';

const HOUR_MS = 60 * 60 * 1000;

export type IncidentSweepDeclineCause = 'no_dispatchable_incidents' | 'no_active_trigger';

/**
 * Logs why the sweep is not dispatching (rule 70 requirement 3): one aggregate read over the
 * pending queue, naming the filter that holds each incident back. Warns when incidents have
 * waited past the stall window without a single dispatch. Returns the stalled count.
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
  const settings = await resolveFleetOpsSettings(env);
  const stallWindowMs = settings.incidentDispatchStallHours * HOUR_MS;
  const breakdown = await explainUndispatchableIncidents(
    env,
    input.config,
    input.now,
    stallWindowMs
  );
  if (breakdown.pending === 0) return 0;
  const fields = {
    projectId: input.projectId,
    cause: input.cause,
    triggerIds: input.triggerIds,
    pendingIncidents: breakdown.pending,
    stalledIncidents: breakdown.stalled,
    stallWindowHours: settings.incidentDispatchStallHours,
    reasons: breakdown.reasons,
  };
  log.info('incident_trigger_sweep.declined', fields);
  if (breakdown.stalled > 0) log.warn('incident_trigger_sweep.dispatch_stalled', fields);
  return breakdown.stalled;
}

/**
 * Before dispatching, re-checks the Durable Object for engagement with the incidents' own ideas.
 * An idea someone linked a chat, note, file or pull request to is released, which makes its
 * incident tracked work and drops it from the batch. Returns the released signatures.
 */
export async function releaseEngagedIdeasBeforeDispatch(
  env: Env,
  projectId: string,
  incidents: IncidentListItem[],
  readEngagement?: IdeaWorkSnapshotReader
): Promise<string[]> {
  const owned = await loadOwnedIdeas(
    env,
    incidents.map((incident) => incident.id)
  );
  return releaseEngagedIncidentIdeas(env, projectId, owned, readEngagement);
}
