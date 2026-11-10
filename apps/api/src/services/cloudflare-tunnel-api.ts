/**
 * Minimal Cloudflare API client for managed-node named tunnels and their CNAME records.
 *
 * Endpoints (developers.cloudflare.com/api, checked 2026-11-10):
 * - GET/POST   /accounts/{account}/cfd_tunnel                       list (name, is_deleted) / create
 * - GET        /accounts/{account}/cfd_tunnel/{id}/token            per-tunnel connector token
 * - PUT        /accounts/{account}/cfd_tunnel/{id}/configurations   remote ingress config
 * - DELETE     /accounts/{account}/cfd_tunnel/{id}/connections      drop every connector
 * - DELETE     /accounts/{account}/cfd_tunnel/{id}                  needs no active connections
 * - GET/POST/DELETE /zones/{zone}/dns_records                       CNAME to {id}.cfargotunnel.com
 *
 * Uses the control plane's CF_API_TOKEN only. The per-tunnel token returned by
 * {@link getTunnelToken} is a secret: it is never logged, persisted, or put in an error.
 * Error messages carry the HTTP status, Cloudflare error codes and a bounded message;
 * no request body that could contain a secret is ever sent.
 */
import * as v from 'valibot';

import type { Env } from '../env';
import { readResponseJson } from '../lib/runtime-validation';
import { CLOUDFLARE_API_BASE, DEFAULT_CF_API_TIMEOUT_MS, getDnsTTL } from './dns-core';
import { fetchWithTimeout, getTimeoutMs } from './fetch-timeout';

/** Attempts for idempotent (GET/PUT/DELETE) calls on transient failure. Never applied to POST. */
export const DEFAULT_CF_TUNNEL_API_IDEMPOTENT_ATTEMPTS = 3;
/** Linear backoff step between idempotent retries. */
export const DEFAULT_CF_TUNNEL_API_RETRY_DELAY_MS = 250;
const ERROR_MESSAGE_MAX_LENGTH = 200;

export type CloudflareTunnelEnv = Pick<
  Env,
  'CF_API_TOKEN' | 'CF_ACCOUNT_ID' | 'CF_ZONE_ID' | 'CF_API_TIMEOUT_MS' | 'DNS_TTL_SECONDS'
>;

export interface CloudflareCallOptions {
  /** Per-request timeout override (background cleanup uses a shorter budget). */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class CloudflareTunnelApiError extends Error {
  override name = 'CloudflareTunnelApiError';
  constructor(
    readonly operation: string,
    /** Undefined when no HTTP response arrived (timeout, network). */
    readonly status: number | undefined,
    readonly codes: number[],
    detail: string
  ) {
    super(
      `Cloudflare ${operation} failed${status === undefined ? '' : `: HTTP ${status}`}` +
        `${codes.length ? ` codes=[${codes.join(',')}]` : ''}${detail ? ` ${detail}` : ''}`
    );
  }

  /** True when retrying the same idempotent request could succeed. */
  get transient(): boolean {
    return this.status === undefined || this.status === 429 || this.status >= 500;
  }

  get notFound(): boolean {
    return this.status === 404;
  }
}

const envelopeSchema = v.object({
  success: v.optional(v.boolean()),
  errors: v.optional(
    v.array(v.object({ code: v.optional(v.unknown()), message: v.optional(v.unknown()) }))
  ),
  result: v.optional(v.unknown()),
});

const tunnelSchema = v.object({
  id: v.string(),
  name: v.string(),
  deleted_at: v.optional(v.nullable(v.string())),
});
export type CloudflareTunnel = v.InferOutput<typeof tunnelSchema>;

const dnsRecordSchema = v.object({
  id: v.string(),
  name: v.string(),
  type: v.string(),
  content: v.optional(v.string()),
  proxied: v.optional(v.boolean()),
});
export type CloudflareDnsRecord = v.InferOutput<typeof dnsRecordSchema>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function boundedMessage(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, ERROR_MESSAGE_MAX_LENGTH) : '';
}

async function readEnvelope(response: Response, operation: string) {
  try {
    return await readResponseJson(response, envelopeSchema, `cloudflare.tunnel.${operation}`);
  } catch {
    return null;
  }
}

