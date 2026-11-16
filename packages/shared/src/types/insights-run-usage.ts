/**
 * Run usage (Insights slice U): measured token usage of one run (chat session), per model.
 *
 * Sources, in order of preference for one run:
 * - `ai_proxy`: SAM's AI proxy measured every model call the run made through it.
 * - `harness`: the agent harness reported its own totals through the VM agent (Claude Code and
 *   OpenCode per turn, Codex from its rollout file).
 * A harness that reports nothing leaves the run "not reported"; tokens are never estimated.
 */

/** Where a run's token counts came from. */
export type RunUsageSource = 'harness' | 'ai_proxy';

/**
 * Token counts. `input` excludes cache reads and writes, which are counted separately.
 * `reasoning` is null when the source does not report it apart from `output`.
 */
export interface RunTokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number | null;
}

export interface RunModelUsage extends RunTokenCounts {
  /** Null when the harness did not say which model ran. */
  model: string | null;
  /** Spend estimate for this model in USD; null when not shown or the model has no catalog price. */
  estimatedSpendUsd: number | null;
}

/**
 * Spend appears only for API-key accounts, as an estimate from SAM's model catalog prices.
 * Subscription and platform accounts show tokens only (`not_applicable`); an account SAM cannot
 * identify shows `unknown_account`.
 */
export type RunUsageSpend =
  | { state: 'estimate'; usd: number | null; unpricedModels: string[] }
  | { state: 'not_applicable' }
  | { state: 'unknown_account' };

export type RunReceiptTokens =
  | { state: 'not_reported' }
  | {
      state: 'reported';
      source: RunUsageSource;
      models: RunModelUsage[];
      total: RunTokenCounts;
      spend: RunUsageSpend;
      /** True when the run had more model rows than one read returns; totals are a floor. */
      limited: boolean;
    };
