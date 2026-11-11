/**
 * The admin setting `outbound.maxRedirects` (admin-settings-outbound-definitions.ts) for callers
 * of the guarded fetch (lib/network-hosts) that do not already read it in a settings batch.
 */
import type { Env } from '../env';
import { log } from '../lib/logger';
import { DEFAULT_OUTBOUND_MAX_REDIRECTS, MAX_OUTBOUND_REDIRECTS } from '../lib/network-hosts';
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
 * The redirect hop limit for a guarded fetch. When settings cannot be read the default applies:
 * every hop is still re-validated, so the default is a bound, not an opening.
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
