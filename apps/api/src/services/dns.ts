import type { Env } from '../env';
import { log } from '../lib/logger';
import { fetchWithTimeout, getTimeoutMs } from './fetch-timeout';

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

/** Default DNS TTL in seconds (1 minute) */
const DEFAULT_DNS_TTL = 60;

/** Default timeout for Cloudflare API calls (per Constitution Principle XI) */
const DEFAULT_CF_API_TIMEOUT_MS = 30_000;

/**
 * Get DNS TTL from env or use default (per constitution principle XI).
 */
export function getDnsTTL(env?: { DNS_TTL_SECONDS?: string }): number {
  if (env?.DNS_TTL_SECONDS) {
    const ttl = parseInt(env.DNS_TTL_SECONDS, 10);
    if (!isNaN(ttl) && ttl > 0) {
      return ttl;
    }
  }
  return DEFAULT_DNS_TTL;
}

/**
 * DNS Record interface
 */
export interface DNSRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  proxied: boolean;
  ttl: number;
}

/**
 * DNS Service interface for dependency injection
 */
export interface DNSServiceInterface {
  createRecord(workspaceId: string, ip: string, baseDomain: string): Promise<DNSRecord>;
  deleteRecord(workspaceId: string, baseDomain: string): Promise<boolean>;
  findRecord(workspaceId: string, baseDomain: string): Promise<DNSRecord | null>;
  recordExists(workspaceId: string, baseDomain: string): Promise<boolean>;
}

/**
 * Cloudflare DNS Service implementation
 */
export class DNSService implements DNSServiceInterface {
  constructor(private env: Env) {}

  async createRecord(workspaceId: string, ip: string, _baseDomain: string): Promise<DNSRecord> {
    const id = await createDNSRecord(workspaceId, ip, this.env);
    const ttl = getDnsTTL(this.env);
    return {
      id,
      name: `ws-${workspaceId}`,
      type: 'A',
      content: ip,
      proxied: true,
      ttl,
    };
  }

  async deleteRecord(_workspaceId: string, _baseDomain: string): Promise<boolean> {
    return true;
  }

  async findRecord(_workspaceId: string, _baseDomain: string): Promise<DNSRecord | null> {
    return null;
  }

  async recordExists(workspaceId: string, baseDomain: string): Promise<boolean> {
    const record = await this.findRecord(workspaceId, baseDomain);
    return record !== null;
  }
}

/**
 * Create a DNS A record for a workspace.
 * Uses Cloudflare proxy for automatic HTTPS.
 */
export async function createDNSRecord(
  workspaceId: string,
  ip: string,
  env: Env
): Promise<string> {
  const timeoutMs = getTimeoutMs(env.CF_API_TIMEOUT_MS, DEFAULT_CF_API_TIMEOUT_MS);
  const response = await fetchWithTimeout(
    `${CLOUDFLARE_API_BASE}/zones/${env.CF_ZONE_ID}/dns_records`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'A',
        name: `ws-${workspaceId}`,
        content: ip,
        ttl: getDnsTTL(env), // Configurable TTL (default 1 minute for fast updates)
        proxied: true, // Enable Cloudflare proxy for HTTPS
      }),
    },
    timeoutMs
  );

  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { errors?: Array<{ message: string }> };
    const message = error.errors?.[0]?.message || `Failed to create DNS record: ${response.status}`;
    throw new Error(message);
  }

  const data = await response.json() as { result: { id: string } };
  return data.result.id;
}

/**
 * Delete a DNS record by ID.
 */
export async function deleteDNSRecord(
  recordId: string,
  env: Env
): Promise<void> {
  const timeoutMs = getTimeoutMs(env.CF_API_TIMEOUT_MS, DEFAULT_CF_API_TIMEOUT_MS);
  const response = await fetchWithTimeout(
    `${CLOUDFLARE_API_BASE}/zones/${env.CF_ZONE_ID}/dns_records/${recordId}`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
      },
    },
    timeoutMs
  );

  // Ignore 404 errors (record already deleted)
  if (!response.ok && response.status !== 404) {
    const error = await response.json().catch(() => ({})) as { errors?: Array<{ message: string }> };
    const message = error.errors?.[0]?.message || `Failed to delete DNS record: ${response.status}`;
    throw new Error(message);
  }
}

/**
 * Update a DNS record with a new IP address.
 */
