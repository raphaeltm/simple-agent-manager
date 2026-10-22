#!/usr/bin/env tsx
/**
 * Configure Cloudflare Email Routing and Email Sending for agent email triggers.
 *
 * An email trigger's address is `agent+<key>@mail.<BASE_DOMAIN>`. This deploy step
 * makes that address real, idempotently:
 *   1. Email Routing is enabled for the `mail.<BASE_DOMAIN>` subdomain;
 *   2. subaddressing is honored, so `agent+<key>@` matches the `agent@` rule;
 *   3. one literal rule routes `agent@mail.<BASE_DOMAIN>` to the API Worker's
 *      `email()` handler;
 *   4. `mail.<BASE_DOMAIN>` is onboarded for Email Sending and its DNS records exist.
 *
 * It runs before sync-wrangler-config. On success it writes `.wrangler/agent-email-domain`;
 * sync-wrangler-config adds the `AGENT_EMAIL` send_email binding only when that marker
 * exists, and the API Worker treats the binding as "agent email is available". So the
 * binding only ever ships after this deploy verified the whole configuration.
 *
 * Preview: it runs only when AGENT_EMAIL_ENABLED=true, which only the staging dispatch
 * input `agent_email` sets. Production cannot activate it until inbound sender
 * authentication exists (idea 01KS4X886T3NRKR3696H25A2AN).
 *
 * Fail closed: a deploy token without the email permissions leaves the feature off.
 * DNS safety: every DNS write must target `mail.<BASE_DOMAIN>` or a name under it. When
 * zone routing is off and the apex already has non-Cloudflare MX records (production uses
 * Google Workspace) the step skips without writing, and any change to pre-existing apex
 * MX records after enabling the subdomain fails the deploy.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { DEPLOYMENT_CONFIG } from './config.js';

/** Subdomain label under BASE_DOMAIN. Mirrors AGENT_EMAIL_SUBDOMAIN_LABEL in packages/shared. */
export const AGENT_EMAIL_SUBDOMAIN_LABEL = 'mail';
/** Routed local part. Mirrors AGENT_EMAIL_LOCAL_PART in packages/shared. */
export const AGENT_EMAIL_LOCAL_PART = 'agent';
export const AGENT_EMAIL_RULE_NAME = 'SAM agent email';
export const AGENT_EMAIL_MARKER_FILE = 'agent-email-domain';

const CLOUDFLARE_MX_PATTERN = /\.mx\.cloudflare\.net\.?$/i;
const RULES_PAGE_SIZE = 50;
const MAX_RULE_PAGES = 20;
const DEPLOY_STATE_DIR = resolve(import.meta.dirname, '../../.wrangler');

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH';

export interface CloudflareEnvelope {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: unknown;
}

export interface CloudflareResponse {
  status: number;
  body: CloudflareEnvelope;
}

export type CloudflareRequest = (
  method: HttpMethod,
  path: string,
  body?: unknown
) => Promise<CloudflareResponse>;

export interface DnsRecord {
  id?: string;
  type: string;
  name: string;
  content: string;
  priority?: number;
}

interface RoutingRule {
  id: string;
  enabled?: boolean;
  matchers?: Array<{ type?: string; field?: string; value?: string }>;
  actions?: Array<{ type?: string; value?: string[] }>;
}

interface SendingSubdomain {
  tag: string;
  name: string;
  enabled?: boolean;
}

export type AgentEmailOutcome =
  { status: 'configured'; domain: string; writes: number } | { status: 'skipped'; reason: string };

export interface ConfigureAgentEmailOptions {
  zoneId: string;
  baseDomain: string;
  workerName: string;
}

export function agentEmailDomain(baseDomain: string): string {
  return `${AGENT_EMAIL_SUBDOMAIN_LABEL}.${baseDomain.toLowerCase()}`;
}

export function agentEmailRoutedAddress(baseDomain: string): string {
  return `${AGENT_EMAIL_LOCAL_PART}@${agentEmailDomain(baseDomain)}`;
}

