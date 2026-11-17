/**
 * Words for an account's measured tokens and API-key spend on Insights · Accounts. Spend is always
 * called an estimate; an unpriced model makes it a floor and is named, never guessed.
 */
import type { InsightsAccountSpend, InsightsAccountTokens } from '@simple-agent-manager/shared';

import { formatTokens, formatUsd } from '../../components/chat/run-receipt/receipt-tokens';

export interface UsageLine {
  value: string;
  /** Muted text after the value on the same line. */
  detail: string | null;
  /** A muted sentence under the row. */
  note: string | null;
}

/** "1.2M" ("1.2M+" when the read hit its cap) with "40K per merged PR". */
export function tokensLine(tokens: InsightsAccountTokens, limited: boolean): UsageLine {
  const floor = limited ? '+' : '';
  return {
    value: `${formatTokens(tokens.total)}${floor}`,
    detail:
      tokens.perMergedPullRequest === null
        ? null
        : `${formatTokens(tokens.perMergedPullRequest)}${floor} per merged PR`,
    note: null,
  };
}

export function spendLine(spend: InsightsAccountSpend, limited: boolean): UsageLine {
  if (spend.state === 'not_reported') {
    return { value: 'Not reported', detail: null, note: 'No measured usage in this range.' };
  }
  if (spend.state === 'private') {
    return {
      value: 'Private',
      detail: null,
      note: 'Spend on a personal key is shown only to its owner.',
    };
  }
  const unpriced = spend.unpricedModels.join(', ');
  if (spend.costUsd === null) {
    return { value: 'No estimate', detail: null, note: `SAM has no price for ${unpriced}.` };
  }
  const floor = spend.unpricedModels.length > 0 || limited ? 'At least ' : '';
  return {
    value: `${floor}~${formatUsd(spend.costUsd)}`,
    detail:
      spend.perMergedPullRequestUsd === null
        ? null
        : `~${formatUsd(spend.perMergedPullRequestUsd)} per merged PR`,
    note:
      spend.unpricedModels.length > 0
        ? `Estimated at SAM’s model prices. Partial: SAM has no price for ${unpriced}.`
        : 'Estimated at SAM’s model prices.',
  };
}
