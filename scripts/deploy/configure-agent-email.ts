#!/usr/bin/env tsx
/**
 * Configure Cloudflare Email Routing and Email Sending for agent email triggers.
 *
 * An email trigger's address is `agent+<key>@agents.<BASE_DOMAIN>`. This deploy step
 * makes that address real, idempotently:
 *   1. Email Routing is on for `agents.<BASE_DOMAIN>` (turned on by naming that subdomain; see
 *      below);
 *   2. subaddressing is honored, so `agent+<key>@` matches the `agent@` rule;
 *   3. one literal rule routes `agent@agents.<BASE_DOMAIN>` to the API Worker's
 *      `email()` handler;
 *   4. `agents.<BASE_DOMAIN>` is onboarded for Email Sending and its DNS records exist.
 *
 * It runs before sync-wrangler-config. Only when all of that holds AND Cloudflare reports
 * sending as enabled does it write `.wrangler/agent-email-domain`; sync-wrangler-config adds
 * the `AGENT_EMAIL` send_email binding only when that marker exists, and the API Worker treats
 * the binding as "agent email is available". A subdomain still verifying its sending records
 * leaves the feature off until a later deploy finds it enabled.
 *
 * Turning routing on for the subdomain: `POST /zones/{zone}/email/routing/dns`. Without a
 * body it enables the zone apex; with `{ name }` it configures that subdomain, and the apex
 * itself is rejected as a name (Cloudflare support, quoted in
 * cloudflare/terraform-provider-cloudflare#5890; the public reference only says "Enable your
 * Email Routing zone"). So the call always names the subdomain, and the apex's mail records
 * are compared straight after it: the deploy fails before configuring anything else if the
 * call touched them. The first such call in a zone does touch them: Cloudflare turns routing
 * on for the whole zone and adds its SPF record and a DKIM key at the apex (seen on staging,
 * deploy run 39866499256), so in a zone new to Email Routing the first deploy fails here and
 * the next completes. Whether to accept or merge those records instead is an open decision
 * (task 2026-10-22-agent-email-prototype, open question 5).
 *
 * Preview: it runs only when AGENT_EMAIL_ENABLED=true, which only the staging dispatch
 * input `agent_email` sets. Production cannot activate it until inbound sender
 * authentication exists (idea 01KS4X886T3NRKR3696H25A2AN).
 *
 * Fail closed: missing permissions leave the feature off without writing anything. DNS
 * safety: every DNS write must target `agents.<BASE_DOMAIN>` or a name under it, and the apex's
 * MX and SPF records must come out exactly as they went in (no change, no addition), or the
 * deploy fails.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  Api,
  CloudflareApiError,
  type CloudflareRequest,
  fetchRequest,
  isAuthFailure,
} from './cloudflare-rest.js';
import { DEPLOYMENT_CONFIG } from './config.js';

/** Subdomain label under BASE_DOMAIN. Mirrors AGENT_EMAIL_SUBDOMAIN_LABEL in packages/shared. */
export const AGENT_EMAIL_SUBDOMAIN_LABEL = 'agents';
/** Routed local part. Mirrors AGENT_EMAIL_LOCAL_PART in packages/shared. */
export const AGENT_EMAIL_LOCAL_PART = 'agent';
export const AGENT_EMAIL_RULE_NAME = 'SAM agent email';
export const AGENT_EMAIL_MARKER_FILE = 'agent-email-domain';

const CLOUDFLARE_MX_PATTERN = /\.mx\.cloudflare\.net\.?$/i;
/**
 * Cloudflare's "An identical record already exists" (dns_records create). The record this step
 * wanted is there, so the write converged. Its neighbour 81053 (a different record type already
 * holds the name) is a real conflict and still fails the deploy.
 */
const CF_DNS_IDENTICAL_RECORD_CODE = 81058;
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
  | { status: 'configured'; domain: string; writes: number }
  /**
   * Set up as far as Cloudflare allows so far: the routing records are not visible yet, or
   * sending is still verifying.
   */
  | { status: 'pending'; domain: string; writes: number; reason: string }
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

/**
 * Comparable record content. A TXT value can be stored as several quoted strings, which Cloudflare
 * does for long values such as DKIM keys; its meaning is the strings joined.
 */
function normalizeContent(content: string): string {
  const quoted = content.trim().match(/"(?:[^"\\]|\\.)*"/g);
  const value = quoted ? quoted.map((chunk) => chunk.slice(1, -1)).join('') : content.trim();
  return value.replace(/\.$/, '').toLowerCase();
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
    .sort((a, b) => a.localeCompare(b))
    .join(',');
}

