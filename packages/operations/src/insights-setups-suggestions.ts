/**
 * One-tap suggestions on Insights · Agent setups: a default profile for a skill, and a memory
 * request for a skill. Pure: the page applies a suggestion through the existing skill update API
 * (`PATCH /api/projects/:projectId/skills/:skillId`, capability `project:update`), so this module
 * only decides whether the numbers support one and builds that request's body.
 *
 * Minimum sample (`insights.setupsSuggestionMinRuns`, default 10 finished runs per compared
 * setup): below about ten runs one lucky or unlucky run moves a merge rate by ten points, and the
 * binomial standard error of a rate near 50% over ten runs is about 16 points, so a gap smaller
 * than that is noise. The default gap (`insights.setupsSuggestionMinGapPercent`, 20 points) sits
 * above it. A memory suggestion needs the same number of runs with resource telemetry, so its
 * 90th percentile is not just the largest of a handful of runs.
 *
 * Only this project's own skills are suggested on (a teammate's personal skill or a global one is
 * edited elsewhere), and only profiles the skill can point at: project profiles and the viewer's
 * own (`requireProjectProfile` in `apps/api/src/services/skills.ts` accepts exactly those).
 */
import { normalizeResourceRequirements, type InsightsSetupSuggestion } from '@simple-agent-manager/shared';
import { log } from '@simple-agent-manager/worker-core';

import type { SetupRun } from './insights-setups-compute';
import { nearestRankPercentile } from './insights-phase-timings';

export interface SuggestionLimits {
  minRuns: number;
  minGapPercent: number;
  memoryHeadroomPercent: number;
}

const GIB = 1024 ** 3;
/** Requests are suggested in half-gigabyte steps, and never below one gigabyte. */
const STEP_GB = 0.5;
const MIN_SUGGESTED_GB = 1;
/** A memory request is worth changing only when it moves by at least this much. */
const MIN_CHANGE_GB = 1;

interface Arm {
  id: string;
  name: string | null;
  applicable: boolean;
  runs: number;
  clean: number;
}

function rate(arm: Arm): number {
  return arm.runs > 0 ? arm.clean / arm.runs : 0;
}

function bySkill(runs: SetupRun[]): Map<string, SetupRun[]> {
  const skills = new Map<string, SetupRun[]>();
  for (const run of runs) {
    // Only this project's own skills can be changed from here.
    if (!run.skill.id || run.skill.owner !== 'project' || !run.skill.name) continue;
    const list = skills.get(run.skill.id) ?? [];
    list.push(run);
    skills.set(run.skill.id, list);
  }
  return skills;
}

function defaultProfileSuggestion(
  skillRuns: SetupRun[],
  limits: SuggestionLimits
): InsightsSetupSuggestion | null {
  const first = skillRuns[0];
  if (!first?.skill.id || !first.skill.name) return null;
  const arms = new Map<string, Arm>();
  for (const run of skillRuns) {
    if (!run.finished || !run.profile.id) continue;
    const arm = arms.get(run.profile.id) ?? {
      id: run.profile.id,
      name: run.profile.name,
      applicable: run.profile.owner === 'project' || run.profile.owner === 'you',
      runs: 0,
      clean: 0,
    };
    arm.runs += 1;
    if (run.mergedClean) arm.clean += 1;
    arms.set(run.profile.id, arm);
  }
  const sampled = [...arms.values()]
    .filter((arm) => arm.runs >= limits.minRuns)
    .sort((a, b) => rate(b) - rate(a) || b.runs - a.runs || a.id.localeCompare(b.id));
  const best = sampled[0];
  if (!best || !best.applicable || !best.name) return null;
  const currentDefault = first.skill.defaultProfileId;
  if (best.id === currentDefault) return null;
  const compared = sampled.find((arm) => arm.id === currentDefault) ?? sampled[1];
  if (!compared) return null;
  if ((rate(best) - rate(compared)) * 100 < limits.minGapPercent) return null;
  return {
    id: `default_profile:${first.skill.id}:${best.id}`,
    kind: 'default_profile',
    skill: { id: first.skill.id, name: first.skill.name },
    profile: { id: best.id, name: best.name, runs: best.runs, mergedCleanRate: rate(best) },
    compared: {
      id: compared.id,
      name: compared.name,
      runs: compared.runs,
      mergedCleanRate: rate(compared),
    },
    currentDefault: compared.id === currentDefault,
    apply: { skillId: first.skill.id, patch: { defaultProfileId: best.id } },
  };
}

