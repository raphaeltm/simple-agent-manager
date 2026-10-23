#!/usr/bin/env tsx
/**
 * Prepare Cloudflare Email Sending for agent email triggers. The deploy does only the part that
 * stays under `agents.<BASE_DOMAIN>`; an admin turns agent email on from the admin panel.
 *
 * An email trigger's address is `agent+<key>@agents.<BASE_DOMAIN>`. This deploy step,
 * idempotently:
 *   1. checks the deploy token can use Email Routing and Email Sending (the API Worker gets the
 *      same token, and the admin setup needs both);
 *   2. onboards `agents.<BASE_DOMAIN>` for Email Sending and makes sure its DNS records exist.
 *      Cloudflare puts them on `cf-bounce.` and `_dmarc.` under the subdomain, separate from
 *      Email Routing's records on the root domain;
 *   3. writes `.wrangler/agent-email-domain`, so sync-wrangler-config adds the `AGENT_EMAIL`
 *      send binding and the `AGENT_EMAIL_WORKER_NAME` var. The binding may ship while Cloudflare
 *      still verifies the sending records: the sender is checked when mail is sent
 *      (`E_SENDER_NOT_VERIFIED`), not at deploy.
 *
 * It never calls an Email Routing endpoint. Turning routing on, even for a subdomain, can add
 * Cloudflare's SPF record and DKIM key to the root domain the first time a zone uses it (seen on
 * staging, deploy run 39866499256). That step belongs to the admin setup
 * (`apps/api/src/services/agent-email/setup.ts`), which shows the admin those records first.
 *
 * Preview: it runs only when AGENT_EMAIL_ENABLED=true, which only the staging dispatch input
 * `agent_email` sets. Production cannot activate it until inbound sender authentication exists
 * (idea 01KS4X886T3NRKR3696H25A2AN).
 *
 * Fail closed: missing permissions leave the feature off without writing anything. DNS safety:
 * every DNS write must target `agents.<BASE_DOMAIN>` or a name under it, and the root domain's
 * MX and SPF records must come out exactly as they went in, or the deploy fails.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  comparableDnsContent,
  describeMailRecord,
  isSpfRecord,
  mailRecordSignature,
} from '../../packages/shared/src/dns-mail-records.js';
import {
  Api,
  CloudflareApiError,
  type CloudflareRequest,
  fetchRequest,
  isAuthFailure,
} from './cloudflare-rest.js';

/** Subdomain label under BASE_DOMAIN. Mirrors AGENT_EMAIL_SUBDOMAIN_LABEL in packages/shared. */
export const AGENT_EMAIL_SUBDOMAIN_LABEL = 'agents';
export const AGENT_EMAIL_MARKER_FILE = 'agent-email-domain';

/**
 * Cloudflare's "An identical record already exists" (dns_records create). The record this step
 * wanted is there, so the write converged. Its neighbour 81053 (a different record type already
 * holds the name) is a real conflict and still fails the deploy.
 */
const CF_DNS_IDENTICAL_RECORD_CODE = 81058;
const DEPLOY_STATE_DIR = resolve(import.meta.dirname, '../../.wrangler');

export interface DnsRecord {
  id?: string;
  type: string;
  name: string;
  content: string;
  priority?: number;
}

interface SendingSubdomain {
  tag: string;
  name: string;
  enabled?: boolean;
}

export type AgentEmailOutcome =
  /** Sending is set up and the binding can ship; the admin turns agent email on. */
  | { status: 'prepared'; domain: string; writes: number; sendingVerified: boolean }
  | { status: 'skipped'; reason: string };

export interface ConfigureAgentEmailOptions {
  zoneId: string;
  baseDomain: string;
}

