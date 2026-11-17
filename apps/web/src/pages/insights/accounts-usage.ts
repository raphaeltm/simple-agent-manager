/**
 * Words for an account's measured tokens and API-key spend on Insights · Accounts. Spend is always
 * called an estimate; an unpriced model makes it a floor and is named, never guessed.
 */
import type { InsightsAccountSpend, InsightsAccountTokens } from '@simple-agent-manager/shared';

import { formatTokens, formatUsd } from '../../components/chat/run-receipt/receipt-tokens';

export interface UsageLine {
  value: string;
  /** The value is a state ("Private", "Not reported"), not a figure: shown muted. */
  muted: boolean;
  /** Muted text after the value on the same line. */
  detail: string | null;
  /** A muted sentence under the row. */
  note: string | null;
}

/** Unpriced models named before "+N more", so a long list cannot become a wall of text. */
const UNPRICED_MODELS_NAMED = 3;
const CAPPED_NOTE = 'Cut at the usage row limit, so this is a floor.';

/** A row whose read failed: say so, rather than looking like "nothing measured". */
export const NOT_LOADED_LINE: UsageLine = {
  value: 'Not loaded',
  muted: true,
  detail: null,
  note: null,
};

function modelList(models: readonly string[]): string {
  const named = models.slice(0, UNPRICED_MODELS_NAMED).join(', ');
  const more = models.length - UNPRICED_MODELS_NAMED;
  return more > 0 ? `${named} and ${more} more` : named;
}

/** "1.2M" ("1.2M+" when the read hit its cap) with "40K per merged PR". */
export function tokensLine(tokens: InsightsAccountTokens, limited: boolean): UsageLine {
  const floor = limited ? '+' : '';
  return {
    value: `${formatTokens(tokens.total)}${floor}`,
    muted: false,
    detail:
      tokens.perMergedPullRequest === null
        ? null
        : `${formatTokens(tokens.perMergedPullRequest)}${floor} per merged PR`,
    note: limited ? CAPPED_NOTE : null,
  };
}

export function spendLine(spend: InsightsAccountSpend, limited: boolean): UsageLine {
  if (spend.state === 'not_reported') {
    return {
      value: 'Not reported',
      muted: true,
      detail: null,
      note: 'No measured usage in this range.',
    };
  }
  if (spend.state === 'private') {
    return {
      value: 'Private',
      muted: true,
      detail: null,
      note: 'Spend on a personal key is shown only to its owner.',
    };
  }
  const unpriced = modelList(spend.unpricedModels);
  if (spend.costUsd === null) {
    return {
      value: 'No estimate',
      muted: true,
      detail: null,
      note: `SAM has no price for ${unpriced}.`,
    };
  }
  const notes = ['Estimated at SAM’s model prices.'];
  if (spend.unpricedModels.length > 0) notes.push(`Partial: SAM has no price for ${unpriced}.`);
  if (limited) notes.push(CAPPED_NOTE);
  return {
    value: `${spend.unpricedModels.length > 0 || limited ? 'At least ' : ''}~${formatUsd(spend.costUsd)}`,
    muted: false,
    detail:
      spend.perMergedPullRequestUsd === null
        ? null
        : `~${formatUsd(spend.perMergedPullRequestUsd)} per merged PR`,
    note: notes.join(' '),
  };
}
