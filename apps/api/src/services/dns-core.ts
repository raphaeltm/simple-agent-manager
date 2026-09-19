/**
 * Cloudflare DNS primitives shared by every DNS concern.
 *
 * Split out of `dns.ts` (which is now a barrel) so the app-route, workspace-cleanup
 * and node-backend concerns can each live in their own module. See
 * `.claude/rules/18-file-size-limits.md`.
 */
import { completeAbortableResponse } from '@simple-agent-manager/providers';
import * as v from 'valibot';

import type { Env } from '../env';
import { readResponseJson } from '../lib/runtime-validation';
import { fetchWithTimeout, getTimeoutMs } from './fetch-timeout';

export const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

/** Default DNS TTL in seconds (1 minute) */
const DEFAULT_DNS_TTL = 60;

/** Default timeout for Cloudflare API calls (per Constitution Principle XI) */
export const DEFAULT_CF_API_TIMEOUT_MS = 30_000;

// `code` is deliberately `unknown` rather than `v.optional(v.number())`. Valibot's
// optional() only bypasses a missing/undefined key, so `code: null` or a stringified
// code would fail the whole entry — and readCloudflareErrorDetail swallows parse
// failures and falls back to a generic message. That would silently discard
// Cloudflare's real error text for every caller, including the ones that never asked
// to branch on the code at all. Parse permissively; narrow to a number at use.
const cloudflareErrorSchema = v.object({
  errors: v.optional(
    v.array(
      v.object({
        code: v.optional(v.unknown()),
        message: v.string(),
      })
    )
  ),
});

/**
 * Cloudflare DNS API error codes meaning "this exact record already exists".
 *
 * Raised when a concurrent caller created the record between our lookup and our
 * create. Recoverable: re-resolve and converge on the winner's record.
 *
 * Deliberately EXCLUDES 81053 ("An A, AAAA, or CNAME record with that host
 * already exists"), which reports a different-type collision — a real
 * misconfiguration that retrying cannot fix and must keep surfacing.
 */
export const CF_DNS_DUPLICATE_RECORD_CODES = new Set([81057, 81058]);

/**
 * Attempts for a create that lost a duplicate-record race: the original, plus one
 * re-resolve-and-update.
 *
 * Deliberately NOT env-exposed, unlike every other retry bound in this directory
 * (`DEFAULT_DO_RETRY_MAX_ATTEMPTS`, `HETZNER_CAPACITY_RETRY_MAX_ATTEMPTS`, …),
 * because one retry is provably sufficient rather than tuned: the retry re-resolves
 * and switches from POST (subject to the uniqueness constraint) to PUT-by-id (which
 * cannot raise 81057/81058), so however many callers race, exactly one wins the
 * create and every loser converges on the next attempt. A knob here could only be
 * used to mask a record that genuinely keeps duplicating, which must surface.
 */
export const DNS_UPSERT_RACE_MAX_RETRIES = 1;

/** True when a failed create can be recovered by resolving the winner's record. */
export function isDuplicateRecordConflict(code: number | null): boolean {
  return code !== null && CF_DNS_DUPLICATE_RECORD_CODES.has(code);
}

export const dnsRecordIdResponseSchema = v.object({
  result: v.object({ id: v.string() }),
});

export const dnsRecordListResponseSchema = v.object({
  result: v.array(
    v.object({
      id: v.string(),
      name: v.string(),
      type: v.string(),
      content: v.optional(v.string()),
      proxied: v.optional(v.boolean()),
    })
  ),
});

/**
 * Read the first Cloudflare API error as a `{ code, message }` pair.
 *
 * A Response body can only be consumed once, so callers that need to branch on
 * the numeric code must read both together rather than calling
 * {@link readCloudflareError} and then re-reading the body.
 */
export async function readCloudflareErrorDetail(
  response: Response,
  fallback: string
): Promise<{ code: number | null; message: string }> {
  try {
    const error = await readResponseJson(response, cloudflareErrorSchema, 'cloudflare.dns.error');
    const first = error.errors?.[0];
    // Only a real number is usable for branching; anything else is treated as
    // "no code", which keeps the message intact and excludes it from any retry.
    const code = typeof first?.code === 'number' ? first.code : null;
    return { code, message: first?.message || fallback };
  } catch {
    return { code: null, message: fallback };
  }
}

