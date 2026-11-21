/**
 * The box's DNS zone in D1 (migration selfhost/migrations/0267_selfhost_dns_records.sql): the box
 * backend behind `services/dns-provider.ts`, and the paged read the sam-dns sidecar syncs from.
 *
 * Self-host only: imported by `selfhost/dns/index.ts`, which only the self-host build installs.
 *
 * Every write runs in one D1 batch with a bump of the zone serial, so a reader that sees the serial
 * unchanged knows no record changed.
 */
import { ulid } from '@simple-agent-manager/worker-core';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import type { BoxDnsRecordMatch } from '../../services/dns-provider';

export type BoxDnsEnv = Pick<Env, 'DATABASE' | 'BASE_DOMAIN'>;

/** The only record type the Worker writes today (node and app-route A records). */
export const BOX_DNS_RECORD_TYPE = 'A';
const MAX_NAME_LENGTH = 253;
const LABEL_RE = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?$/;
const IPV4_RE = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/**
 * The only names the Worker writes in the box's zone, relative to the apex: workspace records
 * (`ws-<id>`, createDNSRecord), node backends (`<id>.vm`, createNodeBackendDNSRecord) and app routes
 * (`<label>.apps`, buildRouteHostname). The apex, `api`, `app`, `ns1` and everything else belong
 * to sam-dns's static records, so a writer bug can never repoint them (defence in depth: every
 * caller today passes a server-built name). `vm-<id>` is the pre-migration backend name, which
 * cleanup may still delete.
 */
const WRITABLE_RELATIVE_NAME_RE = /^(?:ws-[a-z0-9_-]+|[a-z0-9_-]+\.vm|[a-z0-9_-]+\.apps)$/;
const DELETABLE_RELATIVE_NAME_RE =
  /^(?:ws-[a-z0-9_-]+|vm-[a-z0-9_-]+|[a-z0-9_-]+\.vm|[a-z0-9_-]+\.apps)$/;
/** Node-backend records: the only kind updated by id (heartbeat IP change). */
const NODE_BACKEND_SUFFIX = '.vm.';

const BUMP_SERIAL_SQL = 'UPDATE selfhost_dns_zone SET serial = serial + 1 WHERE id = 1';

export class BoxDnsRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BoxDnsRecordError';
  }
}

function zoneApex(env: BoxDnsEnv): string {
  const apex = (env.BASE_DOMAIN ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!apex) throw new BoxDnsRecordError('BASE_DOMAIN is not set, so the box has no DNS zone');
  return apex;
}

/**
 * The fully qualified, lowercase name for `name` in the box's zone. Like the Cloudflare API, a
 * name that does not already end in the zone is taken as relative to it (`ws-x` and `ab.vm` are
 * relative; app-route hostnames arrive fully qualified). Anything that is not a valid hostname is
 * refused rather than stored.
 */
export function boxRecordName(name: string, env: BoxDnsEnv): string {
  const apex = zoneApex(env);
  let fqdn = name.trim().toLowerCase().replace(/\.$/, '');
  if (fqdn !== apex && !fqdn.endsWith(`.${apex}`)) fqdn = `${fqdn}.${apex}`;
  if (fqdn.length > MAX_NAME_LENGTH || !fqdn.split('.').every((label) => LABEL_RE.test(label))) {
    throw new BoxDnsRecordError(`Not a valid DNS name for the box's zone: ${name.slice(0, 255)}`);
  }
  return fqdn;
}

function assertInNamespace(fqdn: string, env: BoxDnsEnv, pattern: RegExp, action: string): string {
  const apex = zoneApex(env);
  const relative = fqdn === apex ? '' : fqdn.slice(0, -(apex.length + 1));
  if (!pattern.test(relative)) {
    throw new BoxDnsRecordError(
      `The Worker may not ${action} ${fqdn.slice(0, 255)}: only ws-*, *.vm and *.apps names are its own`
    );
  }
  return fqdn;
}

function nodeBackendSuffix(env: BoxDnsEnv): string {
  return `${NODE_BACKEND_SUFFIX}${zoneApex(env)}`;
}

function assertIpv4(ip: string): string {
  const value = ip.trim();
  if (!IPV4_RE.test(value)) throw new BoxDnsRecordError(`Not an IPv4 address: ${ip.slice(0, 64)}`);
  return value;
}

