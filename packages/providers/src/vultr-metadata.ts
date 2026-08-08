import type { VMSize } from '@simple-agent-manager/shared';

import type {
  LocationMeta,
  ProviderErrorCategory,
  ProviderLogger,
  SizeConfig,
  VMStatus,
} from './types';
import type { VultrOsPayload } from './validation-vultr';

export const VULTR_API_URL = 'https://api.vultr.com/v2';

export const DEFAULT_VULTR_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_VULTR_IP_POLL_TIMEOUT_MS = 15_000;
export const DEFAULT_VULTR_IP_POLL_INTERVAL_MS = 3_000;
export const VULTR_LIST_PER_PAGE = 100;
export const VULTR_MAX_LIST_PAGES = 50;
const VULTR_UNASSIGNED_IP = '0.0.0.0';

export const VULTR_LOCATIONS = [
  'fra',
  'ams',
  'lhr',
  'ewr',
  'ord',
  'lax',
  'nrt',
  'sgp',
  'syd',
] as const;

export const VULTR_LOCATION_META: Record<string, LocationMeta> = {
  fra: { name: 'Frankfurt', country: 'DE' },
  ams: { name: 'Amsterdam', country: 'NL' },
  lhr: { name: 'London', country: 'GB' },
  ewr: { name: 'New Jersey', country: 'US' },
  ord: { name: 'Chicago', country: 'US' },
  lax: { name: 'Los Angeles', country: 'US' },
  nrt: { name: 'Tokyo', country: 'JP' },
  sgp: { name: 'Singapore', country: 'SG' },
  syd: { name: 'Sydney', country: 'AU' },
};

export const VULTR_SIZE_CONFIGS: Record<VMSize, SizeConfig> = {
  small: {
    type: 'vc2-2c-4gb',
    price: '~$20/mo',
    vcpu: 2,
    ramGb: 4,
    storageGb: 80,
  },
  medium: {
    type: 'vc2-4c-8gb',
    price: '~$40/mo',
    vcpu: 4,
    ramGb: 8,
    storageGb: 160,
  },
  large: {
    type: 'vc2-6c-16gb',
    price: '~$80/mo',
    vcpu: 6,
    ramGb: 16,
    storageGb: 320,
  },
};

export interface VultrProviderRuntimeOptions {
  region?: string;
  osName?: string;
  requestTimeoutMs?: number;
  ipPollTimeoutMs?: number;
  ipPollIntervalMs?: number;
  logger?: ProviderLogger;
}

/** Classify a Vultr API error into SAM's normalized provider categories. */
export function classifyVultrError(
  statusCode: number | undefined,
  message: string
): ProviderErrorCategory {
  if (statusCode === 401 || statusCode === 403) return 'auth_error';
  if (statusCode === 429) return 'rate_limited';
  if (statusCode === 503) return 'transient_capacity';
  if (
    /not available|no capacity|out of stock|sold out|no available|temporarily unavailable/i.test(
      message
    )
  ) {
    return 'transient_capacity';
  }
  if (statusCode === 400 || statusCode === 404 || statusCode === 422) return 'invalid_config';
  return 'unknown';
}

/** Combine Vultr's status fields into a normalized VM status. */
export function mapVultrStatus(
  status: string,
  powerStatus: string,
  serverStatus: string
): VMStatus {
  if (status === 'pending' || status === 'installing') return 'initializing';
  if (status === 'resizing') return 'starting';
  if (status === 'suspended') return 'off';
  if (status === 'active') {
    if (powerStatus === 'stopped') return 'off';
    if (powerStatus === 'running') {
      return serverStatus === 'ok' ? 'running' : 'starting';
    }
    return 'initializing';
  }
  return 'initializing';
}

/** Normalize Vultr's placeholder address to an unallocated address. */
export function normalizeVultrIp(ip: string): string {
  return !ip || ip === VULTR_UNASSIGNED_IP ? '' : ip;
}

/** Sanitize a SAM node name into a valid Vultr hostname. */
export function sanitizeVultrHostname(name: string): string {
  const host = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 63)
    .replace(/^-+|-+$/g, '');
  return host || 'sam-node';
}

/** Workers-safe base64 of a UTF-8 string. */
export function toVultrBase64(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/** Find the OS whose name matches `targetName` (exact first, then token-subset match). */
export function findVultrOs(
  list: VultrOsPayload[],
  targetName: string
): VultrOsPayload | undefined {
  const lower = targetName.toLowerCase();
  const exact = list.find((os) => os.name.toLowerCase() === lower);
  if (exact) return exact;
  const tokens = lower.split(/\s+/).filter((token) => token.length > 1);
  return list.find((os) => {
    const name = os.name.toLowerCase();
    return tokens.every((token) => name.includes(token));
  });
}

export function positiveVultrOption(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
