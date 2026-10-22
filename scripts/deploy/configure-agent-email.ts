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
 * Google Workspace) the step skips without writing. Enabling the subdomain may not change
 * the apex's existing MX or SPF records; if the apex had none, it may only gain Cloudflare's
 * own, and the deploy reports them (see `checkApexMailRecords`).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Api, type CloudflareRequest, fetchRequest, isAuthFailure } from './cloudflare-rest.js';
import { DEPLOYMENT_CONFIG } from './config.js';

/** Subdomain label under BASE_DOMAIN. Mirrors AGENT_EMAIL_SUBDOMAIN_LABEL in packages/shared. */
export const AGENT_EMAIL_SUBDOMAIN_LABEL = 'mail';
/** Routed local part. Mirrors AGENT_EMAIL_LOCAL_PART in packages/shared. */
export const AGENT_EMAIL_LOCAL_PART = 'agent';
export const AGENT_EMAIL_RULE_NAME = 'SAM agent email';
export const AGENT_EMAIL_MARKER_FILE = 'agent-email-domain';

const CLOUDFLARE_MX_PATTERN = /\.mx\.cloudflare\.net\.?$/i;
const CLOUDFLARE_SPF_INCLUDE = 'include:_spf.mx.cloudflare.net';
const RULES_PAGE_SIZE = 50;
const MAX_RULE_PAGES = 20;
const DEPLOY_STATE_DIR = resolve(import.meta.dirname, '../../.wrangler');

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
  | {
      status: 'configured';
      domain: string;
      writes: number;
      /** Cloudflare mail records that appeared on an apex that had none, as `TYPE content`. */
      apexMailRecordsAdded: string[];
      /** False while Cloudflare is still verifying the sending subdomain's DNS. */
      sendingEnabled: boolean;
    }
  | { status: 'skipped'; reason: string };

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

function isSpfRecord(record: DnsRecord): boolean {
  return normalizeContent(record.content).startsWith('v=spf1');
}

function describeRecord(record: DnsRecord): string {
  return `${record.type} ${normalizeContent(record.content)}`;
}

/** The records that decide where a name's mail goes and who may send as it: MX and SPF. */
async function listMailRecords(api: Api, zoneId: string, name: string): Promise<DnsRecord[]> {
  const mx = await listDnsRecords(api, zoneId, 'MX', name);
  const txt = await listDnsRecords(api, zoneId, 'TXT', name);
  return [...mx, ...txt.filter(isSpfRecord)];
}

function mailSignature(records: DnsRecord[]): string {
  return records
    .map((record) => `${record.type}:${record.priority ?? ''}:${normalizeContent(record.content)}`)
    .sort()
    .join(',');
}

function isCloudflareMailRecord(record: DnsRecord): boolean {
  if (record.type === 'MX') return CLOUDFLARE_MX_PATTERN.test(normalizeContent(record.content));
  return normalizeContent(record.content).includes(CLOUDFLARE_SPF_INCLUDE);
}

/**
 * Cloudflare models subdomain routing as an extension of zone routing, so enabling it may
 * also publish Cloudflare records on the apex. Apex mail records that existed before must
 * come out unchanged: a second SPF record, or an extra MX, breaks mail the operator already
 * relies on. An apex with no mail records may gain only Cloudflare's own. Mail to it was
 * undeliverable before and is refused by Email Routing after (no apex rule exists), so the
 * addition is reported rather than fatal. Returns the added records.
 */
function checkApexMailRecords(
  apex: string,
  domain: string,
  before: DnsRecord[],
  after: DnsRecord[]
): string[] {
  if (before.length > 0) {
    if (mailSignature(before) !== mailSignature(after)) {
      throw new Error(
        `Enabling routing for ${domain} changed the MX/SPF records of ${apex}: before [${before
          .map(describeRecord)
          .join(', ')}], after [${after.map(describeRecord).join(', ')}]`
      );
    }
    return [];
  }
  const foreign = after.filter((record) => !isCloudflareMailRecord(record));
  if (foreign.length > 0) {
    throw new Error(
      `Enabling routing for ${domain} added non-Cloudflare mail records to ${apex}: ${foreign
        .map(describeRecord)
        .join(', ')}`
    );
  }
  return after.map(describeRecord);
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

// The rule is managed through this REST call. Do not also add a top-level `addresses` field
// to apps/api/wrangler.toml without moving this logic there: Wrangler reconciles that field on
// every deploy and would take over, or remove, this rule.
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

/** Returns whether Cloudflare reports the sending subdomain as verified and enabled. */
async function ensureSendingSubdomain(api: Api, zoneId: string, domain: string): Promise<boolean> {
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
  return subdomain.enabled === true;
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
  const apexMailBefore = await listMailRecords(api, zoneId, apex);
  const thirdPartyApexMx = apexMailBefore.filter(
    (record) => record.type === 'MX' && !CLOUDFLARE_MX_PATTERN.test(record.content)
  );
  if (settings.enabled !== true && thirdPartyApexMx.length > 0) {
    return {
      status: 'skipped',
      reason: `the zone apex ${apex} already receives mail elsewhere (${thirdPartyApexMx
        .map((record) => normalizeContent(record.content))
        .join(', ')}) and Email Routing is off for the zone; refusing to risk it`,
    };
  }

  await ensureRoutingForSubdomain(api, zoneId, domain);
  const apexMailRecordsAdded = checkApexMailRecords(
    apex,
    domain,
    apexMailBefore,
    await listMailRecords(api, zoneId, apex)
  );

  await ensureSubaddressing(api, zoneId);
  await ensureRoutingRule(api, zoneId, agentEmailRoutedAddress(options.baseDomain), workerName);
  const sendingEnabled = await ensureSendingSubdomain(api, zoneId, domain);
  return { status: 'configured', domain, writes: api.writes, apexMailRecordsAdded, sendingEnabled };
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
    if (outcome.apexMailRecordsAdded.length > 0) {
      console.log(
        `::warning::Cloudflare added mail records to the zone apex while enabling ${outcome.domain}: ${outcome.apexMailRecordsAdded.join('; ')}. Mail to the bare domain is now refused by Email Routing instead of undeliverable.`
      );
    }
    if (!outcome.sendingEnabled) {
      console.log(
        `::notice::Email Sending for ${outcome.domain} is still verifying its DNS records. Agent replies fail until Cloudflare marks it enabled.`
      );
    }
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
