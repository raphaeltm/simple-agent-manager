/**
 * The admin setting `outbound.maxRedirects` (admin-settings-outbound-definitions.ts) for callers
 * of `guardedFetch` that do not already read it in a settings batch.
 */
import {
  DEFAULT_OUTBOUND_MAX_REDIRECTS,
  MAX_OUTBOUND_REDIRECTS,
} from '@simple-agent-manager/worker-core';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { resolveAdminSettingDetailsMany } from './admin-settings-resolution';

/** A resolved `outbound.maxRedirects` value, or the default when it is absent or out of range. */
export function outboundMaxRedirectsValue(value: unknown): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_OUTBOUND_REDIRECTS
    ? value
    : DEFAULT_OUTBOUND_MAX_REDIRECTS;
}

/**
 * The redirect hop limit for a guarded fetch. Settings are read through the per-isolate admin
 * settings cache, so this costs no I/O on a warm isolate. When settings cannot be read the
 * default applies: every hop is still re-validated by `guardedFetch`, so the default is a bound,
 * not an opening (the guard itself never falls back to an unguarded fetch).
 */
export async function resolveOutboundMaxRedirects(env: Env): Promise<number> {
  try {
    const [setting] = await resolveAdminSettingDetailsMany(env, ['outbound.maxRedirects']);
    return outboundMaxRedirectsValue(setting?.value);
  } catch (err) {
    log.warn('outbound.max_redirects_setting_unreadable', {
      error: err instanceof Error ? err.message : String(err),
      fallback: DEFAULT_OUTBOUND_MAX_REDIRECTS,
    });
    return DEFAULT_OUTBOUND_MAX_REDIRECTS;
  }
}
