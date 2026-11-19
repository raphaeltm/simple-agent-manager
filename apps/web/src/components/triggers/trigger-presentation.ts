/** Presentation helpers for trigger runs, shared by the Automation page. */

/**
 * Wall-clock duration between two ISO timestamps, e.g. "1m 5s".
 *
 * Output is deliberately identical to the two implementations this replaced
 * (`<1s` below a second, bare `2m` on an exact minute). Deduplicating formatters
 * must not silently restyle what users already read in execution history — the
 * only behaviour added here is the NaN/negative guard.
 */
export function formatDuration(startedAt?: string | null, completedAt?: string | null): string {
  if (!startedAt || !completedAt) return '—';
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (Number.isNaN(ms) || ms < 0) return '—';
  if (ms < 1000) return '<1s';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return secs > 0 ? `${minutes}m ${secs}s` : `${minutes}m`;
}
