/**
 * Pure aggregation for Insights · Agent setups (`insights-setups.ts`): turns one row per run into
 * one row per setup. No I/O, so every rule here is unit-tested directly.
 *
 * Definitions (each derived at read time; nothing is stored):
 * - finished: the run reached `completed`, `failed` or `cancelled`.
 * - merged without rework: a finished run whose pull request merged, with no follow-up pull
 *   request on the same branch within the rework window (`sameBranchFollowUpSql`). The rate is
 *   over finished runs, so a failed run counts against its setup.
 * - median to pull request: from the run being asked for (`tasks.created_at`, so machine wait
 *   counts) to the first pull request it opened, over runs that opened one.
 * - nudges: messages a person sent into the run's chat while it ran (`project-data/do/run-nudges.ts`
 *   has the exact rule). Per measured run; a run whose chat could not be read is left out.
 * - tokens per merged pull request: measured tokens of the runs that reported usage, counted once
 *   per chat (a woken run continues its predecessor's chat), divided by how many of those runs
 *   merged. Runs that reported nothing are left out, never estimated.
 * - memory p90 / requested: nearest-rank 90th percentile of each run's peak memory
 *   (`workspace_resource_summaries.memory_peak_bytes`), against the median reservation.
 */
import type {
  InsightsSetupGroup,
  InsightsSetupGrouping,
  InsightsSetupOwner,
} from '@simple-agent-manager/shared';

import { nearestRankPercentile } from './insights-phase-timings';

/** One run, as the setups read sees it after validation. */
export interface SetupRun {
  id: string;
  finished: boolean;
  merged: boolean;
  mergedClean: boolean;
  toPullRequestMs: number | null;
  profile: SetupRef;
  skill: SetupRef & { defaultProfileId: string | null; resourcesJson: string | null };
  /** The runtime contract model; null with a recorded agent session means the harness default. */
  model: string | null;
  agentType: string | null;
  /** False when SAM has no agent session for the run, so its model is not recorded. */
  sessionRecorded: boolean;
  chatSessionId: string | null;
  tokens: number | null;
  memoryPeakBytes: number | null;
  oomKills: number;
  requestedMemoryMb: number | null;
  nudges: number | null;
}

export interface SetupRef {
  id: string | null;
  /** Display name, or null when it is a teammate's personal row or no longer exists. */
  name: string | null;
  owner: InsightsSetupOwner;
}

export const NONE_KEY = '__none__';
export const NOT_RECORDED_KEY = '__not_recorded__';

interface GroupIdentity {
  key: string;
  label: string | null;
  owner: InsightsSetupOwner;
  agentType: string | null;
}

export function groupIdentity(run: SetupRun, groupBy: InsightsSetupGrouping): GroupIdentity {
  if (groupBy === 'model') {
    if (!run.sessionRecorded) {
      return { key: NOT_RECORDED_KEY, label: null, owner: 'not_recorded', agentType: null };
    }
    if (run.model) return { key: run.model, label: run.model, owner: 'project', agentType: null };
    const agent = run.agentType ?? 'unknown';
    // The harness's own default model: a real setup, named by its harness on the page.
    return { key: `default:${agent}`, label: null, owner: 'project', agentType: run.agentType };
  }
  const ref = groupBy === 'profile' ? run.profile : run.skill;
  if (!ref.id) return { key: NONE_KEY, label: null, owner: 'none', agentType: null };
  return { key: ref.id, label: ref.name, owner: ref.owner, agentType: null };
}