export async function updateDNSRecord(
  recordId: string,
  ip: string,
  env: Env
): Promise<void> {
  const timeoutMs = getTimeoutMs(env.CF_API_TIMEOUT_MS, DEFAULT_CF_API_TIMEOUT_MS);
  const response = await fetchWithTimeout(
    `${CLOUDFLARE_API_BASE}/zones/${env.CF_ZONE_ID}/dns_records/${recordId}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: ip,
      }),
    },
    timeoutMs
  );

  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { errors?: Array<{ message: string }> };
    const message = error.errors?.[0]?.message || `Failed to update DNS record: ${response.status}`;
    throw new Error(message);
  }
}

/**
 * Find and delete any DNS records matching a workspace/node by name.
 * This handles the case where we lost the record ID but a stale A record still exists.
 * Cleans up:
 *   - ws-{id}.{domain} (workspace proxied records)
 *   - vm-{id}.{domain} (legacy backend records, pre two-level subdomain migration)
 *   - {id}.vm.{domain} (current backend records, two-level subdomain format)
 */
export async function cleanupWorkspaceDNSRecords(
  workspaceId: string,
  env: Env
): Promise<number> {
  const baseDomain = env.BASE_DOMAIN;
  const id = workspaceId.toLowerCase();

  // Search for all possible DNS record name formats
  const recordNames = [
    `ws-${id}.${baseDomain}`,       // workspace proxied
    `vm-${id}.${baseDomain}`,       // legacy backend (pre migration)
    `${id}.vm.${baseDomain}`,       // current backend (two-level subdomain)
  ];
  let deleted = 0;

  for (const recordName of recordNames) {
    const searchUrl = `${CLOUDFLARE_API_BASE}/zones/${env.CF_ZONE_ID}/dns_records?name=${encodeURIComponent(recordName)}`;
    const cfTimeoutMs = getTimeoutMs(env.CF_API_TIMEOUT_MS, DEFAULT_CF_API_TIMEOUT_MS);
    const response = await fetchWithTimeout(searchUrl, {
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
      },
    }, cfTimeoutMs);

    if (!response.ok) {
      log.error('dns.search_records_failed', { recordName, status: response.status });
      continue;
    }

    const data = await response.json() as { result: Array<{ id: string; name: string; type: string }> };
    const records = data.result || [];

    for (const record of records) {
      try {
        await deleteDNSRecord(record.id, env);
        deleted++;
        log.info('dns.record_cleaned_up', { name: record.name, type: record.type, id: record.id });
      } catch (err) {
        log.error('dns.delete_record_failed', { recordId: record.id, error: String(err) });
      }
    }
  }

  return deleted;
}

/**
 * Create a proxied (orange-clouded) A record for a workspace VM backend.
 * Cloudflare's edge terminates TLS using the domain's SSL/TLS settings and
 * re-encrypts to the origin using the Origin CA certificate served by the VM agent.
 *
 * Uses `{id}.vm.{BASE_DOMAIN}` (two-level subdomain) to bypass Cloudflare
 * same-zone routing. The wildcard Worker route *.{domain}/* only matches
 * single-level subdomains, so {id}.vm.{domain} is NOT intercepted.
 */
export async function createBackendDNSRecord(
  workspaceId: string,
  ip: string,
  env: Env
): Promise<string> {
  return createNodeBackendDNSRecord(workspaceId, ip, env);
}

/**
 * Create a proxied (orange-clouded) A record for a node VM backend.
 * Cloudflare's edge handles TLS termination; the VM agent serves HTTPS
 * with an Origin CA certificate that CF trusts.
 *
 * Uses {nodeId}.vm.{BASE_DOMAIN} (two-level subdomain) to bypass Cloudflare
 * same-zone routing. The wildcard Worker route *.{domain}/* only matches
 * single-level subdomains, so {nodeId}.vm.{domain} is NOT intercepted.
 * This allows Worker subrequests (from DO alarms) to reach the VM directly.
 */
export async function createNodeBackendDNSRecord(
  nodeId: string,
  ip: string,
  env: Env
): Promise<string> {
  const timeoutMs = getTimeoutMs(env.CF_API_TIMEOUT_MS, DEFAULT_CF_API_TIMEOUT_MS);
  const response = await fetchWithTimeout(
    `${CLOUDFLARE_API_BASE}/zones/${env.CF_ZONE_ID}/dns_records`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'A',
        name: `${nodeId.toLowerCase()}.vm`,
        content: ip,
        ttl: getDnsTTL(env),
        proxied: true, // Orange-clouded — CF edge terminates TLS, re-encrypts to Origin CA
      }),
    },
    timeoutMs
  );

  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { errors?: Array<{ message: string }> };
    const message = error.errors?.[0]?.message || `Failed to create backend DNS record: ${response.status}`;
    throw new Error(message);
  }

  const data = await response.json() as { result: { id: string } };
  return data.result.id;
}

/**
 * Get the backend hostname for a workspace VM.
 * Used by the Worker proxy to route subrequests via DNS instead of raw IP.
 */
export function getBackendHostname(workspaceId: string, baseDomain: string): string {
  return getNodeBackendHostname(workspaceId, baseDomain);
}

/**
 * Get the backend hostname for a node VM.
 * Uses {nodeId}.vm.{BASE_DOMAIN} (two-level subdomain to bypass same-zone routing).
 */
export function getNodeBackendHostname(nodeId: string, baseDomain: string): string {
  return `${nodeId.toLowerCase()}.vm.${baseDomain}`;
}

/**
 * Get the workspace URL from a workspace ID.
 */
export function getWorkspaceUrl(workspaceId: string, baseDomain: string): string {
  return `https://ws-${workspaceId}.${baseDomain}`;
}
