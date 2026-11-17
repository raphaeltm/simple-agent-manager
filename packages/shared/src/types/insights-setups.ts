/**
 * Insights · Agent setups (slice S, idea 01M7HTS38KX2G78JD0ESAGMKKH): which setup (agent profile,
 * skill or model) gets work merged on this repository, how fast, with how much help, at what token
 * and memory cost. Served by `projectSetups` (`packages/operations/src/insights-setups.ts`) at
 * `GET /api/projects/:projectId/insights/setups?range=…&groupBy=…`.
 *
 * Every number is derived at read time from records SAM already keeps; nothing here is stored.
 * A value the records cannot support is marked missing (`not_reported`, `not_recorded`), never
 * estimated. The run population is Flow's (`runsCte`), so the tabs count the same runs.
 */
import type { InsightsRange } from './insights-flow';

export const INSIGHTS_SETUP_GROUPINGS = ['profile', 'skill', 'model'] as const;
export type InsightsSetupGrouping = (typeof INSIGHTS_SETUP_GROUPINGS)[number];
export const DEFAULT_INSIGHTS_SETUP_GROUPING: InsightsSetupGrouping = 'profile';

export function isInsightsSetupGrouping(value: unknown): value is InsightsSetupGrouping {
  return (
    typeof value === 'string' && (INSIGHTS_SETUP_GROUPINGS as readonly string[]).includes(value)
  );
}

/**
 * Whose setup a row names, from the viewer's side. A teammate's personal profile or skill is not
 * named (`label` is null), the way Accounts hides a teammate's account. `none` is the row for runs
 * that had no profile or skill; `not_recorded` the row for runs SAM has no agent session for.
 */
export type InsightsSetupOwner = 'project' | 'you' | 'teammate' | 'none' | 'not_recorded';

/** Human follow-ups during a run: measured from the chat, or not recorded when it is gone. */
export type InsightsSetupNudges =
  | { state: 'not_recorded' }
  | {
      state: 'measured';
      /** Follow-ups per measured run. */
      perRun: number;
      total: number;
      /** Runs whose chat could be read; the rest are left out of `perRun`. */
      runs: number;
    };

/**
 * Tokens per merged pull request, over the runs whose harness or the AI proxy reported usage.
 * `not_reported` when no run in the group reported any (a harness that reports nothing, or runs
 * from before usage was recorded). Counted once per chat, so a woken run is not counted twice.
 */
export type InsightsSetupTokens =
  | { state: 'not_reported' }
  | {
      state: 'reported';
      /** Input, output and cache tokens of the reporting runs. */
      total: number;
      /** `total` divided by merged runs among the reporting runs; null when none merged. */
      perMergedPullRequest: number | null;
      /** Runs that reported usage, and how many of those merged. */
      reportedRuns: number;
      merged: number;
    };

/** Peak memory across runs, against what they asked for. */
export type InsightsSetupMemory =
  | { state: 'not_recorded' }
  | {
      state: 'measured';
      /** Nearest-rank 90th percentile of each run's peak memory. */
      p90Bytes: number;
      maxBytes: number;
      /** Median requested memory of those runs; null when none recorded a reservation. */
      requestedMb: number | null;
      /** Runs with resource telemetry. */
      runs: number;
      oomKills: number;
    };

export interface InsightsSetupGroup {
  /** Stable within one response: a profile or skill id, a model id, or a fixed key for none. */
  key: string;
  /** Display name; null for a teammate's personal profile or skill. */
  label: string | null;
  owner: InsightsSetupOwner;
  /** Agent harness for a model row (`claude-code`, …): a null model means its default model. */
  agentType: string | null;
  /** The skills (or, on a skill row, the profiles) this setup ran most, up to two names. */
  usedFor: string[];
  /** Runs in the range (Flow's population), and how many of them have finished. */
  runs: number;
  finished: number;
  /** Finished runs whose pull request merged and needed no follow-up within the rework window. */
  mergedClean: number;
  /** `mergedClean / finished`; null with no finished run. */
  mergedCleanRate: number | null;
  merged: number;
  /** Median from the run being asked for to its first pull request, over runs that opened one. */
  medianToPullRequestMs: number | null;
  pullRequests: number;
  nudges: InsightsSetupNudges;
  tokens: InsightsSetupTokens;
  memory: InsightsSetupMemory;
}

/** A skill change the numbers support, applied through the skill update API (PATCH skill). */
export type InsightsSetupSuggestion =
  | {
      id: string;
      kind: 'default_profile';
      skill: { id: string; name: string };
      profile: { id: string; name: string; runs: number; mergedCleanRate: number };
      /** The profile it is compared with: the skill's current default, else the runner-up. */
      compared: { id: string; name: string | null; runs: number; mergedCleanRate: number };
      currentDefault: boolean;
      apply: { skillId: string; patch: { defaultProfileId: string } };
    }
  | {
      id: string;
      kind: 'request_size';
      skill: { id: string; name: string };
      currentGb: number;
      suggestedGb: number;
      runs: number;
      p90Bytes: number;
      maxBytes: number;
      oomKills: number;
      apply: { skillId: string; patch: { resourceRequirementsJson: string } };
    };

/** Parts of the page that could not be read; the rest still renders. */
export type InsightsSetupsSection = 'runs' | 'nudges';

export interface ProjectSetupsResponse {
  projectId: string;
  range: InsightsRange;
  groupBy: InsightsSetupGrouping;
  since: string;
  until: string;
  /**
   * Rework counted here: a follow-up pull request on the same branch within `windowDays` of the
   * merge. Flow also counts follow-ups linked to the same idea; reading idea links costs more
   * round trips than this read is allowed, so the two tabs can differ on idea-linked rework.
   */
  rework: { windowDays: number; rule: 'same_branch' };
  /** Runs examined, newest first; `truncated` when the cap cut the range short. */
  sample: { runs: number; cap: number; truncated: boolean };
  groups: InsightsSetupGroup[];
  suggestions: InsightsSetupSuggestion[];
  /** Minimum finished runs per setup before a suggestion is offered. */
  suggestionMinRuns: number;
  unavailable: InsightsSetupsSection[];
  generatedAt: string;
}

/** One run's chat window, for the ProjectData `countRunNudges` read. */
export interface RunNudgeWindow {
  sessionId: string;
  /** Window start and end, epoch ms; the end is now for a run still going. */
  fromMs: number;
  toMs: number;
}

/**
 * Human follow-ups per window, in input order; null where the chat does not exist in this
 * project's object or its messages were archived away (not recorded, never zero).
 */
export interface RunNudgeCounts {
  counts: Array<number | null>;
}
