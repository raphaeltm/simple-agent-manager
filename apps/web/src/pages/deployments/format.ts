/**
 * Small formatting helpers the Deployments pages share: status tones and their colours,
 * relative times, and safe readers for the JSON the deployment server reports.
 */
import { formatTimeFromNow } from '../../lib/time-utils';

export type Tone = 'success' | 'info' | 'warning' | 'danger' | 'muted';

export const TONE_COLOR: Record<Tone, string> = {
  success: 'var(--sam-color-success-fg)',
  info: 'var(--sam-color-info-fg)',
  warning: 'var(--sam-color-warning-fg)',
  danger: 'var(--sam-color-danger-fg)',
  muted: 'var(--sam-color-fg-muted)',
};

export const tint = (color: string, percent = 14) =>
  `color-mix(in srgb, ${color} ${percent}%, transparent)`;

export function ago(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const time = new Date(iso).getTime();
  return Number.isNaN(time) ? iso : formatTimeFromNow(time);
}

/** "3 hours", "25 minutes", "2 days": how long since a moment, for "hasn't … for X". */
export function since(iso: string | null | undefined): string {
  if (!iso) return 'a while';
  const minutes = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  return `${Math.round(hours / 24)} days`;
}

/** A JSON value as a plain object, or null when it is anything else. */
export function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The objects in a JSON array (the node's per-service states); anything else is dropped. */
export function serviceRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Record<string, unknown> =>
      typeof item === 'object' && item !== null && !Array.isArray(item)
  );
}
