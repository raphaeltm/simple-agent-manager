/**
 * The Cloudflare Email Routing and Email Sending calls the agent email admin setup makes, with
 * the Worker's own `CF_API_TOKEN` (the same token the deploy uses). Responses are validated at
 * this boundary; errors keep Cloudflare's numeric code.
 */
import * as v from 'valibot';

import type { Env } from '../../env';
import { readResponseJson } from '../../lib/runtime-validation';
import {
  CLOUDFLARE_API_BASE,
  DEFAULT_CF_API_TIMEOUT_MS,
  readCloudflareErrorDetail,
} from '../dns-core';
import { fetchWithTimeout, getTimeoutMs } from '../fetch-timeout';

export class CloudflareEmailApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | null,
    message: string
  ) {
    super(message);
    this.name = 'CloudflareEmailApiError';
  }
}

const dnsRecordsSchema = v.array(
  v.object({
    type: v.string(),
    name: v.string(),
    content: v.string(),
    priority: v.optional(v.number()),
  })
);
const routingSettingsSchema = v.object({
  enabled: v.optional(v.boolean()),
  support_subaddress: v.optional(v.boolean()),
});
const routingRulesSchema = v.array(
  v.object({
    id: v.string(),
    enabled: v.optional(v.boolean()),
    matchers: v.optional(
      v.array(
        v.object({
          type: v.optional(v.string()),
          field: v.optional(v.string()),
          value: v.optional(v.string()),
        })
      )
    ),
    actions: v.optional(
      v.array(v.object({ type: v.optional(v.string()), value: v.optional(v.array(v.string())) }))
    ),
  })
);
const sendingSubdomainsSchema = v.array(
  v.object({ tag: v.string(), name: v.string(), enabled: v.optional(v.boolean()) })
);

export type DnsRecordView = v.InferOutput<typeof dnsRecordsSchema>[number];
export type RoutingRuleView = v.InferOutput<typeof routingRulesSchema>[number];

export interface RoutingRuleInput {
  name: string;
  enabled: boolean;
  matchers: Array<{ type: 'literal'; field: 'to'; value: string }>;
  actions: Array<{ type: 'worker'; value: string[] }>;
}

const resultInfoSchema = v.object({ count: v.number(), total_count: v.number() });

/** Cloudflare's `per_page` maximum for listing DNS records, so one page holds every match. */
const DNS_RECORDS_PER_PAGE = 5_000_000;

async function call<TSchema extends v.GenericSchema>(
  env: Env,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  path: string,
  resultSchema: TSchema,
  body?: unknown
): Promise<v.InferOutput<TSchema>> {
  return (await callWithInfo(env, method, path, resultSchema, body)).result;
}

async function callWithInfo<TSchema extends v.GenericSchema>(
  env: Env,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  path: string,
  resultSchema: TSchema,
  body?: unknown
): Promise<{
  result: v.InferOutput<TSchema>;
  resultInfo: v.InferOutput<typeof resultInfoSchema> | undefined;
}> {
  const response = await fetchWithTimeout(
    `${CLOUDFLARE_API_BASE}/zones/${env.CF_ZONE_ID}${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    getTimeoutMs(env.CF_API_TIMEOUT_MS, DEFAULT_CF_API_TIMEOUT_MS)
  );
  if (!response.ok) {
    const fallback = `HTTP ${response.status}`;
    const { code, message } = await readCloudflareErrorDetail(response, fallback);
    throw new CloudflareEmailApiError(
      response.status,
      code,
      `Cloudflare ${method} ${path.split('?')[0]} failed with HTTP ${response.status}: ${
        code ?? '?'
      } ${message}`
    );
  }
  const parsed = await readResponseJson(
    response,
    v.object({ result: resultSchema, result_info: v.optional(resultInfoSchema) }),
    `cloudflare.agent_email.${method.toLowerCase()}`
  );
  return { result: parsed.result, resultInfo: parsed.result_info };
}

export async function getZoneName(env: Env): Promise<string> {
  return (await call(env, 'GET', '', v.object({ name: v.string() }))).name;
}

/**
 * Every `type` record named `name`. The setup compares these lists, so a listing Cloudflare
 * reports as partial, or without its counts, is an error rather than a shorter list.
 */
export async function listDnsRecords(
  env: Env,
  type: string,
  name: string
): Promise<DnsRecordView[]> {
  const query = `type=${encodeURIComponent(type)}&name=${encodeURIComponent(name)}&per_page=${DNS_RECORDS_PER_PAGE}`;
  const { result, resultInfo } = await callWithInfo(
    env,
    'GET',
    `/dns_records?${query}`,
    dnsRecordsSchema
  );
  if (!resultInfo || resultInfo.total_count > result.length) {
    throw new CloudflareEmailApiError(
      200,
      null,
      `Cloudflare listed ${result.length} of ${resultInfo?.total_count ?? 'an unknown number of'} ${type} records for ${name}`
    );
  }
  return result;
}

export function getRoutingSettings(env: Env) {
  return call(env, 'GET', '/email/routing', routingSettingsSchema);
}

/**
 * Turns Email Routing on for `name`, which must be a subdomain: without a name the same call
 * enables the zone apex, and the apex itself is rejected as a name (Cloudflare support, quoted in
 * cloudflare/terraform-provider-cloudflare#5890).
 */
export async function enableSubdomainRouting(env: Env, name: string): Promise<void> {
  await call(env, 'POST', '/email/routing/dns', v.unknown(), { name });
}

export async function enableSubaddressing(env: Env): Promise<void> {
  await call(env, 'PATCH', '/email/routing', v.unknown(), { support_subaddress: true });
}

export function listRoutingRules(env: Env, page: number, perPage: number) {
  return call(
    env,
    'GET',
    `/email/routing/rules?page=${page}&per_page=${perPage}`,
    routingRulesSchema
  );
}

export async function createRoutingRule(env: Env, rule: RoutingRuleInput): Promise<void> {
  await call(env, 'POST', '/email/routing/rules', v.unknown(), rule);
}

export async function updateRoutingRule(
  env: Env,
  id: string,
  rule: RoutingRuleInput
): Promise<void> {
  await call(env, 'PUT', `/email/routing/rules/${encodeURIComponent(id)}`, v.unknown(), rule);
}

export function listSendingSubdomains(env: Env) {
  return call(env, 'GET', '/email/sending/subdomains', sendingSubdomainsSchema);
}