/** Creates or replaces the A record for `name`; returns its id (kept when it already existed). */
export async function upsertBoxARecord(name: string, ip: string, env: BoxDnsEnv): Promise<string> {
  const fqdn = assertInNamespace(boxRecordName(name, env), env, WRITABLE_RELATIVE_NAME_RE, 'write');
  const content = assertIpv4(ip);
  const now = new Date().toISOString();
  const [upsert] = await env.DATABASE.batch([
    env.DATABASE.prepare(
      `INSERT INTO selfhost_dns_records (id, name, type, content, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(name, type) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at
       RETURNING id`
    ).bind(`box_${ulid()}`, fqdn, BOX_DNS_RECORD_TYPE, content, now, now),
    env.DATABASE.prepare(BUMP_SERIAL_SQL),
  ]);
  const id = (upsert?.results?.[0] as { id?: unknown } | undefined)?.id;
  if (typeof id !== 'string') throw new Error('Box DNS upsert returned no record id');
  return id;
}

/**
 * Points the node-backend record `id` at `ip`. Only node backends are updated by id (the heartbeat's
 * IP change, routes/node-heartbeat-ip.ts), so the predicate also requires that namespace: a stale or
 * wrong id cannot repoint an app route or a workspace record. A missing id is an error, as
 * Cloudflare's PATCH is.
 */
export async function updateBoxRecordContent(
  id: string,
  ip: string,
  env: BoxDnsEnv
): Promise<void> {
  const content = assertIpv4(ip);
  const [update] = await env.DATABASE.batch([
    env.DATABASE.prepare(
      `UPDATE selfhost_dns_records SET content = ?, updated_at = ?
       WHERE id = ? AND substr(name, -length(?)) = ?`
    ).bind(content, new Date().toISOString(), id, nodeBackendSuffix(env), nodeBackendSuffix(env)),
    env.DATABASE.prepare(BUMP_SERIAL_SQL),
  ]);
  if ((update?.meta?.changes ?? 0) === 0) {
    throw new BoxDnsRecordError(`No box node-backend DNS record with id ${id.slice(0, 64)}`);
  }
}

/** Deletes the record `id`. A missing id is success (Cloudflare's 404 is ignored too). */
export async function deleteBoxRecord(id: string, env: BoxDnsEnv): Promise<void> {
  await env.DATABASE.batch([
    env.DATABASE.prepare('DELETE FROM selfhost_dns_records WHERE id = ?').bind(id),
    env.DATABASE.prepare(BUMP_SERIAL_SQL),
  ]);
}

/** Deletes every record with this name; returns how many. */
export async function deleteBoxRecordsByName(name: string, env: BoxDnsEnv): Promise<number> {
  const [deleted] = await env.DATABASE.batch([
    env.DATABASE.prepare('DELETE FROM selfhost_dns_records WHERE name = ?').bind(
      assertInNamespace(boxRecordName(name, env), env, DELETABLE_RELATIVE_NAME_RE, 'delete')
    ),
    env.DATABASE.prepare(BUMP_SERIAL_SQL),
  ]);
  return deleted?.meta?.changes ?? 0;
}

/** The A records named `name`, in the shape the Cloudflare lookups return. */
export async function findBoxARecordsByName(
  name: string,
  env: BoxDnsEnv
): Promise<BoxDnsRecordMatch[]> {
  const result = await env.DATABASE.prepare(
    'SELECT id, name, type, content FROM selfhost_dns_records WHERE name = ? AND type = ? ORDER BY id'
  )
    .bind(boxRecordName(name, env), BOX_DNS_RECORD_TYPE)
    .all();
  const matches: BoxDnsRecordMatch[] = [];
  for (const row of result.results ?? []) {
    const record = parseRecordRow(row, 'find_by_name');
    if (record) matches.push({ ...record, proxied: false });
  }
  return matches;
}

export interface BoxDnsRecord {
  id: string;
  name: string;
  type: string;
  content: string;
}

/**
 * One stored row, or null (logged) when it is malformed: a single bad row must not stop the zone
 * from syncing (.claude/rules/50).
 */
