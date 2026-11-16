/**
 * Lifecycle latency over a time range, for Admin Health & cost (Insights slice H). The daily
 * check (`daily-evaluation.ts`) answers "did a state regress in the last day"; this answers
 * "how slow was each state over the range the admin picked, and is anything open about it".
 *
 * It reuses the daily check's statistics (`latencyStats`) and its over-budget verdict
 * (`classifyRegression`, with no baseline so only `over_budget` can fire), and the watchdog's
 * budgets and messages. Incidents are found by the triage signature the hourly platform-feedback
 * triage gives the watchdog's and the daily check's errors (`platformErrorSignature`).
 *
 * Round trips: settings (cached per isolate), one windowed episode read for every watched state
 * at once (the daily check reads one per state), one read of rows stuck past budget now, and one
 * incident read. Durations are lower bounds accurate to about one five-minute sample at each end.
 */
import type {
  InstallationLatencyIncident,
  InstallationLatencyIncidentState,
  InstallationLifecycleLatency,
} from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { platformErrorSignature } from '../platform-feedback-triage';
import { classifyRegression, latencyStats, regressionMessage } from './daily-evaluation';
import { slowStateMessage } from './watchdog';
import {
  budgetMs,
  LIFECYCLE_WATCHES,
  type LifecycleLatencySettings,
  resolveLifecycleLatencySettings,
} from './watches';

/** Open incident queue states (`ACTIVE_INCIDENT_STATES`, platform-feedback-incidents). */
const OPEN_INCIDENT_STATES: readonly InstallationLatencyIncidentState[] = [
  'pending',
  'dispatched',
  'claimed',
];

interface EpisodeRow {
  entity_type: string;
  status: string;
  duration_ms: number;
}

interface IncidentRow {
  signature: string;
  canonical_signature: string | null;
  queue_state: string;
  first_seen_at: number;
  last_seen_at: number;
  occurrence_count: number;
  idea_id: string | null;
  idea_project_id: string | null;
}

const stateKey = (entityType: string, status: string) => `${entityType}.${status}`;

