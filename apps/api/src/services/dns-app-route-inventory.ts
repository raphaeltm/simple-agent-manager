/**
 * Read-and-guarded-delete access to the app-route A records in this installation's zone, for
 * reconciliation (`app-route-dns-reconciliation.ts`).
 *
 * Only records named exactly like `buildRouteHostname` output
 * (`r{n}-{service}-{port}-{envId}.apps.{BASE_DOMAIN}`, `@simple-agent-manager/app-deployment`)
 * are ever returned, so nothing else in the zone can reach a delete: the provider list is
 * narrowed by `type=A` and the `.apps.{BASE_DOMAIN}` suffix, and every row is then re-parsed here.
 *
 * Both DNS providers go through the same seam (`dns-provider.ts`): Cloudflare's list API, or
 * the self-host box's own zone in D1.
 */
import * as v from 'valibot';

import type { Env } from '../env';
import { readResponseJson } from '../lib/runtime-validation';
import {
  CLOUDFLARE_API_BASE,
  DEFAULT_CF_API_TIMEOUT_MS,
  deleteDNSRecord,
  findDNSRecordMatchesByName,
  readCloudflareError,
} from './dns-core';
import { boxDnsBackendFor } from './dns-provider';
import { fetchWithTimeout, getTimeoutMs } from './fetch-timeout';

/** ULIDs are 26 characters; `buildRouteHostname` lowercases them. */
const ENVIRONMENT_ID_LENGTH = 26;
const ENVIRONMENT_ID_LABEL_RE = /^[0-9a-z]+$/;
const ROUTE_INDEX_RE = /^r[1-9]\d*$/;
const PORT_RE = /^\d{1,5}$/;
// `buildRouteHostname` truncates the sanitized service, which can leave a trailing hyphen.
const SERVICE_RE = /^[a-z0-9][a-z0-9-]*$/;

export interface AppRouteDnsRecord {
  id: string;
  /** Fully qualified, lowercase. */
  name: string;
  /** The A record's IPv4 address. */
  content: string;
  /** Upper-case environment id parsed from the name (the D1 primary key). */
  environmentId: string;
}

export interface AppRouteDnsPage {
  records: AppRouteDnsRecord[];
  /** How many A records the provider returned for this page, before the name re-parse. */
  providerCount: number;
}

/** The app-route zone suffix, `.apps.{BASE_DOMAIN}`, or null when BASE_DOMAIN is unset. */
export function appRouteNameSuffix(baseDomain: string | undefined): string | null {
  const apex = (baseDomain ?? '').trim().toLowerCase().replace(/\.$/, '');
  return apex ? `.apps.${apex}` : null;
}

/**
 * The environment id an app-route hostname belongs to, or null for any name that
 * `buildRouteHostname` could not have produced for this installation's BASE_DOMAIN.
 * Split-based rather than one regex, so no input can backtrack.
 */
export function parseAppRouteHostname(
  hostname: string,
  baseDomain: string | undefined
): { environmentId: string } | null {
  const suffix = appRouteNameSuffix(baseDomain);
  if (!suffix) return null;
  const name = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (!name.endsWith(suffix)) return null;
  const label = name.slice(0, -suffix.length);
  // One DNS label, `r{n}-{service...}-{port}-{env}`: no part below admits a dot.
  if (!label || label.length > 63) return null;
  const parts = label.split('-');
  if (parts.length < 4) return null;
  const routeIndex = parts[0] ?? '';
  const envPart = parts[parts.length - 1] ?? '';
  const port = parts[parts.length - 2] ?? '';
  const serviceParts = parts.slice(1, -2);
  if (!ROUTE_INDEX_RE.test(routeIndex)) return null;
  if (!PORT_RE.test(port)) return null;
  if (envPart.length !== ENVIRONMENT_ID_LENGTH || !ENVIRONMENT_ID_LABEL_RE.test(envPart)) {
    return null;
  }
  if (!SERVICE_RE.test(serviceParts.join('-'))) return null;
  return { environmentId: envPart.toUpperCase() };
}

