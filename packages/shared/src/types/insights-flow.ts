/**
 * Insights · Flow (slice F, idea 01M7HTS38KX2G78JD0ESAGMKKH): how work moves from idea to merged
 * in one project. Served by `projectFlow` (`packages/operations/src/insights-flow.ts`) at
 * `GET /api/projects/:projectId/insights/flow?range=…`, and read by the Insights page and the
 * Project Overview's "This week" pane.
 *
 * Every number is derived at read time from records SAM already keeps. Nothing here is stored.
 * A value the records cannot support is `null` ("not recorded"), never an estimate.
 */
import type { IdeaDerivedState } from './ideas';

/** The ranges the page offers. A five-minute client cache is enough at these sizes. */
export const INSIGHTS_RANGES = ['7d', '30d', '90d'] as const;
export type InsightsRange = (typeof INSIGHTS_RANGES)[number];
export const DEFAULT_INSIGHTS_RANGE: InsightsRange = '30d';
export const INSIGHTS_RANGE_DAYS: Record<InsightsRange, number> = { '7d': 7, '30d': 30, '90d': 90 };

export function isInsightsRange(value: unknown): value is InsightsRange {
  return typeof value === 'string' && (INSIGHTS_RANGES as readonly string[]).includes(value);
}

/**
 * Why a run stopped before finishing, derived at read time from the task's terminal reason,
 * error message, limit-wait columns, its pull request, and an open question (attention marker or
 * ask). `insights-flow-stop-reasons.ts` holds the rules, in priority order.
 */
export const FLOW_STOP_REASONS = [
  'waiting_on_person',
  'pr_open',
  'ci_failing',
  'usage_limit',
  'no_machine',
  'setup_failed',
  'ran_too_long',
  'agent_stopped',
  'session_expired',
  'pr_closed',
  'stopped_by_coordinator',
  'stopped_by_person',
  'other_error',
] as const;
export type FlowStopReason = (typeof FLOW_STOP_REASONS)[number];

export const FLOW_STOP_REASON_LABELS: Record<FlowStopReason, string> = {
  waiting_on_person: 'Waiting on a person',
  pr_open: 'Pull request waiting to merge',
  ci_failing: 'CI failing',
  usage_limit: 'Hit a usage limit',
  no_machine: 'No machine available',
  setup_failed: 'Workspace setup failed',
  ran_too_long: 'Ran past the time limit',
  agent_stopped: 'Agent stopped responding',
  session_expired: 'Session expired while asleep',
  pr_closed: 'Pull request closed',
  stopped_by_coordinator: 'Stopped by a coordinator',
  stopped_by_person: 'Stopped by a person',
  other_error: 'Other error',
};

/**
 * Stops that are a decision rather than a blocker. They are listed, but never chosen as the
 * "top blocker", because a person or coordinator stopping a run on purpose is not friction.
 */
export const FLOW_DELIBERATE_STOP_REASONS: readonly FlowStopReason[] = [
  'stopped_by_coordinator',
  'stopped_by_person',
];

/** A median over the range and over the range before it, and how many items it covers. */
export interface FlowMedian {
  medianMs: number | null;
  previousMedianMs: number | null;
  count: number;
}

/** A share over the range and the range before it. `rate` is null when `of` is 0. */
export interface FlowRate {
  count: number;
  of: number;
  rate: number | null;
  previousRate: number | null;
}

export interface FlowRunsBucket {
  /** First day of the bucket, `YYYY-MM-DD` (UTC). */
  start: string;
  merged: number;
  closed: number;
  failed: number;
}

export interface FlowRuns {
  /** Days for the 7-day range, weeks starting Monday otherwise. */
  bucket: 'day' | 'week';
  buckets: FlowRunsBucket[];
  /** Runs in the range that are in none of the chart's three outcomes. */
  other: { stopped: number; prOpen: number; noPullRequest: number };
}

export interface FlowStopReasonCount {
  reason: FlowStopReason;
  count: number;
}

export interface FlowFlakyCheck {
  /** The check's name as GitHub reports it. */
  name: string;
  /** Commits on which this check failed and then passed with no code change. */
  flips: number;
  /** Commits this check ran on in the range. */
  commits: number;
}

export interface FlowWaitingIdea {
  ideaId: string;
  title: string;
  createdAt: string;
  state: IdeaDerivedState;
  /** Chats linked to the idea (runs that worked on it). */
  chats: number;
  /** The pull request behind `review` or `merged`, when there is one. */
  pullRequest: { number: number; checksState: string | null } | null;
  /** The agent's question or the failure it reported, truncated by the server. */
  note: string | null;
}

export type FlowTopBlocker =
  | { kind: 'stop_reason'; reason: FlowStopReason; count: number }
  | { kind: 'flaky_check'; name: string; flips: number };

/** Sections a failed read left empty, so the page can say what it could not load. */
export type FlowSection = 'runs' | 'ci' | 'flaky' | 'asks' | 'ideas' | 'rework' | 'merged';

export interface ProjectFlowResponse {
  projectId: string;
  range: InsightsRange;
  /** ISO start and end of the range. The previous range ends where this one starts. */
  since: string;
  until: string;
  tiles: {
    /** Idea created → its first pull request merged, for ideas whose first merge is in the range. */
    ideaToMerged: FlowMedian & {
      /** Ideas examined, newest-updated first, and whether the cap cut the list short. */
      sampled: { ideas: number; cap: number; truncated: boolean };
    };
    /**
     * Pull requests whose opening commit passed every check with no failure and no rerun. Only
     * pull requests SAM saw from their first commit count; `recorded` says how many that was.
     */
    ciFirstTry: FlowRate & { recorded: number };
    /** Ask filed → answered (open asks count up to now). */
    waitingOnPerson: FlowMedian;
    /** Merged pull requests followed by another pull request within `windowDays`. */
    rework: FlowRate & { windowDays: number };
  };
  merged: { count: number; previous: number };
  runs: FlowRuns;
  stopReasons: FlowStopReasonCount[];
  flakyChecks: { items: FlowFlakyCheck[]; total: number };
  waitingIdeas: { items: FlowWaitingIdea[]; total: number };
  topBlocker: FlowTopBlocker | null;
  unavailable: FlowSection[];
  generatedAt: string;
}
