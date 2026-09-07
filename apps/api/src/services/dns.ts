import * as v from 'valibot';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { readResponseJson } from '../lib/runtime-validation';
import { fetchWithTimeout, getTimeoutMs } from './fetch-timeout';

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

/** Default DNS TTL in seconds (1 minute) */
const DEFAULT_DNS_TTL = 60;

/** Default timeout for Cloudflare API calls (per Constitution Principle XI) */
const DEFAULT_CF_API_TIMEOUT_MS = 30_000;

const cloudflareErrorSchema = v.object({
  errors: v.optional(v.array(v.object({ message: v.string() }))),
});

const dnsRecordIdResponseSchema = v.object({
  result: v.object({ id: v.string() }),
});

const dnsRecordListResponseSchema = v.object({
  result: v.array(v.object({
    id: v.string(),
    name: v.string(),
    type: v.string(),
    content: v.optional(v.string()),
    proxied: v.optional(v.boolean()),
  })),
});

async function readCloudflareError(response: Response, fallback: string): Promise<string> {
  try {
    const error = await readResponseJson(response, cloudflareErrorSchema, 'cloudflare.dns.error');
    return error.errors?.[0]?.message || fallback;
  } catch {
    return fallback;
  }
}

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
    throw new Error(await readCloudflareError(response, `Failed to create DNS record: ${response.status}`));
  }

  const data = await readResponseJson(response, dnsRecordIdResponseSchema, 'cloudflare.dns.create_record');
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
    throw new Error(await readCloudflareError(response, `Failed to delete DNS record: ${response.status}`));
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
    throw new Error(await readCloudflareError(response, `Failed to update DNS record: ${response.status}`));
  }
}

async function findDNSRecordByName(
  recordName: string,
  env: Env,
): Promise<{ id: string; name: string; type: string; content?: string; proxied?: boolean } | null> {
  const timeoutMs = getTimeoutMs(env.CF_API_TIMEOUT_MS, DEFAULT_CF_API_TIMEOUT_MS);
  const searchUrl = `${CLOUDFLARE_API_BASE}/zones/${env.CF_ZONE_ID}/dns_records?type=A&name=${encodeURIComponent(recordName)}`;
  const response = await fetchWithTimeout(searchUrl, {
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
    },
  }, timeoutMs);

  if (!response.ok) {
    throw new Error(await readCloudflareError(response, `Failed to find DNS record: ${response.status}`));
  }

  const data = await readResponseJson(response, dnsRecordListResponseSchema, 'cloudflare.dns.find_record_by_name');
  return data.result[0] ?? null;
}

/**
 * Create or update a grey-cloud A record for an app route hostname.
 *
 * App routes intentionally use HTTP-01 ACME on the deployment node, so these
 * records must not be proxied by Cloudflare.
 */
export async function upsertAppRouteDNSRecord(
  hostname: string,
  ip: string,
  env: Env,
): Promise<string> {
  const existing = await findDNSRecordByName(hostname, env);
  const timeoutMs = getTimeoutMs(env.CF_API_TIMEOUT_MS, DEFAULT_CF_API_TIMEOUT_MS);
  const body = JSON.stringify({
    type: 'A',
    name: hostname,
    content: ip,
    ttl: getDnsTTL(env),
    proxied: false,
  });

  const response = await fetchWithTimeout(
    existing
      ? `${CLOUDFLARE_API_BASE}/zones/${env.CF_ZONE_ID}/dns_records/${existing.id}`
      : `${CLOUDFLARE_API_BASE}/zones/${env.CF_ZONE_ID}/dns_records`,
    {
      method: existing ? 'PUT' : 'POST',
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body,
    },
    timeoutMs,
  );

  if (!response.ok) {
    throw new Error(await readCloudflareError(response, `Failed to upsert app route DNS record: ${response.status}`));
  }

  const data = await readResponseJson(response, dnsRecordIdResponseSchema, 'cloudflare.dns.upsert_app_route_record');
  return data.result.id;
}

/**
 * Delete the app-route A record for a hostname, if one exists.
 *
 * Idempotent: a missing record (or a record already removed by a concurrent
 * caller) is treated as success. Returns true if a record was found and
 * deleted, false if no matching record existed.
 */
export async function deleteAppRouteDNSRecord(
  hostname: string,
  env: Env,
): Promise<boolean> {
  const existing = await findDNSRecordByName(hostname, env);
  if (!existing) {
    return false;
  }
  await deleteDNSRecord(existing.id, env);
  return true;
}

/**
 * Bulk-deprovision app-route A records by hostname.
 *
 * Used when tearing down a deployment environment (or the node hosting it) so
 * the grey-cloud `r{n}-{service}-{port}-{envId}.apps.{domain}` records created
 * by {@link upsertAppRouteDNSRecord} do not accumulate as orphans. Tolerant of
 * already-deleted records and of individual delete failures (logged, skipped)
 * so a single bad record cannot block the rest of the teardown. Returns the
 * number of records actually deleted.
 */
export async function cleanupAppRouteDNSRecords(
  hostnames: string[],
  env: Env,
): Promise<number> {
  let deleted = 0;
  for (const hostname of hostnames) {
    try {
      if (await deleteAppRouteDNSRecord(hostname, env)) {
        deleted++;
        log.info('dns.app_route_record_cleaned_up', { hostname });
      }
    } catch (err) {
      log.error('dns.app_route_delete_failed', { hostname, error: String(err) });
    }
  }
  return deleted;
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

    const data = await readResponseJson(response, dnsRecordListResponseSchema, 'cloudflare.dns.cleanup_records');
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
    throw new Error(await readCloudflareError(response, `Failed to create backend DNS record: ${response.status}`));
  }

  const data = await readResponseJson(response, dnsRecordIdResponseSchema, 'cloudflare.dns.create_backend_record');
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
