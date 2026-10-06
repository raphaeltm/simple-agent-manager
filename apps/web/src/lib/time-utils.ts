/**
 * Shared time formatting utilities.
 *
 * Consolidates formatRelativeTime / timeAgo / formatDuration that were
 * duplicated across ActivityFeed, ChatSessionList, TriggerCard, library/types,
 * and chat-session-utils.
 */

/**
 * Format a Unix-ms timestamp as a short relative string ("Just now", "5m ago", "3d ago").
 * Falls back to locale date string for timestamps older than 30 days.
 */
export function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

/**
 * Format an ISO date string as a short relative string ("just now", "5m ago", "3d ago").
 * Unlike formatRelativeTime, uses lowercase and does not fall back to locale date.
 */
export function timeAgo(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Format the duration between two Unix-ms timestamps as a short string ("<1m", "5m", "2h 15m").
 */
export function formatDuration(startedAt: number, endedAt: number | null): string {
  const end = endedAt ?? Date.now();
  const diff = end - startedAt;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * Format a span in milliseconds as a short label with at most two units:
 * "2d 3h", "2h 10m", "35m". Sub-minute spans round up to "1m". Used for both
 * countdowns ("resets in …") and ages ("sampled … ago").
 */
export function formatMsSpan(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0m';
  if (ms >= MS_PER_DAY) {
    const days = Math.floor(ms / MS_PER_DAY);
    const hours = Math.floor((ms % MS_PER_DAY) / MS_PER_HOUR);
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (ms >= MS_PER_HOUR) {
    const hours = Math.floor(ms / MS_PER_HOUR);
    const minutes = Math.floor((ms % MS_PER_HOUR) / MS_PER_MINUTE);
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${Math.max(1, Math.ceil(ms / MS_PER_MINUTE))}m`;
}