export function agentEmailDomain(baseDomain: string): string {
  return `${AGENT_EMAIL_SUBDOMAIN_LABEL}.${baseDomain.toLowerCase()}`;
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
      return `the deploy token cannot use ${probe.permission} (HTTP ${response.status})`;
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

/** Cloudflare's `per_page` maximum for listing DNS records, so one page holds every match. */
const DNS_RECORDS_PER_PAGE = 5_000_000;

/**
 * Every `type` record named `name`. The apex check compares these lists, so a listing Cloudflare
 * reports as partial, or without its counts, is an error rather than a shorter list.
 */
async function listDnsRecords(api: Api, zoneId: string, type: string, name: string) {
  const query = `type=${encodeURIComponent(type)}&name=${encodeURIComponent(name)}&per_page=${DNS_RECORDS_PER_PAGE}`;
  const path = `/zones/${zoneId}/dns_records?${query}`;
  const response = await api.raw('GET', path);
  if (response.status < 200 || response.status >= 300 || response.body.success === false) {
    throw new CloudflareApiError('GET', path, response);
  }
  const records = (response.body.result ?? []) as DnsRecord[];
  const total = response.body.result_info?.total_count;
  if (typeof total !== 'number' || total > records.length) {
    throw new Error(
      `Cloudflare listed ${records.length} of ${total ?? 'an unknown number of'} ${type} records for ${name}`
    );
  }
  return records;
}

/** The records that decide where a name's mail goes and who may send as it: MX and SPF. */
async function listMailRecords(api: Api, zoneId: string, name: string): Promise<DnsRecord[]> {
  const mx = await listDnsRecords(api, zoneId, 'MX', name);
  const txt = await listDnsRecords(api, zoneId, 'TXT', name);
  return [...mx, ...txt.filter(isSpfRecord)];
}

/** Every DNS write here is under the subdomain; the apex's mail records must not move at all. */
function assertApexUnchanged(apex: string, before: DnsRecord[], after: DnsRecord[]): void {
  if (mailRecordSignature(before) === mailRecordSignature(after)) return;
  throw new Error(
    `The MX/SPF records of ${apex} changed during agent email setup: before [${before
      .map(describeMailRecord)
      .join(', ')}], after [${after.map(describeMailRecord).join(', ')}]`
  );
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
  const wanted = comparableDnsContent(record);
  if (existing.some((candidate) => comparableDnsContent(candidate) === wanted)) return;
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
 * Prepare agent email for one deployment. Returns `skipped` without writing anything when the
 * token lacks permissions. Never touches Email Routing; see the file comment.
 */
export async function configureAgentEmail(
  request: CloudflareRequest,
  options: ConfigureAgentEmailOptions
): Promise<AgentEmailOutcome> {
  const api = new Api(request);
  const { zoneId } = options;
  const domain = agentEmailDomain(options.baseDomain);

  const denied = await probeAccess(api, zoneId);
  if (denied) return { status: 'skipped', reason: denied };

  const zone = await api.call<{ name: string }>('GET', `/zones/${zoneId}`);
  const apex = normalizeName(zone.name);
  const apexMailBefore = await listMailRecords(api, zoneId, apex);
  const sendingVerified = await ensureSendingSubdomain(api, zoneId, domain);
  assertApexUnchanged(apex, apexMailBefore, await listMailRecords(api, zoneId, apex));
  return { status: 'prepared', domain, writes: api.writes, sendingVerified };
}

export function writeAgentEmailMarker(
  outcome: AgentEmailOutcome,
  stateDirectory = DEPLOY_STATE_DIR
): void {
  mkdirSync(stateDirectory, { recursive: true });
  const path = resolve(stateDirectory, AGENT_EMAIL_MARKER_FILE);
  if (outcome.status === 'prepared') writeFileSync(path, outcome.domain, 'utf-8');
  else rmSync(path, { force: true });
}

/** The prepared agent email domain for this deploy, or null when agent email is off. */
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
  const outcome = await configureAgentEmail(fetchRequest(requireEnv('CF_API_TOKEN')), {
    zoneId: requireEnv('CF_ZONE_ID'),
    baseDomain: requireEnv('BASE_DOMAIN'),
  });
  writeAgentEmailMarker(outcome);
  if (outcome.status === 'prepared') {
    console.log(
      `Agent email prepared for ${outcome.domain} (${outcome.writes} Cloudflare write(s)); sending is ${
        outcome.sendingVerified ? 'verified' : 'still verifying'
      }. A superadmin turns it on in Admin → Integrations → Agent email.`
    );
  } else {
    console.log(`::notice::Agent email is off for this deployment: ${outcome.reason}`);
  }
}

const isDirectExecution = process.argv[1]?.endsWith('configure-agent-email.ts');
if (isDirectExecution) {
  main().catch((error) => {
    console.error(
      `::error::Agent email preparation failed: ${error instanceof Error ? error.message : error}`
    );
    process.exit(1);
  });
}
