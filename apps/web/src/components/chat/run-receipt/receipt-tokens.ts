/**
 * Words for the receipt's token usage (Insights slice U). The server sends measured counts only;
 * a run whose harness reported nothing says so, and spend appears only as a labelled estimate for
 * API-key accounts.
 */
import type { RunModelUsage, RunReceiptTokens, RunTokenCounts } from '@simple-agent-manager/shared';

const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
});

/** "1.2M", "840", for token counts. */
export function formatTokens(count: number): string {
  return COMPACT.format(count);
}

/** Every token the run moved: fresh input, output, cache reads and cache writes. */
export function totalTokens(counts: RunTokenCounts): number {
  return counts.input + counts.output + counts.cacheRead + counts.cacheWrite;
}

export function formatUsd(usd: number): string {
  // Sub-cent spend reads as "<$0.01", never "$0.00", so a tiny run is not shown as free.
  return usd > 0 && usd < 0.01 ? '<$0.01' : USD.format(usd);
}

/**
 * The spend line under the model list, or null when spend is not shown for this account. It is
 * always called an estimate; with unpriced models it is a floor.
 */
export function spendLabel(tokens: RunReceiptTokens): string | null {
  if (tokens.state !== 'reported' || tokens.spend.state !== 'estimate') return null;
  const { usd, unpricedModels } = tokens.spend;
  if (usd === null) {
    return unpricedModels.length > 1
      ? 'No spend estimate: SAM has no price for these models'
      : 'No spend estimate: SAM has no price for this model';
  }
  const floor = tokens.limited || unpricedModels.length > 0 ? 'At least ' : '';
  return `${floor}~${formatUsd(usd)} estimated at SAM’s model prices`;
}

/** "~$3.98" for one model's row, "no price" when unpriced, or null when spend is not shown. */
export function modelSpendLabel(tokens: RunReceiptTokens, model: RunModelUsage): string | null {
  if (tokens.state !== 'reported' || tokens.spend.state !== 'estimate') return null;
  return model.estimatedSpendUsd === null ? 'no price' : `~${formatUsd(model.estimatedSpendUsd)}`;
}

export function tokensTile(
  tokens: RunReceiptTokens,
  context: { live: boolean; unavailable: boolean }
): { value: string; note: string; muted: boolean } {
  if (context.unavailable) {
    return { value: '—', note: 'Could not be read just now', muted: true };
  }
  if (tokens.state === 'not_reported') {
    if (tokens.limited)
      return { value: 'Incomplete', note: 'Usage rows could not be recorded', muted: true };
    return context.live
      ? { value: 'Not reported yet', note: 'Counted when the agent reports a turn', muted: true }
      : { value: 'Not reported', note: 'This agent did not report token counts', muted: true };
  }
  const total = totalTokens(tokens.total);
  const cache = tokens.total.cacheRead + tokens.total.cacheWrite;
  const source =
    tokens.source === 'ai_proxy' ? 'Measured by SAM’s AI proxy' : 'Reported by the agent';
  return {
    value: `${formatTokens(total)}${tokens.limited ? '+' : ''}`,
    note: cache > 0 ? `Incl. ${formatTokens(cache)} cache · ${source}` : source,
    muted: false,
  };
}

/** The parts of one model's line, each kept whole when the line wraps. */
export function modelTokenParts(model: RunModelUsage): string[] {
  const parts = [`${formatTokens(model.input)} in`, `${formatTokens(model.output)} out`];
  const cache = model.cacheRead + model.cacheWrite;
  if (cache > 0) parts.push(`${formatTokens(cache)} cache`);
  if (model.reasoning) parts.push(`${formatTokens(model.reasoning)} reasoning`);
  return parts;
}