/** The skill's stored requirements, or null when they cannot be read (logged, never thrown). */
function skillRequirements(run: SetupRun, projectId: string): Record<string, unknown> | null {
  const raw = run.skill.resourcesJson;
  if (!raw) return {};
  try {
    return { ...normalizeResourceRequirements(JSON.parse(raw) as unknown) };
  } catch (error) {
    log.warn('insights_setups.skill_resources_skipped', {
      projectId,
      skillId: run.skill.id,
      error: error instanceof Error ? error.message : String(error),
      action: 'no_request_size_suggestion',
    });
    return null;
  }
}

function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  return nearestRankPercentile([...values].sort((a, b) => a - b), 0.5);
}

function requestSizeSuggestion(
  skillRuns: SetupRun[],
  limits: SuggestionLimits,
  projectId: string
): InsightsSetupSuggestion | null {
  const first = skillRuns[0];
  if (!first?.skill.id || !first.skill.name) return null;
  const measured = skillRuns.filter((run) => run.memoryPeakBytes !== null);
  if (measured.length < limits.minRuns) return null;
  const requirements = skillRequirements(first, projectId);
  if (!requirements) return null;

  const peaks = measured.map((run) => run.memoryPeakBytes ?? 0).sort((a, b) => a - b);
  const p90Bytes = nearestRankPercentile(peaks, 0.9);
  const maxBytes = peaks[peaks.length - 1] ?? 0;
  const oomKills = measured.reduce((sum, run) => sum + run.oomKills, 0);
  const wanted = (p90Bytes / GIB) * (1 + limits.memoryHeadroomPercent / 100);
  // Rounded to a millionth of a step first, so 4.0000001 GB (bytes are whole numbers) stays 4.
  const steps = Math.ceil(Math.round((wanted / STEP_GB) * 1e6) / 1e6);
  const suggestedGb = Math.max(MIN_SUGGESTED_GB, steps * STEP_GB);

  const explicit = requirements.minMemoryGb;
  const requestedMb = medianOf(
    measured.flatMap((run) => (run.requestedMemoryMb === null ? [] : [run.requestedMemoryMb]))
  );
  const currentGb =
    typeof explicit === 'number' ? explicit : requestedMb === null ? null : requestedMb / 1024;
  if (currentGb === null) return null;

  const shrink = suggestedGb <= currentGb - MIN_CHANGE_GB && oomKills === 0;
  // Out-of-memory kills always justify asking for more, whatever the percentile says.
  const grow = suggestedGb >= currentGb + MIN_CHANGE_GB || (oomKills > 0 && suggestedGb > currentGb);
  if (!shrink && !grow) return null;

  let resourceRequirementsJson: string;
  try {
    resourceRequirementsJson = JSON.stringify(
      normalizeResourceRequirements({ ...requirements, minMemoryGb: suggestedGb })
    );
  } catch {
    return null;
  }
  return {
    id: `request_size:${first.skill.id}:${suggestedGb}`,
    kind: 'request_size',
    skill: { id: first.skill.id, name: first.skill.name },
    currentGb: Math.round(currentGb * 100) / 100,
    suggestedGb,
    runs: measured.length,
    p90Bytes,
    maxBytes,
    oomKills,
    apply: { skillId: first.skill.id, patch: { resourceRequirementsJson } },
  };
}

/** Every suggestion the runs support, skills with the most runs first. */
export function setupSuggestions(
  runs: SetupRun[],
  limits: SuggestionLimits,
  projectId: string
): InsightsSetupSuggestion[] {
  const skills = [...bySkill(runs).values()].sort(
    (a, b) => b.length - a.length || (a[0]?.skill.id ?? '').localeCompare(b[0]?.skill.id ?? '')
  );
  const out: InsightsSetupSuggestion[] = [];
  for (const skillRuns of skills) {
    const profile = defaultProfileSuggestion(skillRuns, limits);
    if (profile) out.push(profile);
    const size = requestSizeSuggestion(skillRuns, limits, projectId);
    if (size) out.push(size);
  }
  return out;
}