/** Every DNS write here is under the subdomain; the apex's mail records must not move at all. */
function assertApexUnchanged(apex: string, before: DnsRecord[], after: DnsRecord[]): void {
  if (mailSignature(before) === mailSignature(after)) return;
  throw new Error(
    `The MX/SPF records of ${apex} changed during agent email setup: before [${before
      .map(describeRecord)
      .join(', ')}], after [${after.map(describeRecord).join(', ')}]`
  );
}

/** Email Routing is on for the subdomain when its MX records point at Cloudflare. */
async function subdomainRoutingEnabled(api: Api, zoneId: string, domain: string): Promise<boolean> {
  const mx = await listDnsRecords(api, zoneId, 'MX', domain);
  return mx.some((record) => CLOUDFLARE_MX_PATTERN.test(normalizeContent(record.content)));
}

/**
 * Turn Email Routing on for the subdomain. The body must name the subdomain: without it the
 * same call enables the zone apex. In a zone new to Email Routing it still adds Cloudflare's
 * SPF and DKIM records at the apex, so callers compare the apex's mail records right after.
 */
async function enableSubdomainRouting(api: Api, zoneId: string, domain: string): Promise<void> {
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
  try {
    await api.call('POST', `/zones/${zoneId}/dns_records`, {
      type: record.type,
      name: record.name,
      content: record.content,
      ttl: 1,
      proxied: false,
      ...(record.priority === undefined ? {} : { priority: record.priority }),
    });
  } catch (error) {
    const identical =
      error instanceof CloudflareApiError &&
      (error.response.body.errors ?? []).some(
        (entry) => entry.code === CF_DNS_IDENTICAL_RECORD_CODE
      );
    if (!identical) throw error;
  }
}

async function findSendingSubdomain(
  api: Api,
  zoneId: string,
  domain: string
): Promise<SendingSubdomain | undefined> {
  const subdomains = await api.call<SendingSubdomain[]>(
    'GET',
    `/zones/${zoneId}/email/sending/subdomains`
  );
  return subdomains.find((candidate) => normalizeName(candidate.name) === domain);
}

/**
 * Onboards the subdomain for sending and creates its DNS records, then reads back whether
 * Cloudflare reports it enabled. The read happens after the records exist, so a subdomain
 * that verifies as soon as they appear is not reported as pending.
 */
async function ensureSendingSubdomain(api: Api, zoneId: string, domain: string): Promise<boolean> {
  const subdomain =
    (await findSendingSubdomain(api, zoneId, domain)) ??
    (await api.call<SendingSubdomain>('POST', `/zones/${zoneId}/email/sending/subdomains`, {
      name: domain,
    }));
  const records = await api.call<DnsRecord[]>(
    'GET',
    `/zones/${zoneId}/email/sending/subdomains/${subdomain.tag}/dns`
  );
  for (const record of records) await ensureDnsRecord(api, zoneId, domain, record);
  return (await findSendingSubdomain(api, zoneId, domain))?.enabled === true;
}

/**
 * Configure agent email for one deployment. Returns `skipped` without writing anything when
 * the token lacks permissions, and `pending` when everything is set up but Cloudflare has not
 * finished (routing records not visible yet, or sending still verifying).
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
  const apexMailBefore = await listMailRecords(api, zoneId, apex);

  if (!(await subdomainRoutingEnabled(api, zoneId, domain))) {
    await enableSubdomainRouting(api, zoneId, domain);
    assertApexUnchanged(apex, apexMailBefore, await listMailRecords(api, zoneId, apex));
    if (!(await subdomainRoutingEnabled(api, zoneId, domain))) {
      return {
        status: 'pending',
        domain,
        writes: api.writes,
        reason: `Email Routing was turned on for ${domain}, but its MX records are not visible yet; deploy again in a few minutes`,
      };
    }
  }

  await ensureSubaddressing(api, zoneId);
  await ensureRoutingRule(api, zoneId, agentEmailRoutedAddress(options.baseDomain), workerName);
  const sendingEnabled = await ensureSendingSubdomain(api, zoneId, domain);
  assertApexUnchanged(apex, apexMailBefore, await listMailRecords(api, zoneId, apex));

  if (!sendingEnabled) {
    return {
      status: 'pending',
      domain,
      writes: api.writes,
      reason: `Email Sending for ${domain} is still verifying its DNS records (usually 5 to 15 minutes); deploy again once Cloudflare shows it enabled`,
    };
  }
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
