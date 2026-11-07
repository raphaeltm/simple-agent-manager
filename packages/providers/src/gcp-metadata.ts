import type { VMSize } from '@simple-agent-manager/shared';

import { CLOUDFLARE_IPV4_RANGES } from './cloudflare-ranges';
import type {
  LocationMeta,
  ProviderErrorCategory,
  ProviderRequestContext,
  SizeConfig,
  VMInstance,
  VolumeCapabilities,
} from './types';
import {
  ProviderError,
  SAM_VOLUME_FILESYSTEM_FORMAT,
  SAM_VOLUME_FSTAB_OPTIONS,
  SAM_VOLUME_MOUNT_PATH_TEMPLATE,
} from './types';
import type { GcpNetworkInterfacePayload } from './validation';

export const COMPUTE_API_BASE = 'https://compute.googleapis.com/compute/v1';
// 100 pages × 500 items/page ≈ 50,000 resources — well above any realistic fleet
export const DEFAULT_GCP_MAX_LIST_PAGES = 100;

/** GCP codes that say the zone cannot supply this machine type right now. */
const GCP_STOCKOUT_CODES = new Set([
  'ZONE_RESOURCE_POOL_EXHAUSTED',
  'ZONE_RESOURCE_POOL_EXHAUSTED_WITH_DETAILS',
]);
/**
 * GCP's stockout wording when no structured code survives (`providerFetch` keeps only
 * `error.status`): "The zone '…' does not have enough resources available to fulfill the
 * request. Try a different zone, or try again later."
 */
const GCP_STOCKOUT_MESSAGE =
  /zone.*resource.*pool.*exhausted|does not have enough resources available to fulfill the request/i;
const GCP_QUOTA_CODES = new Set(['QUOTA_EXCEEDED', 'RESOURCE_EXHAUSTED']);
/** "Quota 'CPUS' exceeded.  Limit: 8.0 in region us-central1." */
const GCP_QUOTA_MESSAGE = /\bquota\b[^.]*\bexceeded\b|resource.*exhausted/i;
const GCP_RATE_LIMIT_CODES = new Set(['RATE_LIMIT_EXCEEDED']);
const GCP_RATE_LIMIT_MESSAGE = /rate limit exceeded/i;
const GCP_AUTH_CODES = new Set(['PERMISSION_DENIED', 'UNAUTHENTICATED']);
const GCP_INVALID_CONFIG_CODES = new Set(['INVALID_ARGUMENT', 'NOT_FOUND', 'ALREADY_EXISTS']);

/**
 * Classify a GCP API error by what the caller must do about it (rule 72).
 *
 * `providerCode` is `error.status` for an HTTP error (`providerFetch` keeps it because GCP's
 * `error.code` is numeric) or `error.errors[].code` for an operation error. Arms are ordered so
 * the most specific evidence wins; in particular GCP reports quota and rate limits as HTTP 403,
 * so those are checked before 403 is read as a credential problem.
 *
 * - `transient_capacity`: the zone has no capacity for this machine type. The request was valid
 *   and GCP created nothing, so the caller may try another permitted offering (zone or type).
 * - `quota_exceeded`: the project's quota (for example regional CPUs) is used up. The caller
 *   stops; other GCP offerings in the region draw on the same quota.
 * - `rate_limited`: the API throttled the call. The caller stops this attempt.
 * - `auth_error`: the credential was refused. The caller fails fast; retrying cannot help.
 * - `invalid_config`: the request itself is wrong (bad argument, missing resource, name
 *   collision). The caller fails fast.
 * - `unknown`: anything else, INCLUDING a bare `UNAVAILABLE` / HTTP 503 with no stockout
 *   evidence. That status means GCP's front end failed, not that the zone is out of stock, and
 *   on the create POST it does not prove that no instance was created. `transient_capacity`
 *   would make the TaskRunner delete the node row and create a second VM elsewhere (TLA+ path
 *   P2 in idea 01M6NXTF2RQ5QXHM7YZ4ZF0XBK), so an ambiguous outcome must fail closed.
 */
export function classifyGcpError(
  statusCode: number | undefined,
  providerCode: string | undefined,
  message: string
): ProviderErrorCategory {
  const code = providerCode ?? '';
  if (GCP_STOCKOUT_CODES.has(code) || GCP_STOCKOUT_MESSAGE.test(message)) {
    return 'transient_capacity';
  }
  if (GCP_QUOTA_CODES.has(code) || GCP_QUOTA_MESSAGE.test(message)) return 'quota_exceeded';
  if (GCP_RATE_LIMIT_CODES.has(code) || GCP_RATE_LIMIT_MESSAGE.test(message)) {
    return 'rate_limited';
  }
  if (GCP_AUTH_CODES.has(code) || statusCode === 401 || statusCode === 403) return 'auth_error';
  if (GCP_INVALID_CONFIG_CODES.has(code)) return 'invalid_config';
  if (statusCode === 429) return 'rate_limited';
  return 'unknown';
}

/**
 * Re-raise a GCP `ProviderError` with its category assigned. `providerFetch` builds HTTP errors
 * with `{ providerCode }` only, so without this every GCP failure reaches the TaskRunner as
 * `unknown` and fails the task on its first attempt. Non-provider errors (including abort
 * reasons) pass through untouched.
 */
export function withGcpErrorCategory(err: unknown): unknown {
  if (!(err instanceof ProviderError) || err.providerName !== 'gcp') return err;
  if (err.category !== 'unknown') return err;
  const category = classifyGcpError(err.statusCode, err.providerCode, err.message);
  if (category === 'unknown') return err;
  return new ProviderError('gcp', err.statusCode, err.message, {
    cause: err,
    context: err.context,
    providerCode: err.providerCode,
    category,
  });
}