class CloudflareApiError extends Error {
  constructor(
    readonly method: HttpMethod,
    readonly path: string,
    readonly response: CloudflareResponse
  ) {
    const detail = (response.body.errors ?? [])
      .map((error) => `${error.code ?? '?'} ${error.message ?? ''}`.trim())
      .join('; ');
    super(
      `Cloudflare ${method} ${path} failed with HTTP ${response.status}: ${detail || 'no detail'}`
    );
  }
}

function isAuthFailure(response: CloudflareResponse): boolean {
  if (response.status === 401 || response.status === 403) return true;
  return (response.body.errors ?? []).some(
    (error) => error.code === 10000 || /authentication|unauthori[sz]ed/i.test(error.message ?? '')
  );
}

/** Counts write calls so idempotent re-runs can be asserted and reported. */
class Api {
  writes = 0;
  constructor(private readonly request: CloudflareRequest) {}

  async raw(method: HttpMethod, path: string, body?: unknown): Promise<CloudflareResponse> {
    if (method !== 'GET') this.writes += 1;
    return this.request(method, path, body);
  }

  async call<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
    const response = await this.raw(method, path, body);
    if (response.status < 200 || response.status >= 300 || response.body.success === false) {
      throw new CloudflareApiError(method, path, response);
    }
    return response.body.result as T;
  }
}

const PERMISSION_PROBES = [
  { path: (zone: string) => `/zones/${zone}/email/routing`, permission: 'Zone → Zone Settings' },
  {
    path: (zone: string) => `/zones/${zone}/email/routing/rules?per_page=1`,
    permission: 'Zone → Email Routing Rules',
  },
  {
    path: (zone: string) => `/zones/${zone}/email/sending/subdomains`,
    permission: 'Email Sending',
  },
] as const;

async function probeAccess(api: Api, zoneId: string): Promise<string | null> {
  for (const probe of PERMISSION_PROBES) {
    const response = await api.raw('GET', probe.path(zoneId));
    if (isAuthFailure(response)) {
      return `the deploy token cannot read ${probe.permission} (HTTP ${response.status})`;
    }
    if (response.status < 200 || response.status >= 300 || response.body.success === false) {
      return `probe ${probe.path(zoneId)} returned HTTP ${response.status}`;
    }
  }
  return null;
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/\.$/, '');
}

function normalizeContent(content: string): string {
  return content
    .trim()
    .replace(/^"(.*)"$/s, '$1')
    .replace(/\.$/, '')
    .toLowerCase();
}

async function listDnsRecords(api: Api, zoneId: string, type: string, name: string) {
  const query = `type=${encodeURIComponent(type)}&name=${encodeURIComponent(name)}&per_page=100`;
  return api.call<DnsRecord[]>('GET', `/zones/${zoneId}/dns_records?${query}`);
}

function mxSignature(records: DnsRecord[]): string {
  return records
    .map((record) => `${record.priority ?? ''}:${normalizeContent(record.content)}`)
    .sort()
    .join(',');
}

async function ensureRoutingForSubdomain(api: Api, zoneId: string, domain: string): Promise<void> {
  const mx = await listDnsRecords(api, zoneId, 'MX', domain);
  if (mx.some((record) => CLOUDFLARE_MX_PATTERN.test(record.content))) return;
  await api.call('POST', `/zones/${zoneId}/email/routing/dns`, { name: domain });
}

async function ensureSubaddressing(api: Api, zoneId: string): Promise<void> {
  const settings = await api.call<{ support_subaddress?: boolean }>(
    'GET',
    `/zones/${zoneId}/email/routing`
  );
  if (settings.support_subaddress === true) return;
  await api.call('PATCH', `/zones/${zoneId}/email/routing`, { support_subaddress: true });
}

function ruleMatchesAddress(rule: RoutingRule, address: string): boolean {
  return (rule.matchers ?? []).some(
    (matcher) =>
      matcher.type === 'literal' &&
      matcher.field === 'to' &&
      normalizeName(matcher.value ?? '') === address
  );
}

function ruleRoutesToWorker(rule: RoutingRule, workerName: string): boolean {
  return (
    rule.enabled === true &&
    rule.actions?.length === 1 &&
    rule.actions[0]?.type === 'worker' &&
    rule.actions[0]?.value?.length === 1 &&
    rule.actions[0]?.value?.[0] === workerName
  );
}

