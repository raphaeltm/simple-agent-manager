/** Display formatters shared by the AI usage and budget sections of Settings > Usage. */
export function formatCost(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return '< $0.01';
  return `$${usd.toFixed(2)}`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

export function truncateModel(model: string, max = 32): string {
  if (model.length <= max) return model;
  return model.slice(0, max - 1) + '\u2026';
}
