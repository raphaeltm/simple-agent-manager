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

/** "~$4.12 estimated", or null when spend is not shown for this account. */
export function spendLabel(tokens: RunReceiptTokens): string | null {
  if (tokens.state !== 'reported' || tokens.spend.state !== 'estimate') return null;
  if (tokens.spend.usd === null) return 'No catalog price for this model';
  // Sub-cent spend reads as "<$0.01", never "$0.00", so a tiny run is not shown as free.
  const amount = tokens.spend.usd > 0 && tokens.spend.usd < 0.01 ? '<$0.01' : USD.format(tokens.spend.usd);
  const partial = tokens.spend.unpricedModels.length > 0 ? ', some models unpriced' : '';
  return `~${amount} estimated${partial}`;
}

export function tokensTile(tokens: RunReceiptTokens): {
  value: string;
  note: string;
  muted: boolean;
} {
  if (tokens.state === 'not_reported') {
    return {
      value: 'Not reported',
      note: 'This agent did not report token counts',
      muted: true,
    };
  }
  const total = totalTokens(tokens.total);
  const source = tokens.source === 'ai_proxy' ? 'Measured by SAM’s AI proxy' : 'Reported by the agent';
  const spend = spendLabel(tokens);
  return {
    value: `${formatTokens(total)}${tokens.limited ? '+' : ''}`,
    note: [spend, source].filter(Boolean).join(' · '),
    muted: false,
  };
}

/** "320k in · 41k out · 2.1M cache", one model's line. */
export function modelTokenLine(model: RunModelUsage): string {
  const parts = [`${formatTokens(model.input)} in`, `${formatTokens(model.output)} out`];
  const cache = model.cacheRead + model.cacheWrite;
  if (cache > 0) parts.push(`${formatTokens(cache)} cache`);
  if (model.reasoning) parts.push(`${formatTokens(model.reasoning)} reasoning`);
  return parts.join(' · ');
}