async function findRule(api: Api, zoneId: string, address: string): Promise<RoutingRule | null> {
  for (let page = 1; page <= MAX_RULE_PAGES; page += 1) {
    const rules = await api.call<RoutingRule[]>(
      'GET',
      `/zones/${zoneId}/email/routing/rules?page=${page}&per_page=${RULES_PAGE_SIZE}`
    );
    const match = rules.find((rule) => ruleMatchesAddress(rule, address));
    if (match) return match;
    if (rules.length < RULES_PAGE_SIZE) return null;
  }
  throw new Error(`More than ${MAX_RULE_PAGES * RULES_PAGE_SIZE} routing rules; refusing to guess`);
}

async function ensureRoutingRule(
  api: Api,
  zoneId: string,
  address: string,
  workerName: string
): Promise<void> {
  const desired = {
    name: AGENT_EMAIL_RULE_NAME,
    enabled: true,
    matchers: [{ type: 'literal', field: 'to', value: address }],
    actions: [{ type: 'worker', value: [workerName] }],
  };
  const existing = await findRule(api, zoneId, address);
  if (existing && ruleRoutesToWorker(existing, workerName)) return;
  if (existing) {
    await api.call('PUT', `/zones/${zoneId}/email/routing/rules/${existing.id}`, desired);
    return;
  }
  await api.call('POST', `/zones/${zoneId}/email/routing/rules`, desired);
}

function isWithinDomain(name: string, domain: string): boolean {
  const normalized = normalizeName(name);
  return normalized === domain || normalized.endsWith(`.${domain}`);
}

async function ensureDnsRecord(
  api: Api,
  zoneId: string,
  domain: string,
  record: DnsRecord
): Promise<void> {
  if (!isWithinDomain(record.name, domain)) {
    throw new Error(
      `Refusing to write DNS record ${record.type} ${record.name}: it is outside ${domain}`
    );
  }
  const existing = await listDnsRecords(api, zoneId, record.type, record.name);
  const wanted = normalizeContent(record.content);
  if (existing.some((candidate) => normalizeContent(candidate.content) === wanted)) return;
  await api.call('POST', `/zones/${zoneId}/dns_records`, {
    type: record.type,
    name: record.name,
    content: record.content,
    ttl: 1,
    proxied: false,
    ...(record.priority === undefined ? {} : { priority: record.priority }),
  });
}

async function ensureSendingSubdomain(api: Api, zoneId: string, domain: string): Promise<void> {
  const subdomains = await api.call<SendingSubdomain[]>(
    'GET',
    `/zones/${zoneId}/email/sending/subdomains`
  );
  const subdomain =
    subdomains.find((candidate) => normalizeName(candidate.name) === domain) ??
    (await api.call<SendingSubdomain>('POST', `/zones/${zoneId}/email/sending/subdomains`, {
      name: domain,
    }));
  const records = await api.call<DnsRecord[]>(
    'GET',
    `/zones/${zoneId}/email/sending/subdomains/${subdomain.tag}/dns`
  );
  for (const record of records) await ensureDnsRecord(api, zoneId, domain, record);
}

/**
 * Configure agent email for one deployment. Returns `skipped` without writing anything
 * when the token lacks permissions or the zone apex has third-party mail.
 */
