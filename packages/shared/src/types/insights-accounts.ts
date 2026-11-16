/**
 * Insights · Accounts (slice A, idea 01M7HTS38KX2G78JD0ESAGMKKH): which account carried a
 * project's runs, and where agents stalled on a usage limit. Served by `projectAccounts`
 * (`packages/operations/src/insights-accounts.ts`) at
 * `GET /api/projects/:projectId/insights/accounts?range=…`.
 *
 * Everything is derived at read time from records SAM already keeps; nothing here is stored.
 * Spend is "not reported" until SAM records per-run usage (slice U), never an estimate.
 *
 * Account names are private to the person who owns the credential, as in the chat header
 * (`routes/chat-agent-credential.ts`): another member's account appears only as its kind
 * ("a teammate's Claude subscription"), grouped with their other accounts of that kind, and
 * never with a name or a credential id.
 */
import type { CredentialLimitCredentialSummary } from './credential-limits';
import type { InsightsRange } from './insights-flow';

/** Whose account it is, from the viewer's point of view. */
export type InsightsAccountOwner = 'you' | 'teammate' | 'project' | 'platform' | 'not_recorded';

/**
 * How the account is paid for: a provider subscription (Claude Max/Pro, ChatGPT), a
 * pay-as-you-go API key, SAM's platform credential, or unknown (the credential row is gone).
 */
export type InsightsAccountKind = 'subscription' | 'api_key' | 'platform' | 'unknown';

/** API-key spend. `not_reported` until per-run usage is recorded (slice U). */
export type InsightsAccountSpend =
  | { state: 'not_reported' }
  | { state: 'reported'; costUsd: number; perMergedPullRequestUsd: number | null };

export interface InsightsAccountStalls {
  /** Limit-stall episodes that began in the range (merged per account; see `InsightsStallEpisode`). */
  episodes: number;
  /** Sum of the episodes' durations, capped at now for an ongoing one. */
  totalMs: number;
  /** True when an episode is still going. */
  ongoing: boolean;
}

export interface InsightsAccount {
  /**
   * Stable key for this row within one response: the credential id for your own accounts,
   * otherwise the group (owner, agent, kind). Never another member's credential id.
   */
  key: string;
  /** Your own credential's name; null for anyone else's account. */
  name: string | null;
  owner: InsightsAccountOwner;
  kind: InsightsAccountKind;
  /** Agent harness the account ran (`claude-code`, `openai-codex`, …), null when not recorded. */
  agentType: string | null;
  /** How many separate credentials this row stands for (more than 1 only for grouped rows). */
  credentials: number;
  /** Runs in the range (Flow's run population), and how many merged a pull request. */
  runs: number;
  merged: number;
  /** Runs per bucket, aligned with `ProjectAccountsResponse.buckets`. */
  runsByBucket: number[];
  stalls: InsightsAccountStalls;
  /**
   * The provider's last-reported windows for your own accounts (the same summary as the chat
   * header's limit chip). Null for other people's accounts or when none was ever reported.
   */
  usage: CredentialLimitCredentialSummary | null;
  /** API keys only; null for subscriptions and the platform. */
  spend: InsightsAccountSpend | null;
}

export type InsightsStallOutcome = 'resumed' | 'blocked' | 'ongoing';

/**
 * One stretch of time an account stalled on a usage limit: overlapping limit waits of runs on
 * that account, and the provider windows it reported as rejected, merged into one interval.
 */
export interface InsightsStallEpisode {
  /** `InsightsAccount.key` of the account row it belongs to. */
  accountKey: string;
  /** The provider window that was exhausted ("5h", "Week"), when SAM recorded it. */
  window: string | null;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  /** Runs held by this episode (paused mid-run or held before starting). */
  runs: number;
  /**
   * `resumed`: the wait ended (reset, or the owner started anyway); `blocked`: SAM stopped
   * retrying and a person must act; `ongoing`: still waiting.
   */
  outcome: InsightsStallOutcome;
}

export type InsightsAccountsSection = 'runs' | 'stalls' | 'usage';

export interface ProjectAccountsResponse {
  projectId: string;
  range: InsightsRange;
  since: string;
  until: string;
  bucket: 'day' | 'week';
  /** Bucket start dates (YYYY-MM-DD, UTC), oldest first, every bucket in the range. */
  buckets: string[];
  /** Accounts, most runs first. Runs whose account was not recorded form their own row. */
  accounts: InsightsAccount[];
  /** Episodes, newest first, at most `listed`. */
  stallEpisodes: {
    items: InsightsStallEpisode[];
    total: number;
    listed: number;
    /** True when SAM looked at its cap of limit waits and older ones were left out. */
    truncated: boolean;
  };
  totals: { runs: number; merged: number };
  unavailable: InsightsAccountsSection[];
  generatedAt: string;
}
