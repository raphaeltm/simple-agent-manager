/**
 * `GET /api/self-host/gateway/dns-records`: the box's sam-dns sidecar (deploy/selfhost/sam-dns)
 * reads the zone it serves. Read-only; sam-dns answers DNS queries from its own copy and never
 * calls the Worker per query.
 *
 * Request: header `X-SAM-Gateway-Secret` (REVERSE_TUNNEL_GATEWAY_SECRET, as for every gateway
 * route), query `serial` (the serial sam-dns already holds, optional), `after` (the previous
 * page's `nextCursor`), `limit` (page size, 1..BOX_DNS_SYNC_MAX_PAGE_SIZE).
 *
 * Response 200:
 * - `{ serial, unchanged: true }` when `serial` matches and no `after` is given (one D1 read);
 * - else `{ serial, records: [{name, type, content}], nextCursor, skipped }` (`skipped`: malformed
 *   rows left out of the page, logged). Each page carries the serial
 *   it was read with; sam-dns starts over if the serial changes between its pages.
 *
 * Trust: only box processes reach this route (Caddy answers 404 for the gateway prefix publicly,
 * caddy/sam.d/frp.caddy). Fails closed: 404 without a gateway secret (every Cloudflare deployment)
 * or while the box zone is off (SAM_DNS_PROVIDER is not "box"), 401 for a wrong secret.
 */
import type { Context } from 'hono';

import { log } from '../../lib/logger';
import { getReverseTunnelGatewaySecret, isAcceptedGatewaySecret } from '../reverse-tunnel/config';
import type { ReverseTunnelEnv } from '../reverse-tunnel/env';
import { isBoxDnsEnabled } from './index';
import { BoxDnsRecordError, readBoxZonePage, readBoxZoneSerial } from './records';

export const DNS_RECORDS_GATEWAY_SECRET_HEADER = 'X-SAM-Gateway-Secret';
/** Default page when sam-dns asks for none. */
export const BOX_DNS_SYNC_DEFAULT_PAGE_SIZE = 500;
/**
 * Protocol ceiling, not a tunable: sam-dns chooses its page size (SAM_DNS_SYNC_PAGE_SIZE) within
 * it. 1000 rows of at most ~300 bytes keeps a page well under a megabyte, and D1 reads it in one
 * statement.
 */
export const BOX_DNS_SYNC_MAX_PAGE_SIZE = 1000;

function json(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status });
}

function pageSize(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return BOX_DNS_SYNC_DEFAULT_PAGE_SIZE;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return value >= 1 && value <= BOX_DNS_SYNC_MAX_PAGE_SIZE ? value : null;
}

export async function handleDnsRecordsGateway(
  c: Context<{ Bindings: ReverseTunnelEnv }>
): Promise<Response> {
  if (!getReverseTunnelGatewaySecret(c.env) || !isBoxDnsEnabled(c.env)) {
    return json({ error: 'NOT_FOUND', message: 'Not found' }, 404);
  }
  if (!isAcceptedGatewaySecret(c.env, c.req.header(DNS_RECORDS_GATEWAY_SECRET_HEADER) ?? '')) {
    log.warn('self_host_gateway.dns_records_unauthenticated', { action: 'rejected' });
    return json({ error: 'UNAUTHORIZED', message: 'Gateway authentication failed' }, 401);
  }
  const limit = pageSize(c.req.query('limit'));
  if (limit === null) {
    return json(
      { error: 'BAD_REQUEST', message: `limit must be 1-${BOX_DNS_SYNC_MAX_PAGE_SIZE}` },
      400
    );
  }
  const after = c.req.query('after') || null;
  const known = c.req.query('serial');
  if (!after && known && /^\d+$/.test(known)) {
    const serial = await readBoxZoneSerial(c.env);
    if (serial === Number(known)) return json({ serial, unchanged: true });
  }
  try {
    const page = await readBoxZonePage(c.env, after, limit);
    return json({ ...page });
  } catch (error) {
    if (error instanceof BoxDnsRecordError) {
      return json({ error: 'BAD_REQUEST', message: error.message }, 400);
    }
    throw error;
  }
}
