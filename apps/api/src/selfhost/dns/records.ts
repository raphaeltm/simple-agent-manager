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
import { maybeJsonRecord } from '../../lib/runtime-validation';
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
  const id = maybeJsonRecord(upsert?.results?.[0])?.id;
  if (typeof id !== 'string') throw new Error('Box DNS upsert returned no record id');
  return id;
}

/**
 * Creates the A record for `name` unless one exists, without ever replacing it: the durable node
 * provisioning replay must not overwrite a concurrent allocation's record (rule 75 §7). Returns
 * the new id, or null when a record was already there. The serial is bumped either way (harmless).
 */
export async function insertBoxARecordIfAbsent(
  name: string,
  ip: string,
  env: BoxDnsEnv
): Promise<string | null> {
  const fqdn = assertInNamespace(boxRecordName(name, env), env, WRITABLE_RELATIVE_NAME_RE, 'write');
  const content = assertIpv4(ip);
  const now = new Date().toISOString();
  const [insert] = await env.DATABASE.batch([
    env.DATABASE.prepare(
      `INSERT INTO selfhost_dns_records (id, name, type, content, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(name, type) DO NOTHING
       RETURNING id`
    ).bind(`box_${ulid()}`, fqdn, BOX_DNS_RECORD_TYPE, content, now, now),
    env.DATABASE.prepare(BUMP_SERIAL_SQL),
  ]);
  const id = maybeJsonRecord(insert?.results?.[0])?.id;
  return typeof id === 'string' ? id : null;
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

/**
 * One page (1-based, ordered by name) of the A records whose name ends in `nameSuffix`, and
 * optionally whose content is `content`: the box side of the app-route DNS reconciliation list
 * (`services/dns-app-route-inventory.ts`). The suffix is compared with `substr`, not `LIKE`, so
 * no character in it is a wildcard.
 */
export async function listBoxARecords(
  filter: { nameSuffix: string; content?: string; page: number; perPage: number },
  env: BoxDnsEnv
): Promise<{ records: BoxDnsRecordMatch[]; rowCount: number }> {
  const suffix = filter.nameSuffix.trim().toLowerCase();
  if (!suffix) throw new BoxDnsRecordError('A record list needs a name suffix');
  const perPage = Math.max(1, Math.floor(filter.perPage));
  const offset = (Math.max(1, Math.floor(filter.page)) - 1) * perPage;
  const result = await env.DATABASE.prepare(
    `SELECT id, name, type, content FROM selfhost_dns_records
     WHERE type = ? AND length(name) > length(?) AND substr(name, -length(?)) = ?
       AND (? IS NULL OR content = ?)
     ORDER BY name, id LIMIT ? OFFSET ?`
  )
    .bind(
      BOX_DNS_RECORD_TYPE,
      suffix,
      suffix,
      suffix,
      filter.content ?? null,
      filter.content ?? null,
      perPage,
      offset
    )
    .all();
  const rows = result.results ?? [];
  const records: BoxDnsRecordMatch[] = [];
  for (const row of rows) {
    const record = parseRecordRow(row, 'list_by_suffix');
    if (record) records.push({ ...record, proxied: false });
  }
  // The raw row count: a malformed row dropped above must not make a full page look like the last.
  return { records, rowCount: rows.length };
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
  const r = maybeJsonRecord(row) ?? {};
  const { id, name, type, content } = r;
  if (
    typeof id === 'string' &&
    typeof name === 'string' &&
    type === BOX_DNS_RECORD_TYPE &&
    typeof content === 'string' &&
    IPV4_RE.test(content) &&
    name.length <= MAX_NAME_LENGTH &&
    name.split('.').every((label) => LABEL_RE.test(label))
  ) {
    return { id, name, type, content };
  }
  // Which field failed, never the rejected value itself (rule 50: diagnosable without the row).
  const invalidFields = [
    typeof id === 'string' ? null : 'id',
    typeof name === 'string' &&
    name.length <= MAX_NAME_LENGTH &&
    name.split('.').every((label) => LABEL_RE.test(label))
      ? null
      : 'name',
    type === BOX_DNS_RECORD_TYPE ? null : 'type',
    typeof content === 'string' && IPV4_RE.test(content) ? null : 'content',
  ].filter((field): field is string => field !== null);
  log.warn('selfhost_dns.record_row_skipped', {
    context,
    invalidFields,
    recordId: typeof id === 'string' ? id.slice(0, 64) : null,
    name: typeof name === 'string' ? name.slice(0, 255) : null,
    type: typeof type === 'string' ? type.slice(0, 16) : null,
    action: 'skipped',
  });
  return null;
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
  const serial = Number(maybeJsonRecord(serialResult?.results?.[0])?.serial);
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
  const last = maybeJsonRecord(pageRows[pageRows.length - 1]);
  const nextCursor =
    rows.length > limit && typeof last?.name === 'string' && typeof last.type === 'string'
      ? encodeCursor(last.name, last.type)
      : null;
  return { serial, records: page, nextCursor, skipped };
}