export async function readCloudflareError(response: Response, fallback: string): Promise<string> {
  return (await readCloudflareErrorDetail(response, fallback)).message;
}

/**
 * Get DNS TTL from env or use default (per constitution principle XI).
 */
export function getDnsTTL(env?: { DNS_TTL_SECONDS?: string }): number {
  if (env?.DNS_TTL_SECONDS) {
    const ttl = Number.parseInt(env.DNS_TTL_SECONDS, 10);
    if (!Number.isNaN(ttl) && ttl > 0) {
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
  constructor(private readonly env: Env) {}

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
export async function createDNSRecord(workspaceId: string, ip: string, env: Env): Promise<string> {
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
    throw new Error(
      await readCloudflareError(response, `Failed to create DNS record: ${response.status}`)
    );
  }

  const data = await readResponseJson(
    response,
    dnsRecordIdResponseSchema,
    'cloudflare.dns.create_record'
  );
  return data.result.id;
}

/**
 * Delete a DNS record by ID.
 */
export async function deleteDNSRecord(
  recordId: string,
  env: Env,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) throw signal.reason;
  const timeoutMs = getTimeoutMs(env.CF_API_TIMEOUT_MS, DEFAULT_CF_API_TIMEOUT_MS);
  const response = await fetchWithTimeout(
    `${CLOUDFLARE_API_BASE}/zones/${env.CF_ZONE_ID}/dns_records/${recordId}`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
      },
    },
    timeoutMs,
    signal
  );

  // The background caller's deadline must also cover a stalled error body after
  // fetchWithTimeout has received headers and cleared its own request timer.
  const readableResponse = signal ? await completeAbortableResponse(response, signal) : response;
  // Ignore 404 errors (record already deleted)
  if (!readableResponse.ok && readableResponse.status !== 404) {
    throw new Error(
      await readCloudflareError(
        readableResponse,
        `Failed to delete DNS record: ${readableResponse.status}`
      )
    );
  }
}

/**
 * Update a DNS record with a new IP address.
 */
export async function updateDNSRecord(recordId: string, ip: string, env: Env): Promise<void> {
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
    throw new Error(
      await readCloudflareError(response, `Failed to update DNS record: ${response.status}`)
    );
  }
}

export interface DNSRecordMatch {
  id: string;
  name: string;
  type: string;
  content?: string;
  proxied?: boolean;
}

/**
 * List every A record matching a name.
 *
 * Cloudflare permits several A records per name (round-robin), so "how many
 * matched" is real information. Callers that must not fail on ambiguity — an
 * upsert that gates a deployment — can still record it instead of silently
 * converging one of several. See `apps/api/.claude/rules/75` §8.
 */
export async function findDNSRecordMatchesByName(
  recordName: string,
  env: Env,
  signal?: AbortSignal
): Promise<DNSRecordMatch[]> {
  const timeoutMs = getTimeoutMs(env.CF_API_TIMEOUT_MS, DEFAULT_CF_API_TIMEOUT_MS);
  const searchUrl = `${CLOUDFLARE_API_BASE}/zones/${env.CF_ZONE_ID}/dns_records?type=A&name=${encodeURIComponent(recordName)}`;
  const response = await fetchWithTimeout(
    searchUrl,
    {
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
      },
    },
    timeoutMs,
    signal
  );
  const readable = signal ? await completeAbortableResponse(response, signal) : response;

  if (!readable.ok) {
    throw new Error(
      await readCloudflareError(readable, `Failed to find DNS record: ${response.status}`)
    );
  }

  const data = await readResponseJson(
    readable,
    dnsRecordListResponseSchema,
    'cloudflare.dns.find_record_by_name'
  );
  return data.result;
}

export async function findDNSRecordByName(
  recordName: string,
  env: Env,
  signal?: AbortSignal,
  requireUnique = false
): Promise<DNSRecordMatch | null> {
  const matches = await findDNSRecordMatchesByName(recordName, env, signal);
  if (requireUnique && matches.length > 1)
    throw new Error('Multiple DNS records match the node backend hostname');
  return matches[0] ?? null;
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