export async function configureAgentEmail(
  request: CloudflareRequest,
  options: ConfigureAgentEmailOptions
): Promise<AgentEmailOutcome> {
  const api = new Api(request);
  const { zoneId, workerName } = options;
  const domain = agentEmailDomain(options.baseDomain);

  const denied = await probeAccess(api, zoneId);
  if (denied) return { status: 'skipped', reason: denied };

  const zone = await api.call<{ name: string }>('GET', `/zones/${zoneId}`);
  const apex = normalizeName(zone.name);
  const settings = await api.call<{ enabled?: boolean }>('GET', `/zones/${zoneId}/email/routing`);
  const apexMx = await listDnsRecords(api, zoneId, 'MX', apex);
  const thirdPartyApexMx = apexMx.filter((record) => !CLOUDFLARE_MX_PATTERN.test(record.content));
  if (settings.enabled !== true && thirdPartyApexMx.length > 0) {
    return {
      status: 'skipped',
      reason: `the zone apex ${apex} already receives mail elsewhere (${thirdPartyApexMx
        .map((record) => normalizeContent(record.content))
        .join(', ')}) and Email Routing is off for the zone; refusing to risk it`,
    };
  }

  await ensureRoutingForSubdomain(api, zoneId, domain);
  const apexMxAfter = await listDnsRecords(api, zoneId, 'MX', apex);
  const preExisting = mxSignature(apexMx);
  const stillPresent = mxSignature(
    apexMxAfter.filter((record) =>
      apexMx.some(
        (before) =>
          normalizeContent(before.content) === normalizeContent(record.content) &&
          before.priority === record.priority
      )
    )
  );
  if (preExisting !== stillPresent) {
    throw new Error(
      `Enabling routing for ${domain} changed the pre-existing apex MX records of ${apex}`
    );
  }

  await ensureSubaddressing(api, zoneId);
  await ensureRoutingRule(api, zoneId, agentEmailRoutedAddress(options.baseDomain), workerName);
  await ensureSendingSubdomain(api, zoneId, domain);
  return { status: 'configured', domain, writes: api.writes };
}

export function writeAgentEmailMarker(
  outcome: AgentEmailOutcome,
  stateDirectory = DEPLOY_STATE_DIR
): void {
  mkdirSync(stateDirectory, { recursive: true });
  const path = resolve(stateDirectory, AGENT_EMAIL_MARKER_FILE);
  if (outcome.status === 'configured') writeFileSync(path, outcome.domain, 'utf-8');
  else rmSync(path, { force: true });
}

/** The configured agent email domain for this deploy, or null when agent email is off. */
export function readAgentEmailMarker(stateDirectory = DEPLOY_STATE_DIR): string | null {
  const path = resolve(stateDirectory, AGENT_EMAIL_MARKER_FILE);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf-8').trim() || null;
}

function fetchRequest(apiToken: string): CloudflareRequest {
  return async (method, path, body) => {
    const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: unknown = {};
    try {
      parsed = text ? (JSON.parse(text) as unknown) : {};
    } catch {
      parsed = { success: false, errors: [{ message: text.slice(0, 200) }] };
    }
    return { status: response.status, body: toEnvelope(parsed) };
  };
}

/** Narrow a Cloudflare v4 response body; anything unexpected becomes an unsuccessful envelope. */
export function toEnvelope(value: unknown): CloudflareEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { success: false, errors: [{ message: 'Cloudflare returned a non-object body' }] };
  }
  const record = value as Record<string, unknown>;
  const errors = Array.isArray(record.errors)
    ? record.errors.map((entry) => {
        const error = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
        return {
          code: typeof error.code === 'number' ? error.code : undefined,
          message: typeof error.message === 'string' ? error.message : undefined,
        };
      })
    : undefined;
  return {
    success: typeof record.success === 'boolean' ? record.success : undefined,
    errors,
    result: record.result,
  };
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  if (process.env.AGENT_EMAIL_ENABLED?.trim().toLowerCase() !== 'true') {
    writeAgentEmailMarker({ status: 'skipped', reason: 'AGENT_EMAIL_ENABLED is not true' });
    console.log('Agent email (preview) is off for this deploy: AGENT_EMAIL_ENABLED is not true');
    return;
  }
  const stack = requireEnv('PULUMI_STACK');
  const outcome = await configureAgentEmail(fetchRequest(requireEnv('CF_API_TOKEN')), {
    zoneId: requireEnv('CF_ZONE_ID'),
    baseDomain: requireEnv('BASE_DOMAIN'),
    workerName: DEPLOYMENT_CONFIG.resources.workerName(stack),
  });
  writeAgentEmailMarker(outcome);
  if (outcome.status === 'configured') {
    console.log(
      `Agent email configured for ${outcome.domain} (${outcome.writes} Cloudflare write(s))`
    );
  } else {
    console.log(`::notice::Agent email is off for this deployment: ${outcome.reason}`);
  }
}

const isDirectExecution = process.argv[1]?.endsWith('configure-agent-email.ts');
if (isDirectExecution) {
  main().catch((error) => {
    console.error(
      `::error::Agent email configuration failed: ${error instanceof Error ? error.message : error}`
    );
    process.exit(1);
  });
}
