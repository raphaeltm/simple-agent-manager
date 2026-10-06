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
  SAM_VOLUME_FILESYSTEM_FORMAT,
  SAM_VOLUME_FSTAB_OPTIONS,
  SAM_VOLUME_MOUNT_PATH_TEMPLATE,
} from './types';
import type { GcpNetworkInterfacePayload } from './validation';

export const COMPUTE_API_BASE = 'https://compute.googleapis.com/compute/v1';
// 100 pages × 500 items/page ≈ 50,000 resources — well above any realistic fleet
export const DEFAULT_GCP_MAX_LIST_PAGES = 100;

/**
 * Classify a GCP API error into a normalized ProviderErrorCategory.
 *
 * GCP error responses use `{ error: { code, status, errors: [...] } }` where
 * `status` is the structured signal (e.g., "RESOURCE_EXHAUSTED", "UNAVAILABLE").
 * The `providerCode` in ProviderError corresponds to the `error.status` field.
 *
 * GCP error statuses (from API docs):
 * - RESOURCE_EXHAUSTED → quota_exceeded (429)
 * - UNAVAILABLE → transient_capacity (503)
 * - ZONE_RESOURCE_POOL_EXHAUSTED → transient_capacity
 * - ZONE_RESOURCE_POOL_EXHAUSTED_WITH_DETAILS → transient_capacity
 * - QUOTA_EXCEEDED → quota_exceeded
 * - PERMISSION_DENIED → auth_error
 * - UNAUTHENTICATED → auth_error
 * - INVALID_ARGUMENT → invalid_config
 * - NOT_FOUND → invalid_config
 * - ALREADY_EXISTS → invalid_config
 * - RATE_LIMIT_EXCEEDED → rate_limited
 */
export function classifyGcpError(
  statusCode: number | undefined,
  providerCode: string | undefined,
  message: string
): ProviderErrorCategory {
  if (providerCode) {
    switch (providerCode) {
      case 'UNAVAILABLE':
      case 'ZONE_RESOURCE_POOL_EXHAUSTED':
      case 'ZONE_RESOURCE_POOL_EXHAUSTED_WITH_DETAILS':
        return 'transient_capacity';
      case 'RESOURCE_EXHAUSTED':
      case 'QUOTA_EXCEEDED':
        return 'quota_exceeded';
      case 'PERMISSION_DENIED':
      case 'UNAUTHENTICATED':
        return 'auth_error';
      case 'INVALID_ARGUMENT':
      case 'NOT_FOUND':
      case 'ALREADY_EXISTS':
        return 'invalid_config';
      case 'RATE_LIMIT_EXCEEDED':
        return 'rate_limited';
    }
  }

  if (statusCode === 401 || statusCode === 403) return 'auth_error';
  if (statusCode === 429) return 'rate_limited';
  if (statusCode === 503) return 'transient_capacity';

  // Message-based fallback (order matters: check zone-specific before general)
  if (/zone.*resource.*pool.*exhausted/i.test(message)) return 'transient_capacity';
  if (/resource.*exhausted|quota/i.test(message)) return 'quota_exceeded';

  return 'unknown';
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
