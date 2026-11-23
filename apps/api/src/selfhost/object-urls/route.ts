/**
 * `PUT|GET /api/box-objects?token=...`: the self-hosted box's stand-in for S3 presigned URLs.
 *
 * The token (`tokens.ts`) names one R2 key and one operation; nothing in the request can name
 * another. A PUT streams the body into the R2 binding (celld writes it to the fleet bucket without
 * holding it in the isolate), bounded by the token's size and verified against its sha256 when it
 * carries one. The write is create-only (`onlyIf: { etagDoesNotMatch: '*' }`), so a token cannot
 * replace an object once written; a retry of a write that already succeeded answers 200 when the
 * stored object is the one the token describes.
 *
 * No SAM session or callback credential is involved: the token is the credential, minted only by
 * routes that already authorized the caller for that key.
 */
import type { Context } from 'hono';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { resolveAdminSettingDetailsMany } from '../../services/admin-settings-resolution';
import { boxUploadGate, type BoxUploadGateEnv } from './gate';
import {
  BOX_OBJECT_MAX_CONCURRENT_UPLOADS,
  BOX_OBJECT_UPLOAD_LEASE_SECONDS,
  DEFAULT_BOX_OBJECT_MAX_CONCURRENT_UPLOADS,
  DEFAULT_BOX_OBJECT_UPLOAD_LEASE_SECONDS,
} from './settings';
import { type BoxObjectTokenClaims, verifyBoxObjectToken } from './tokens';

type BoxObjectEnv = Env & BoxUploadGateEnv;

function plain(status: number, message: string, headers: Record<string, string> = {}): Response {
  return Response.json({ error: status === 503 ? 'BUSY' : 'BOX_OBJECT_REFUSED', message }, {
    status,
    headers,
  });
}

/** Log fields that identify the request without the token. */
function logFields(claims: BoxObjectTokenClaims) {
  return { op: claims.op, key: claims.key, ...claims.sub };
}

async function uploadLimits(env: Env): Promise<{ limit: number; leaseMs: number }> {
  try {
    const [limit, lease] = await resolveAdminSettingDetailsMany(env, [
      BOX_OBJECT_MAX_CONCURRENT_UPLOADS,
      BOX_OBJECT_UPLOAD_LEASE_SECONDS,
    ]);
    return { limit: Number(limit?.value), leaseMs: Number(lease?.value) * 1000 };
  } catch {
    // Settings storage unavailable: the defaults still bound memory.
    return {
      limit: DEFAULT_BOX_OBJECT_MAX_CONCURRENT_UPLOADS,
      leaseMs: DEFAULT_BOX_OBJECT_UPLOAD_LEASE_SECONDS * 1000,
    };
  }
}

/** True when the stored object is the one `claims` describes (a retried, already-finished PUT). */
async function sameObject(env: Env, claims: BoxObjectTokenClaims, length: number) {
  const existing = await env.R2.head(claims.key);
  if (!existing || existing.size !== length) return false;
  if (!claims.sha) return true;
  const stored = existing.checksums?.sha256;
  const storedHex = stored
    ? [...new Uint8Array(stored)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    : existing.customMetadata?.sha256;
  return storedHex === claims.sha;
}

async function put(c: Context<{ Bindings: BoxObjectEnv }>, claims: BoxObjectTokenClaims) {
  const env = c.env;
  const length = Number(c.req.header('content-length'));
  const body = c.req.raw.body;
  if (!c.req.header('content-length') || !Number.isSafeInteger(length) || length < 0) {
    return plain(411, 'Content-Length is required');
  }
  if (claims.max !== undefined && length > claims.max) {
    return plain(413, `Upload is ${length} bytes; this URL accepts at most ${claims.max}`);
  }
  if (claims.len !== undefined && length !== claims.len) {
    return plain(400, `Upload is ${length} bytes; this URL was issued for ${claims.len}`);
  }
  if (!body && length > 0) return plain(400, 'Upload body is missing');

  const gate = boxUploadGate(env);
  if (!gate) return plain(503, 'Box uploads are unavailable (no upload gate binding)');
  const { limit, leaseMs } = await uploadLimits(env);
  const leaseId = crypto.randomUUID();
  const lease = await gate.acquire(leaseId, limit, leaseMs);
  if (!lease.granted) {
    log.warn('box_objects.upload_refused_busy', { ...logFields(claims), active: lease.active, limit });
    return plain(503, `The box is already receiving ${lease.active} uploads; retry shortly`, {
      'Retry-After': String(lease.retryAfterSeconds),
    });
  }
  try {
    // FixedLengthStream makes a short or long body an error instead of a truncated object.
    const stream = body ? body.pipeThrough(new FixedLengthStream(length)) : new Uint8Array(0);
    let written: R2Object | null;
    try {
      written = await env.R2.put(claims.key, stream, {
        onlyIf: { etagDoesNotMatch: '*' },
        ...(claims.ct ? { httpMetadata: { contentType: claims.ct } } : {}),
        ...(claims.md ? { customMetadata: claims.md } : {}),
        ...(claims.sha ? { sha256: claims.sha } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn('box_objects.upload_failed', { ...logFields(claims), length, error: message });
      return claims.sha && /sha-?256/i.test(message)
        ? plain(400, 'Upload body does not match the declared sha256')
        : plain(502, 'The upload did not complete; retry it');
    }
    if (!written) {
      if (await sameObject(env, claims, length)) {
        log.info('box_objects.upload_replayed', { ...logFields(claims), length });
        return new Response(null, { status: 200 });
      }
      log.warn('box_objects.upload_conflict', { ...logFields(claims), length, action: 'rejected' });
      return plain(412, 'An object was already written with this URL');
    }
    log.info('box_objects.uploaded', { ...logFields(claims), length });
    return new Response(null, { status: 200, headers: { ETag: written.httpEtag } });
  } finally {
    await gate.release(leaseId).catch((error: unknown) => {
      // The lease expires on its own; a failed release only delays the slot.
      log.warn('box_objects.lease_release_failed', {
        ...logFields(claims),
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

async function get(c: Context<{ Bindings: BoxObjectEnv }>, claims: BoxObjectTokenClaims) {
  const object = await c.env.R2.get(claims.key);
  if (!object) return plain(404, 'Object not found');
  const headers = new Headers({ 'Content-Length': String(object.size), ETag: object.httpEtag });
  if (object.httpMetadata?.contentType) headers.set('Content-Type', object.httpMetadata.contentType);
  log.info('box_objects.downloaded', { ...logFields(claims), length: object.size });
  return new Response(object.body, { status: 200, headers });
}

export async function handleBoxObjectRequest(
  c: Context<{ Bindings: BoxObjectEnv }>
): Promise<Response> {
  const method = c.req.method;
  if (method !== 'PUT' && method !== 'GET') return plain(405, 'Use PUT or GET');
  const claims = await verifyBoxObjectToken(c.env, c.req.query('token') ?? '');
  if (!claims || claims.op !== method.toLowerCase()) {
    // One answer for forged, expired and wrong-operation tokens: nothing to tell them apart.
    log.warn('box_objects.token_refused', { method, action: 'rejected' });
    return plain(403, 'This upload URL is invalid or has expired');
  }
  return claims.op === 'put' ? put(c, claims) : get(c, claims);
}