/**
 * One Cloudflare API request. Idempotent methods retry transient failures a bounded number
 * of times; POST never retries, because a lost create response is resolved by the caller
 * re-reading the resource by its deterministic name (rule 75).
 */
async function cloudflareRequest(
  env: CloudflareTunnelEnv,
  operation: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body: unknown,
  options: CloudflareCallOptions = {}
): Promise<unknown> {
  const attempts = method === 'POST' ? 1 : DEFAULT_CF_TUNNEL_API_IDEMPOTENT_ATTEMPTS;
  const timeoutMs =
    options.timeoutMs ?? getTimeoutMs(env.CF_API_TIMEOUT_MS, DEFAULT_CF_API_TIMEOUT_MS);
  let lastError: CloudflareTunnelApiError | null = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (options.signal?.aborted) throw options.signal.reason;
    let response: Response;
    try {
      response = await fetchWithTimeout(
        `${CLOUDFLARE_API_BASE}${path}`,
        {
          method,
          headers: {
            Authorization: `Bearer ${env.CF_API_TOKEN}`,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        timeoutMs,
        options.signal
      );
    } catch (err) {
      if (options.signal?.aborted) throw err;
      lastError = new CloudflareTunnelApiError(
        operation,
        undefined,
        [],
        boundedMessage(err instanceof Error ? err.message : String(err))
      );
      if (attempt < attempts) await sleep(DEFAULT_CF_TUNNEL_API_RETRY_DELAY_MS * attempt);
      continue;
    }
    const envelope = await readEnvelope(response, operation);
    // A body read cut short by caller cancellation must surface as that cancellation.
    if (options.signal?.aborted) throw options.signal.reason;
    if (response.ok && envelope && envelope.success !== false) return envelope.result;
    const codes = (envelope?.errors ?? [])
      .map((error) => error.code)
      .filter((code): code is number => typeof code === 'number');
    lastError = new CloudflareTunnelApiError(
      operation,
      response.status,
      codes,
      boundedMessage(envelope?.errors?.[0]?.message)
    );
    if (!lastError.transient || attempt >= attempts) throw lastError;
    await sleep(DEFAULT_CF_TUNNEL_API_RETRY_DELAY_MS * attempt);
  }
  throw lastError ?? new CloudflareTunnelApiError(operation, undefined, [], '');
}

function parse<T>(schema: v.GenericSchema<unknown, T>, value: unknown, operation: string): T {
  const parsed = v.safeParse(schema, value);
  if (!parsed.success) {
    throw new CloudflareTunnelApiError(operation, 200, [], 'unexpected response shape');
  }
  return parsed.output;
}

const accountPath = (env: CloudflareTunnelEnv) => `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel`;

/** Live (not deleted) tunnels whose name is exactly `name`. Provider filtering is re-checked. */
export async function listTunnelsByExactName(
  env: CloudflareTunnelEnv,
  name: string,
  options?: CloudflareCallOptions
): Promise<CloudflareTunnel[]> {
  const result = await cloudflareRequest(
    env,
    'tunnel.list',
    'GET',
    `${accountPath(env)}?name=${encodeURIComponent(name)}&is_deleted=false&per_page=50`,
    undefined,
    options
  );
  return parse(v.array(tunnelSchema), result, 'tunnel.list').filter(
    (tunnel) => tunnel.name === name && !tunnel.deleted_at
  );
}

/** Create a remotely configured named tunnel. Never retried here; see {@link cloudflareRequest}. */
export async function createRemoteTunnel(
  env: CloudflareTunnelEnv,
  name: string,
  options?: CloudflareCallOptions
): Promise<CloudflareTunnel> {
  const result = await cloudflareRequest(
    env,
    'tunnel.create',
    'POST',
    accountPath(env),
    { name, config_src: 'cloudflare' },
    options
  );
  return parse(tunnelSchema, result, 'tunnel.create');
}

/** The connector run token. SECRET: callers must not log or persist it. */
export async function getTunnelToken(
  env: CloudflareTunnelEnv,
  tunnelId: string,
  options?: CloudflareCallOptions
): Promise<string> {
  const result = await cloudflareRequest(
    env,
    'tunnel.token',
    'GET',
    `${accountPath(env)}/${tunnelId}/token`,
    undefined,
    options
  );
  if (typeof result !== 'string' || result.length === 0) {
    throw new CloudflareTunnelApiError('tunnel.token', 200, [], 'empty token');
  }
  return result;
}

export interface TunnelIngressRule {
  hostname?: string;
  service: string;
}

export async function putTunnelIngress(
  env: CloudflareTunnelEnv,
  tunnelId: string,
  ingress: TunnelIngressRule[],
  options?: CloudflareCallOptions
): Promise<void> {
  await cloudflareRequest(
    env,
    'tunnel.configure',
    'PUT',
    `${accountPath(env)}/${tunnelId}/configurations`,
    { config: { ingress } },
    options
  );
}

/** Remove every connector, then the tunnel. A tunnel that is already gone counts as deleted. */
export async function deleteTunnel(
  env: CloudflareTunnelEnv,
  tunnelId: string,
  options?: CloudflareCallOptions
): Promise<void> {
  try {
    await cloudflareRequest(
      env,
      'tunnel.connections_delete',
      'DELETE',
      `${accountPath(env)}/${tunnelId}/connections`,
      undefined,
      options
    );
    await cloudflareRequest(
      env,
      'tunnel.delete',
      'DELETE',
      `${accountPath(env)}/${tunnelId}`,
      undefined,
      options
    );
  } catch (err) {
    if (err instanceof CloudflareTunnelApiError && err.notFound) return;
    throw err;
  }
}

const zonePath = (env: CloudflareTunnelEnv) => `/zones/${env.CF_ZONE_ID}/dns_records`;

/** Every record (any type) whose name is exactly `hostname`. */
export async function listDnsRecordsByName(
  env: CloudflareTunnelEnv,
  hostname: string,
  options?: CloudflareCallOptions
): Promise<CloudflareDnsRecord[]> {
  const result = await cloudflareRequest(
    env,
    'dns.list',
    'GET',
    `${zonePath(env)}?name=${encodeURIComponent(hostname)}&per_page=50`,
    undefined,
    options
  );
  return parse(v.array(dnsRecordSchema), result, 'dns.list').filter(
    (record) => record.name === hostname
  );
}

export async function getDnsRecord(
  env: CloudflareTunnelEnv,
  recordId: string,
  options?: CloudflareCallOptions
): Promise<CloudflareDnsRecord | null> {
  try {
    const result = await cloudflareRequest(
      env,
      'dns.get',
      'GET',
      `${zonePath(env)}/${recordId}`,
      undefined,
      options
    );
    return parse(dnsRecordSchema, result, 'dns.get');
  } catch (err) {
    if (err instanceof CloudflareTunnelApiError && err.notFound) return null;
    throw err;
  }
}

export async function createProxiedTunnelCname(
  env: CloudflareTunnelEnv,
  hostname: string,
  target: string,
  comment: string,
  options?: CloudflareCallOptions
): Promise<CloudflareDnsRecord> {
  const result = await cloudflareRequest(
    env,
    'dns.create',
    'POST',
    zonePath(env),
    { type: 'CNAME', name: hostname, content: target, proxied: true, ttl: getDnsTTL(env), comment },
    options
  );
  return parse(dnsRecordSchema, result, 'dns.create');
}

export async function deleteDnsRecordById(
  env: CloudflareTunnelEnv,
  recordId: string,
  options?: CloudflareCallOptions
): Promise<void> {
  try {
    await cloudflareRequest(
      env,
      'dns.delete',
      'DELETE',
      `${zonePath(env)}/${recordId}`,
      undefined,
      options
    );
  } catch (err) {
    if (err instanceof CloudflareTunnelApiError && err.notFound) return;
    throw err;
  }
}

/** The CNAME target Cloudflare routes to a named tunnel. */
export function tunnelCnameTarget(tunnelId: string): string {
  return `${tunnelId}.cfargotunnel.com`;
}
