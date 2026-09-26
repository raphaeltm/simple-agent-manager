import { classifyHetznerError, HETZNER_LEGACY_SERVER_LIMIT_ERROR_CODE } from './hetzner-metadata';
import type { ProviderError } from './types';

/**
 * What a Hetzner account quota counts. Hetzner reports every per-account limit with the same
 * `403 resource_limit_exceeded`, but the recovery action depends on the resource
 * (`.claude/rules/72`):
 *
 *   servers  Every new server consumes one, so no other offering can escape it. Wait until
 *            capacity is freed.
 *   cores    vCPU cores. An offering that needs fewer cores of the same class may still fit, so
 *            descend to one before waiting. Observed in production on 2026-09-25 as "shared core
 *            limit exceeded": the wake tried cx53 (16 cores) and never tried cx43/cx33/cx23 while
 *            about 28 shared cores were in use.
 *   other    Any other per-account resource a create consumes (e.g. primary IPs). Every server
 *            needs one, so it is handled like `servers`.
 */
export type HetznerAccountLimitResource = 'servers' | 'cores' | 'other';

/** Hetzner meters shared and dedicated vCPU cores against separate account limits. */
export type HetznerCoreClass = 'shared' | 'dedicated';

export interface HetznerAccountLimit {
  resource: HetznerAccountLimitResource;
  /** For `cores`: which core pool is exhausted, or null when the message does not say. */
  coreClass: HetznerCoreClass | null;
}

/**
 * Which account quota rejected a Hetzner create, or null when the error is not an account quota.
 *
 * Reads the message because it is the only signal naming the resource: Hetzner's
 * `details.limits[].name` is not kept by `providerFetch`, and production has recorded exactly two
 * texts — "server limit reached" and "shared core limit exceeded". A genuine permission 403
 * (`forbidden`) is `auth_error` in `classifyHetznerError`, so it returns null here and still fails
 * fast.
 */
export function classifyHetznerAccountLimit(err: ProviderError): HetznerAccountLimit | null {
  if (err.providerName !== 'hetzner') return null;
  const category =
    err.category !== 'unknown'
      ? err.category
      : classifyHetznerError(err.statusCode, err.providerCode, err.message);
  if (category !== 'quota_exceeded') return null;

  if (/\bcores?\b/i.test(err.message)) {
    return { resource: 'cores', coreClass: coreClassFromMessage(err.message) };
  }
  if (
    err.providerCode === HETZNER_LEGACY_SERVER_LIMIT_ERROR_CODE ||
    /\bservers?\b/i.test(err.message)
  ) {
    return { resource: 'servers', coreClass: null };
  }
  return { resource: 'other', coreClass: null };
}

/**
 * The vCPU core class a Hetzner server type draws on. Hetzner names dedicated-vCPU plans CCX;
 * CX, CPX and CAX plans run on shared vCPUs. SAM's own `machine_class` cannot answer this — the
 * catalog records every Hetzner type, CCX included, as `shared-vm`.
 */
export function hetznerServerTypeCoreClass(serverType: string): HetznerCoreClass {
  return /^ccx/i.test(serverType.trim()) ? 'dedicated' : 'shared';
}

/**
 * Whether a core quota also rules out `serverType`. A shared-core limit says nothing about
 * dedicated cores, and the reverse also holds. A limit whose message names no class is taken to
 * cover every server type.
 */
export function hetznerCoreLimitCovers(limit: HetznerAccountLimit, serverType: string): boolean {
  if (limit.resource !== 'cores') return false;
  return limit.coreClass === null || hetznerServerTypeCoreClass(serverType) === limit.coreClass;
}

function coreClassFromMessage(message: string): HetznerCoreClass | null {
  if (/\bdedicated\b/i.test(message)) return 'dedicated';
  if (/\bshared\b/i.test(message)) return 'shared';
  return null;
}