const listedRecordSchema = v.object({
  id: v.string(),
  name: v.string(),
  type: v.string(),
  content: v.optional(v.string()),
});
const listResponseSchema = v.object({ result: v.array(listedRecordSchema) });

function toAppRouteRecords(
  rows: readonly v.InferOutput<typeof listedRecordSchema>[],
  env: Env
): AppRouteDnsRecord[] {
  const records: AppRouteDnsRecord[] = [];
  for (const row of rows) {
    if (row.type !== 'A' || !row.content) continue;
    const parsed = parseAppRouteHostname(row.name, env.BASE_DOMAIN);
    if (!parsed) continue;
    records.push({
      id: row.id,
      name: row.name.toLowerCase(),
      content: row.content,
      environmentId: parsed.environmentId,
    });
  }
  return records;
}

/**
 * One page (1-based, ordered by name) of A records under `.apps.{BASE_DOMAIN}`, optionally
 * only those pointing at `content`.
 */
export async function listAppRouteDnsRecordsPage(
  env: Env,
  input: { page: number; perPage: number; content?: string },
  signal?: AbortSignal
): Promise<AppRouteDnsPage> {
  const suffix = appRouteNameSuffix(env.BASE_DOMAIN);
  if (!suffix) return { records: [], providerCount: 0 };
  if (signal?.aborted) throw signal.reason;
  const box = boxDnsBackendFor(env);
  if (box) {
    const rows = await box.listARecords(
      { nameSuffix: suffix, content: input.content, page: input.page, perPage: input.perPage },
      env
    );
    return { records: toAppRouteRecords(rows, env), providerCount: rows.length };
  }
  const query = new URLSearchParams({
    type: 'A',
    'name.endswith': suffix,
    order: 'name',
    direction: 'asc',
    match: 'all',
    page: String(input.page),
    per_page: String(input.perPage),
  });
  if (input.content) query.set('content.exact', input.content);
  const response = await fetchWithTimeout(
    `${CLOUDFLARE_API_BASE}/zones/${env.CF_ZONE_ID}/dns_records?${query.toString()}`,
    { headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` } },
    getTimeoutMs(env.CF_API_TIMEOUT_MS, DEFAULT_CF_API_TIMEOUT_MS),
    signal
  );
  if (!response.ok) {
    throw new Error(
      await readCloudflareError(response, `Failed to list app-route DNS records: ${response.status}`)
    );
  }
  const data = await readResponseJson(
    response,
    listResponseSchema,
    'cloudflare.dns.list_app_route_records'
  );
  return { records: toAppRouteRecords(data.result, env), providerCount: data.result.length };
}

/**
 * Delete one observed app-route record, only if it still exists with the content it had when it
 * was judged dangling. Re-reading by name first means a concurrent release fetch that has just
 * repointed the record (`upsertAppRouteDNSRecord` updates it in place) wins: its new content no
 * longer matches, so the record is left alone. Returns whether a record was deleted.
 */
export async function deleteObservedAppRouteDnsRecord(
  env: Env,
  record: Pick<AppRouteDnsRecord, 'id' | 'name' | 'content'>,
  signal?: AbortSignal
): Promise<'deleted' | 'changed' | 'absent'> {
  if (!parseAppRouteHostname(record.name, env.BASE_DOMAIN)) {
    // Unreachable through the listers above; kept so no caller can delete outside the namespace.
    throw new Error(`Refusing to delete a DNS record outside the app-route namespace`);
  }
  const current = (await findDNSRecordMatchesByName(record.name, env, signal)).find(
    (match) => match.id === record.id
  );
  if (!current) return 'absent';
  if (current.type !== 'A' || current.content !== record.content) return 'changed';
  await deleteDNSRecord(record.id, env, signal);
  return 'deleted';
}
