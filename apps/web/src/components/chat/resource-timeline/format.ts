/**
 * Display formatting for resource values. Every number the timeline shows passes
 * through here so units are consistent between the readout, axes and stats.
 */

import { formatFileSize } from '../../../lib/file-utils';

const EM_DASH = '—';

export function formatCores(cores: number | null | undefined): string {
  if (cores == null || !Number.isFinite(cores)) return EM_DASH;
  if (cores === 0) return '0 cores';
  if (cores < 0.01) return '<0.01 cores';
  const digits = cores < 10 ? 2 : 1;
  return `${cores.toFixed(digits)} ${cores === 1 ? 'core' : 'cores'}`;
}

/** Compact core count for axis labels ("1.5"), where the unit is in the panel title. */
export function formatCoresAxis(cores: number): string {
  if (cores === 0) return '0';
  return cores < 1 ? cores.toFixed(2).replace(/0+$/, '') : `${Number(cores.toFixed(1))}`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return EM_DASH;
  return formatFileSize(bytes);
}

export function formatRate(bytesPerSecond: number | null | undefined): string {
  if (bytesPerSecond == null || !Number.isFinite(bytesPerSecond)) return EM_DASH;
  return `${formatFileSize(Math.round(bytesPerSecond))}/s`;
}

/** Elapsed time with seconds precision below two minutes ("35s", "4m 10s", "2h 5m", "3d 4h"). */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 120) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 10) return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`;
  if (minutes < 120) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

/** Wall-clock label whose precision follows the zoom level. */
export function formatClock(ts: number, precisionMs: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    ...(precisionMs < 60_000 ? { second: '2-digit' } : {}),
  });
}

/** "Sep 28, 20:13" — used where the day matters (range labels, long sessions). */
export function formatDayTime(ts: number): string {
  return new Date(ts).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function isSameDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

/** A time range label that only repeats the date when the range crosses midnight. */
export function formatRange(start: number, end: number, precisionMs: number): string {
  if (isSameDay(start, end)) {
    return `${formatClock(start, precisionMs)} – ${formatClock(end, precisionMs)}`;
  }
  return `${formatDayTime(start)} – ${formatDayTime(end)}`;
}
