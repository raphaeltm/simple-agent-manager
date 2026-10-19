import { SESSION_ACCESS_DURATION_MINUTES } from '@simple-agent-manager/shared';
import { useEffect, useState } from 'react';

import { serverNow, toDeviceTime } from '../../lib/server-clock';

/**
 * Shared-session access lasts a chosen 5, 10, 30 or 60 minutes. These helpers only display that:
 * the server checks its own clock on every request.
 */

/** How often a visible countdown re-renders. */
export const ACCESS_COUNTDOWN_TICK_MS = 15_000;
/** How far past an end time the exact re-render lands, so the clock has surely passed it. */
const WAKE_SLACK_MS = 50;

export function durationLabel(minutes: number): string {
  return minutes === 60 ? '1 hour' : `${minutes} min`;
}

export const ACCESS_DURATION_OPTIONS = SESSION_ACCESS_DURATION_MINUTES.map((minutes) => ({
  minutes,
  label: durationLabel(minutes),
}));

/** "3:42 PM", in this device's time zone, for a server timestamp. */
export function accessClockTime(serverMs: number): string {
  return new Date(toDeviceTime(serverMs)).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** "23 min" / "under a minute" until `expiresAt`; null once it has passed (or is unknown). */
export function accessTimeLeft(expiresAt: number, now: number): string | null {
  const remaining = expiresAt - now;
  // `!(x > 0)` also catches NaN: a grant without an end time is expired to the server too.
  if (!(remaining > 0)) return null;
  if (remaining < 60_000) return 'under a minute';
  return `${Math.ceil(remaining / 60_000)} min`;
}

/**
 * The server's clock, read on every render; while `active` it also re-renders each tick, and once
 * more just after `wakeAt` (an end time), so whatever depends on it changes at that moment rather
 * than up to a tick later. Reading at render (rather than storing the last tick) keeps a
 * just-arrived grant from showing more time than it was given.
 */
export function useServerNow(active: boolean, wakeAt: number | null = null): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setTick((tick) => tick + 1), ACCESS_COUNTDOWN_TICK_MS);
    return () => window.clearInterval(id);
  }, [active]);
  useEffect(() => {
    if (!active || wakeAt === null || !Number.isFinite(wakeAt)) return;
    const delay = wakeAt - serverNow();
    if (delay <= 0) return;
    const id = window.setTimeout(() => setTick((tick) => tick + 1), delay + WAKE_SLACK_MS);
    return () => window.clearTimeout(id);
  }, [active, wakeAt]);
  return serverNow();
}