/**
 * The error for a GCP operation that finished with `error.errors`. The decisive code is the first
 * one that classifies (so a stockout listed after an informational code still wins); the message
 * keeps every code and message for operators.
 */
export function gcpOperationError(errors: ReadonlyArray<{ code: string; message: string }>) {
  const message = `GCP operation failed: ${errors.map((e) => `${e.code}: ${e.message}`).join('; ')}`;
  let decisive = errors[0];
  let category: ProviderErrorCategory = 'unknown';
  for (const entry of errors) {
    const entryCategory = classifyGcpError(undefined, entry.code, entry.message);
    if (entryCategory !== 'unknown') {
      decisive = entry;
      category = entryCategory;
      break;
    }
  }
  return new ProviderError('gcp', undefined, message, {
    providerCode: decisive?.code,
    category,
  });
}

/** Firewall rule names and config for SAM inbound access. */
export const SAM_AGENT_FIREWALL_RULE_NAME = 'sam-allow-agent';
export const SAM_APP_ROUTE_FIREWALL_RULE_NAME = 'sam-allow-app-routes';
export const SAM_NETWORK_TAG = 'sam-agent';
export const SAM_DEPLOYMENT_APP_ROUTE_NETWORK_TAG = 'sam-deployment-app-routes';
/** Default ports the VM agent may listen on (8443 with TLS, 8080 without). */
export const DEFAULT_GCP_AGENT_PORTS = ['8080', '8443'] as const;
/** Default public ports served directly by deployment-node Caddy app routes. */
export const DEFAULT_GCP_APP_ROUTE_PORTS = ['80', '443'] as const;
/**
 * Default GCP project firewall source ranges. These mirror Cloudflare's IPv4
 * edge ranges so the VPC firewall and VM cloud-init firewall both restrict
 * agent ingress to Cloudflare-routed traffic by default.
 */
export const DEFAULT_GCP_FIREWALL_SOURCE_RANGES = CLOUDFLARE_IPV4_RANGES;
/** Default source ranges for grey-cloud app routes and HTTP-01 ACME. */
export const DEFAULT_GCP_APP_ROUTE_SOURCE_RANGES = ['0.0.0.0/0'] as const;

/** GCP machine type mappings for SAM VM sizes */
export const SIZE_MAP: Record<VMSize, SizeConfig> = {
  small: { type: 'e2-medium', price: '~$25/mo', vcpu: 1, ramGb: 4, storageGb: 50 },
  medium: { type: 'e2-standard-2', price: '~$49/mo', vcpu: 2, ramGb: 8, storageGb: 50 },
  large: { type: 'e2-standard-4', price: '~$97/mo', vcpu: 4, ramGb: 16, storageGb: 50 },
};

/** Available GCP zones */
export const GCP_LOCATIONS = [
  'us-central1-a',
  'us-east1-b',
  'us-west1-a',
  'europe-west1-b',
  'europe-west3-a',
  'europe-west2-a',
  'asia-southeast1-a',
  'asia-northeast1-a',
] as const;

export const LOCATION_METADATA: Record<string, LocationMeta> = {
  'us-central1-a': { name: 'Iowa', country: 'US' },
  'us-east1-b': { name: 'South Carolina', country: 'US' },
  'us-west1-a': { name: 'Oregon', country: 'US' },
  'europe-west1-b': { name: 'Belgium', country: 'BE' },
  'europe-west3-a': { name: 'Frankfurt', country: 'DE' },
  'europe-west2-a': { name: 'London', country: 'GB' },
  'asia-southeast1-a': { name: 'Singapore', country: 'SG' },
  'asia-northeast1-a': { name: 'Tokyo', country: 'JP' },
};

export const GCP_VOLUME_CAPABILITIES: VolumeCapabilities = {
  supported: false,
  growOnlyResize: true,
  requiresSameLocation: true,
  defaultFormat: SAM_VOLUME_FILESYSTEM_FORMAT,
  lifecycle: {
    filesystem: SAM_VOLUME_FILESYSTEM_FORMAT,
    mountPathTemplate: SAM_VOLUME_MOUNT_PATH_TEMPLATE,
    fstabOptions: SAM_VOLUME_FSTAB_OPTIONS,
  },
  notes: [
    'GCP first-class persistent disk operations are not implemented in this provider package yet.',
  ],
};

/** Map GCP instance status to SAM VMStatus */
export function mapGcpStatus(status: string): VMInstance['status'] {
  switch (status) {
    case 'PROVISIONING':
    case 'STAGING':
      return 'initializing';
    case 'RUNNING':
      return 'running';
    case 'STOPPING':
      return 'stopping';
    case 'STOPPED':
    case 'TERMINATED':
    case 'SUSPENDING':
    case 'SUSPENDED':
      return 'off';
    default:
      return 'initializing';
  }
}

/** Extract IP from GCP network interfaces */
export function extractIp(networkInterfaces?: GcpNetworkInterfacePayload[]): string {
  if (!networkInterfaces?.length) return '';
  const accessConfigs = networkInterfaces[0]?.accessConfigs;
  if (!accessConfigs?.length) return '';
  return accessConfigs[0]?.natIP || '';
}

/**
 * Function type for providing GCP access tokens.
 * The GCP provider doesn't handle token exchange directly —
 * callers provide a function that returns a valid access token.
 */
export type GcpTokenProvider = (context?: ProviderRequestContext) => Promise<string>;