export async function readLifecycleLatencyRange(
  env: Env,
  input: { sinceMs: number; untilMs: number },
  settingsOverride?: LifecycleLatencySettings
): Promise<InstallationLifecycleLatency> {
  const settings = settingsOverride ?? (await resolveLifecycleLatencySettings(env));
  // A budget of 0 turns a state's watch off for the watchdog and the daily check; it is not shown.
  const active = LIFECYCLE_WATCHES.filter((watch) => budgetMs(settings, watch) > 0);
  if (active.length === 0) return { minSamples: settings.minSamples, states: [] };
  const sampleLimit = Math.max(1, settings.evaluationSampleLimit);
  const since = new Date(input.sinceMs).toISOString();
  const until = new Date(input.untilMs).toISOString();

  const signatures = await Promise.all(
    active.map(async (watch) => ({
      key: stateKey(watch.entityType, watch.status),
      signatures: await Promise.all([
        platformErrorSignature('api', slowStateMessage(watch.entityType, watch.status)),
        platformErrorSignature('api', regressionMessage(watch)),
      ]),
    }))
  );
  const allSignatures = signatures.flatMap((entry) => entry.signatures);

  const stuckClauses = active
    .map(() => '(entity_type = ? AND status = ? AND first_seen_at <= ?)')
    .join(' OR ');
  const stuckBinds = active.flatMap((watch) => [
    watch.entityType,
    watch.status,
    new Date(input.untilMs - budgetMs(settings, watch)).toISOString(),
  ]);
  const signaturePlaceholders = allSignatures.map(() => '?').join(', ');
  const statePlaceholders = OPEN_INCIDENT_STATES.map(() => '?').join(', ');

  const [episodes, stuck, incidents] = await Promise.all([
    // Newest `sampleLimit` finished episodes per state in the range, all states in one read.
    env.DATABASE.prepare(
      `SELECT entity_type, status, duration_ms FROM (
         SELECT entity_type, status,
                (julianday(last_seen_at) - julianday(first_seen_at)) * 86400000.0 AS duration_ms,
                ROW_NUMBER() OVER (PARTITION BY entity_type, status ORDER BY ended_at DESC, id DESC) AS rn
           FROM lifecycle_state_episodes
          WHERE ended_at >= ? AND ended_at < ?
       ) WHERE rn <= ?`
    )
      .bind(since, until, sampleLimit)
      .all<EpisodeRow>(),
    env.DATABASE.prepare(
      `SELECT entity_type, status, COUNT(*) AS n FROM lifecycle_state_observations
        WHERE ${stuckClauses}
        GROUP BY entity_type, status`
    )
      .bind(...stuckBinds)
      .all<{ entity_type: string; status: string; n: number }>(),
    env.DATABASE.prepare(
      `SELECT t.signature, t.canonical_signature, t.queue_state, t.first_seen_at, t.last_seen_at,
              t.occurrence_count, t.idea_id, idea.project_id AS idea_project_id
         FROM platform_feedback_triages t
         LEFT JOIN tasks idea ON idea.id = t.idea_id
        WHERE (t.signature IN (${signaturePlaceholders})
               OR t.canonical_signature IN (${signaturePlaceholders}))
          AND t.queue_state IN (${statePlaceholders})
        ORDER BY t.last_seen_at DESC`
    )
      .bind(...allSignatures, ...allSignatures, ...OPEN_INCIDENT_STATES)
      .all<IncidentRow>(),
  ]);

  const durations = new Map<string, number[]>();
  for (const row of episodes.results ?? []) {
    const duration = Number(row.duration_ms);
    if (!Number.isFinite(duration)) {
      log.warn('lifecycle_latency.range_episode_skipped', {
        state: stateKey(row.entity_type, row.status),
        reason: 'unreadable_duration',
        action: 'skipped',
      });
      continue;
    }
    const key = stateKey(row.entity_type, row.status);
    durations.set(key, [...(durations.get(key) ?? []), Math.max(0, Math.round(duration))]);
  }
  const stuckByState = new Map(
    (stuck.results ?? []).map((row) => [stateKey(row.entity_type, row.status), Number(row.n)])
  );
  const incidentsBySignature = new Map<string, InstallationLatencyIncident>();
  for (const row of incidents.results ?? []) {
    const state = OPEN_INCIDENT_STATES.find((candidate) => candidate === row.queue_state);
    const firstSeen = Number(row.first_seen_at);
    const lastSeen = Number(row.last_seen_at);
    if (!state || !Number.isFinite(firstSeen) || !Number.isFinite(lastSeen)) continue;
    const incident: InstallationLatencyIncident = {
      signature: row.signature,
      state,
      firstSeenAt: new Date(firstSeen).toISOString(),
      lastSeenAt: new Date(lastSeen).toISOString(),
      occurrences: Number(row.occurrence_count) || 0,
      ideaId: row.idea_id,
      ideaProjectId: row.idea_project_id,
    };
    incidentsBySignature.set(row.signature, incident);
    if (row.canonical_signature) incidentsBySignature.set(row.canonical_signature, incident);
  }

  const noBaseline = latencyStats([]);
  return {
    minSamples: settings.minSamples,
    states: active.map((watch) => {
      const key = stateKey(watch.entityType, watch.status);
      const stats = latencyStats(durations.get(key) ?? []);
      const stateBudgetMs = budgetMs(settings, watch);
      const stateSignatures = signatures.find((entry) => entry.key === key)?.signatures ?? [];
      const stateIncidents = [
        ...new Set(
          stateSignatures
            .map((signature) => incidentsBySignature.get(signature))
            .filter((incident): incident is InstallationLatencyIncident => Boolean(incident))
        ),
      ];
      return {
        entityType: watch.entityType,
        status: watch.status,
        budgetMs: stateBudgetMs,
        count: stats.count,
        p50Ms: stats.p50Ms,
        p95Ms: stats.p95Ms,
        maxMs: stats.maxMs,
        truncated: stats.count >= sampleLimit,
        overBudget:
          classifyRegression(stats, noBaseline, stateBudgetMs, settings) === 'over_budget',
        overBudgetNow: stuckByState.get(key) ?? 0,
        incidents: stateIncidents,
      };
    }),
  };
}
