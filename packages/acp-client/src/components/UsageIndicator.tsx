import type { TokenUsage } from '../hooks/useAcpMessages';

interface UsageIndicatorProps {
  usage: TokenUsage;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/**
 * Small status bar showing cumulative token usage for the session.
 */
export function UsageIndicator({ usage }: UsageIndicatorProps) {
  if (usage.totalTokens === 0) return null;

  return (
    <div className="flex items-center space-x-3 text-xs text-gray-500">
      <span title="Input tokens">In: {formatTokens(usage.inputTokens)}</span>
      <span title="Output tokens">Out: {formatTokens(usage.outputTokens)}</span>
      <span title="Total tokens">Total: {formatTokens(usage.totalTokens)}</span>
    </div>
  );
}