export function parseRecordRow(row: unknown, context: string): BoxDnsRecord | null {
  const r = (row ?? {}) as Record<string, unknown>;
  const valid =
    typeof r.id === 'string' &&
    typeof r.name === 'string' &&
    r.type === BOX_DNS_RECORD_TYPE &&
    typeof r.content === 'string' &&
    IPV4_RE.test(r.content) &&
    r.name.length <= MAX_NAME_LENGTH &&
    r.name.split('.').every((label) => LABEL_RE.test(label));
  if (!valid) {
    log.warn('selfhost_dns.record_row_skipped', {
      context,
      recordId: typeof r.id === 'string' ? r.id.slice(0, 64) : null,
      name: typeof r.name === 'string' ? r.name.slice(0, 255) : null,
      type: typeof r.type === 'string' ? r.type.slice(0, 16) : null,
      action: 'skipped',
    });
    return null;
  }
  return {
    id: r.id as string,
    name: r.name as string,
    type: r.type as string,
    content: r.content as string,
  };
}

export interface BoxDnsZonePage {
  serial: number;
  records: Array<Pick<BoxDnsRecord, 'name' | 'type' | 'content'>>;
  /** Continue with `after` set to this; null when this page is the last. */
  nextCursor: string | null;
  /** Malformed rows left out of this page (logged), so a shrinking zone is visible to sam-dns. */
  skipped: number;
}

/** Keyset cursor over (name, type), the unique key, so pages never overlap or skip. */
function encodeCursor(name: string, type: string): string {
  return `${name}|${type}`;
}

function decodeCursor(cursor: string | null): { name: string; type: string } | null {
  if (!cursor) return null;
  const separator = cursor.lastIndexOf('|');
  if (separator <= 0) throw new BoxDnsRecordError('Malformed DNS records cursor');
  return { name: cursor.slice(0, separator), type: cursor.slice(separator + 1) };
}

/** The zone serial (bumped by every write). */
export async function readBoxZoneSerial(env: Pick<Env, 'DATABASE'>): Promise<number> {
  const row = await env.DATABASE.prepare(
    'SELECT serial FROM selfhost_dns_zone WHERE id = 1'
  ).first<{
    serial: unknown;
  }>();
  const serial = Number(row?.serial);
  if (!Number.isSafeInteger(serial)) throw new Error('The box DNS zone has no serial row');
  return serial;
}

/**
 * One page of the zone, read in one D1 batch with the serial so the two are consistent. A reader
 * that sees the serial change between its pages starts again.
 */
export async function readBoxZonePage(
  env: Pick<Env, 'DATABASE'>,
  after: string | null,
  limit: number
): Promise<BoxDnsZonePage> {
  const cursor = decodeCursor(after);
  const records = cursor
    ? env.DATABASE.prepare(
        `SELECT id, name, type, content FROM selfhost_dns_records
         WHERE (name, type) > (?, ?)
         ORDER BY name, type LIMIT ?`
      ).bind(cursor.name, cursor.type, limit + 1)
    : env.DATABASE.prepare(
        'SELECT id, name, type, content FROM selfhost_dns_records ORDER BY name, type LIMIT ?'
      ).bind(limit + 1);
  const [serialResult, recordsResult] = await env.DATABASE.batch([
    env.DATABASE.prepare('SELECT serial FROM selfhost_dns_zone WHERE id = 1'),
    records,
  ]);
  const serial = Number((serialResult?.results?.[0] as { serial?: unknown } | undefined)?.serial);
  if (!Number.isSafeInteger(serial)) throw new Error('The box DNS zone has no serial row');
  const rows = recordsResult?.results ?? [];
  const pageRows = rows.slice(0, limit);
  const page: BoxDnsZonePage['records'] = [];
  let skipped = 0;
  for (const row of pageRows) {
    const record = parseRecordRow(row, 'zone_page');
    if (record) page.push({ name: record.name, type: record.type, content: record.content });
    else skipped++;
  }
  const last = pageRows[pageRows.length - 1] as { name?: unknown; type?: unknown } | undefined;
  const nextCursor =
    rows.length > limit && typeof last?.name === 'string' && typeof last.type === 'string'
      ? encodeCursor(last.name, last.type)
      : null;
  return { serial, records: page, nextCursor, skipped };
}