/** Up to `limit` names, most runs first: skills for a profile or model row, profiles for a skill row. */
function usedFor(runs: SetupRun[], groupBy: InsightsSetupGrouping, limit = 2): string[] {
  const counts = new Map<string, number>();
  for (const run of runs) {
    const ref = groupBy === 'skill' ? run.profile : run.skill;
    if (!ref.name) continue;
    counts.set(ref.name, (counts.get(ref.name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .slice(0, limit)
    .map(([name]) => name);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  return nearestRankPercentile([...values].sort((a, b) => a - b), 0.5);
}

export function summarizeGroup(identity: GroupIdentity, runs: SetupRun[], groupBy: InsightsSetupGrouping): InsightsSetupGroup {
  const finished = runs.filter((run) => run.finished);
  const mergedClean = finished.filter((run) => run.mergedClean).length;
  const toPr = runs.flatMap((run) => (run.toPullRequestMs === null ? [] : [run.toPullRequestMs]));

  const nudged = runs.flatMap((run) => (run.nudges === null ? [] : [run.nudges]));
  const nudgeTotal = nudged.reduce((sum, value) => sum + value, 0);

  // Tokens once per chat; the newest run of a chat (runs arrive newest first) carries it.
  const reporting = runs.filter((run) => run.tokens !== null);
  const seenChats = new Set<string>();
  let tokenTotal = 0;
  for (const run of reporting) {
    const chat = run.chatSessionId ?? run.id;
    if (seenChats.has(chat)) continue;
    seenChats.add(chat);
    tokenTotal += run.tokens ?? 0;
  }
  const reportingMerged = reporting.filter((run) => run.merged).length;

  const peaks = runs.flatMap((run) => (run.memoryPeakBytes === null ? [] : [run.memoryPeakBytes]));
  const sortedPeaks = [...peaks].sort((a, b) => a - b);
  const requested = runs.flatMap((run) =>
    run.memoryPeakBytes !== null && run.requestedMemoryMb !== null ? [run.requestedMemoryMb] : []
  );

  return {
    key: identity.key,
    label: identity.label,
    owner: identity.owner,
    agentType: identity.agentType,
    usedFor: usedFor(runs, groupBy),
    runs: runs.length,
    finished: finished.length,
    mergedClean,
    mergedCleanRate: finished.length > 0 ? mergedClean / finished.length : null,
    merged: runs.filter((run) => run.merged).length,
    medianToPullRequestMs: median(toPr),
    pullRequests: toPr.length,
    nudges:
      nudged.length > 0
        ? { state: 'measured', perRun: nudgeTotal / nudged.length, total: nudgeTotal, runs: nudged.length }
        : { state: 'not_recorded' },
    tokens:
      reporting.length > 0
        ? {
            state: 'reported',
            total: Math.round(tokenTotal),
            perMergedPullRequest: reportingMerged > 0 ? Math.round(tokenTotal / reportingMerged) : null,
            reportedRuns: reporting.length,
            merged: reportingMerged,
          }
        : { state: 'not_reported' },
    memory:
      sortedPeaks.length > 0
        ? {
            state: 'measured',
            p90Bytes: nearestRankPercentile(sortedPeaks, 0.9),
            maxBytes: sortedPeaks[sortedPeaks.length - 1] ?? 0,
            requestedMb: median(requested),
            runs: sortedPeaks.length,
            oomKills: runs.reduce((sum, run) => sum + (run.memoryPeakBytes === null ? 0 : run.oomKills), 0),
          }
        : { state: 'not_recorded' },
  };
}

/** One row per setup, most runs first; the rows for "none" and "not recorded" go last. */
export function groupRuns(runs: SetupRun[], groupBy: InsightsSetupGrouping): InsightsSetupGroup[] {
  const buckets = new Map<string, { identity: GroupIdentity; runs: SetupRun[] }>();
  for (const run of runs) {
    const identity = groupIdentity(run, groupBy);
    const bucket = buckets.get(identity.key) ?? { identity, runs: [] };
    bucket.runs.push(run);
    buckets.set(identity.key, bucket);
  }
  const fallback = (owner: InsightsSetupOwner) => (owner === 'none' || owner === 'not_recorded' ? 1 : 0);
  return [...buckets.values()]
    .map(({ identity, runs: groupRunsList }) => summarizeGroup(identity, groupRunsList, groupBy))
    .sort(
      (a, b) =>
        fallback(a.owner) - fallback(b.owner) || b.runs - a.runs || a.key.localeCompare(b.key)
    );
}
