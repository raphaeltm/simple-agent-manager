/**
 * `PUT|GET /api/box-objects?token=...`: the self-hosted box's stand-in for S3 presigned URLs.
 *
 * The token (`tokens.ts`) names one R2 key and one operation; nothing in the request can name
 * another. A PUT streams the body into the R2 binding (celld writes it to the fleet bucket without
 * holding it in the isolate), bounded by the token's size and verified against its sha256 when it
 * carries one. The write is create-only, so a token cannot replace an object once written: atomic
 * (`onlyIf: { etagDoesNotMatch: '*' }`) up to celld's conditional-put size, and above it a check
 * that no object exists before the write (celld writes larger streams as multipart uploads, whose
 * completion takes no precondition). The gap that check leaves is only between two uploads with
 * the same token, which only its holder has. A retry of a write that already succeeded answers 200
 * when the token binds a sha256 the stored object matches (build contexts); otherwise 412.
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
  BOX_OBJECT_MAX_UPLOADS_PER_UPLOADER,
  BOX_OBJECT_UPLOAD_ADMISSION_WAIT_SECONDS,
  BOX_OBJECT_UPLOAD_IDLE_SECONDS,
  BOX_OBJECT_UPLOAD_LEASE_SECONDS,
  DEFAULT_BOX_OBJECT_MAX_CONCURRENT_UPLOADS,
  DEFAULT_BOX_OBJECT_MAX_UPLOADS_PER_UPLOADER,
  DEFAULT_BOX_OBJECT_UPLOAD_ADMISSION_WAIT_SECONDS,
  DEFAULT_BOX_OBJECT_UPLOAD_IDLE_SECONDS,
  DEFAULT_BOX_OBJECT_UPLOAD_LEASE_SECONDS,
} from './settings';
import { type BoxObjectTokenClaims, verifyBoxObjectToken } from './tokens';

type BoxObjectEnv = Env & BoxUploadGateEnv;

/**
 * Largest streamed body celld v0.6.3 can write with an `onlyIf` precondition. It refuses one above
 * this: "celld cannot apply `onlyIf` to a streamed body larger than 8388608 bytes, because it is
 * written as a multipart upload and a multipart completion takes no precondition" (live test).
 */
export const CELLD_CONDITIONAL_PUT_MAX_BYTES = 8 * 1024 * 1024;

type ErrorCode = 'REFUSED' | 'BUSY' | 'UNAVAILABLE' | 'UPLOAD_TIMEOUT' | 'UPLOAD_FAILED';

function plain(
  status: number,
  message: string,
  headers: Record<string, string> = {},
  error: ErrorCode = status === 503 ? 'BUSY' : 'REFUSED'
): Response {
  return Response.json({ error, message }, { status, headers });
}

/** Log fields that identify the request without the token. */
function logFields(claims: BoxObjectTokenClaims) {
  return { op: claims.op, key: claims.key, ...claims.sub };
}

interface UploadLimits {
  total: number;
  perUploader: number;
  leaseMs: number;
  idleMs: number;
  /** How long an upload over the limit waits for a slot (0: refuse at once). */
  admissionWaitMs: number;
}

/** How often a waiting upload asks the gate again (one cheap DO call each). */
const ADMISSION_POLL_MS = 1_000;

const DEFAULT_LIMITS: UploadLimits = {
  total: DEFAULT_BOX_OBJECT_MAX_CONCURRENT_UPLOADS,
  perUploader: DEFAULT_BOX_OBJECT_MAX_UPLOADS_PER_UPLOADER,
  leaseMs: DEFAULT_BOX_OBJECT_UPLOAD_LEASE_SECONDS * 1000,
  idleMs: DEFAULT_BOX_OBJECT_UPLOAD_IDLE_SECONDS * 1000,
  admissionWaitMs: DEFAULT_BOX_OBJECT_UPLOAD_ADMISSION_WAIT_SECONDS * 1000,
};

/** A non-negative integer setting (0 is meaningful), else its default. */
function nonNegativeSetting(value: unknown, fallback: number, scale = 1): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number * scale : fallback;
}

/** A positive integer setting, else its default: a missing value must never disable a bound. */
function setting(value: unknown, fallback: number, scale = 1): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number * scale : fallback;
}

async function uploadLimits(env: Env): Promise<UploadLimits> {
  try {
    const [total, lease, perUploader, idle, admissionWait] = await resolveAdminSettingDetailsMany(
      env,
      [
        BOX_OBJECT_MAX_CONCURRENT_UPLOADS,
        BOX_OBJECT_UPLOAD_LEASE_SECONDS,
        BOX_OBJECT_MAX_UPLOADS_PER_UPLOADER,
        BOX_OBJECT_UPLOAD_IDLE_SECONDS,
        BOX_OBJECT_UPLOAD_ADMISSION_WAIT_SECONDS,
      ]
    );
    return {
      total: setting(total?.value, DEFAULT_LIMITS.total),
      leaseMs: setting(lease?.value, DEFAULT_LIMITS.leaseMs, 1000),
      perUploader: setting(perUploader?.value, DEFAULT_LIMITS.perUploader),
      idleMs: setting(idle?.value, DEFAULT_LIMITS.idleMs, 1000),
      admissionWaitMs: nonNegativeSetting(
        admissionWait?.value,
        DEFAULT_LIMITS.admissionWaitMs,
        1000
      ),
    };
  } catch (error) {
    // Settings storage unavailable: the defaults still bound memory.
    log.warn('box_objects.limits_fallback', {
      error: error instanceof Error ? error.message : String(error),
    });
    return DEFAULT_LIMITS;
  }
}

/** Who holds a slot: the workspace an upload is for, else the user who asked for the URL. */
function uploader(claims: BoxObjectTokenClaims): string {
  return claims.sub?.w ? `w:${claims.sub.w}` : claims.sub?.u ? `u:${claims.sub.u}` : 'unknown';
}

interface Watchdog {
  stream: TransformStream<Uint8Array, Uint8Array>;
  /** Why the watchdog stopped the upload, if it did. */
  stopped: () => 'idle' | 'lease-lost' | null;
  /** Stops the upload because it no longer holds its slot. */
  loseLease: () => void;
  dispose: () => void;
}

/**
 * Passes bytes through. Errors the stream if none arrive for `idleMs` (the slot is then freed),
 * and calls `onProgress` at most every `progressEveryMs` while bytes keep arriving.
 */
function uploadWatchdog(idleMs: number, progressEveryMs: number, onProgress: () => void): Watchdog {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped: 'idle' | 'lease-lost' | null = null;
  let lastProgress = Date.now();
  let fail: (error: Error) => void = () => undefined;
  const dispose = () => clearTimeout(timer);
  const stop = (reason: 'idle' | 'lease-lost') => {
    if (stopped) return;
    stopped = reason;
    dispose();
    fail(new Error(`box upload stopped: ${reason}`));
  };
  const arm = () => {
    dispose();
    timer = setTimeout(() => stop('idle'), idleMs);
  };
  const stream = new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      fail = (error) => controller.error(error);
      arm();
    },
    transform(chunk, controller) {
      arm();
      if (Date.now() - lastProgress >= progressEveryMs) {
        lastProgress = Date.now();
        onProgress();
      }
      controller.enqueue(chunk);
    },
    flush: dispose,
    cancel: dispose,
  });
  return { stream, stopped: () => stopped, loseLease: () => stop('lease-lost'), dispose };
}

/**
 * True when the stored object is provably the one `claims` describes, so a retried PUT that
 * already succeeded can answer 200. Only a token that binds a sha256 can prove it: equal size
 * alone could be different bytes, and answering 200 would tell the client its bytes were stored.
 */
async function sameObject(env: Env, claims: BoxObjectTokenClaims, length: number) {
  if (!claims.sha) return false;
  const existing = await env.R2.head(claims.key);
  if (!existing || existing.size !== length) return false;
  const stored = existing.checksums?.sha256;
  const storedHex = stored
    ? [...new Uint8Array(stored)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    : existing.customMetadata?.sha256;
  return storedHex === claims.sha;
}

/** The object already exists: 200 for a provable retry of the same upload, else 412. */
async function conflict(env: Env, claims: BoxObjectTokenClaims, length: number) {
  if (await sameObject(env, claims, length)) {
    log.info('box_objects.upload_replayed', { ...logFields(claims), length });
    return new Response(null, { status: 200 });
  }
  log.warn('box_objects.upload_conflict', { ...logFields(claims), length, action: 'rejected' });
  return plain(412, 'An object was already written with this URL');
}

async function put(c: Context<{ Bindings: BoxObjectEnv }>, claims: BoxObjectTokenClaims) {
  const env = c.env;
  const declared = c.req.header('content-length') ?? '';
  // Digits only: Number() would also accept "1e3", "0x10" or " 12".
  if (!/^\d{1,16}$/.test(declared)) return plain(411, 'Content-Length is required');
  const length = Number(declared);
  const body = c.req.raw.body;
  if (claims.max !== undefined && length > claims.max) {
    return plain(413, `Upload is ${length} bytes; this URL accepts at most ${claims.max}`);
  }
  if (claims.len !== undefined && length !== claims.len) {
    return plain(400, `Upload is ${length} bytes; this URL was issued for ${claims.len}`);
  }
  if (!body && length > 0) return plain(400, 'Upload body is missing');

  const gate = boxUploadGate(env);
  if (!gate) {
    return plain(503, 'Box uploads are unavailable (no upload gate binding)', {}, 'UNAVAILABLE');
  }
  const configured = await uploadLimits(env);
  // A slot must outlive the longest pause the idle limit tolerates plus one renewal interval, or a
  // paused-but-live upload would lose it and run uncounted. Renewals come every leaseMs / 3, so a
  // lease of at least twice the idle limit always covers the gap (the settings allow any pair).
  const limits = { ...configured, leaseMs: Math.max(configured.leaseMs, 2 * configured.idleMs) };
  const leaseId = crypto.randomUUID();
  // Over the limit: wait (bounded) for a slot rather than fail an upload a moment too early.
  const admissionDeadline = Date.now() + limits.admissionWaitMs;
  let lease = await gate.acquire(leaseId, uploader(claims), claims.key, limits);
  while (!lease.granted && lease.reason === 'busy' && Date.now() < admissionDeadline) {
    const wait = Math.min(ADMISSION_POLL_MS, admissionDeadline - Date.now());
    await new Promise((resolve) => setTimeout(resolve, wait));
    lease = await gate.acquire(leaseId, uploader(claims), claims.key, limits);
  }
  if (!lease.granted && lease.reason === 'key-in-use') {
    // Another upload is creating this object right now: create-only, so this one cannot.
    log.warn('box_objects.upload_conflict', { ...logFields(claims), length, action: 'in_flight' });
    return plain(412, 'Another upload is writing this object');
  }
  if (!lease.granted) {
    log.warn('box_objects.upload_refused_busy', {
      ...logFields(claims),
      active: lease.active,
      limit: limits.total,
      perUploader: limits.perUploader,
    });
    return plain(503, 'The box is receiving as many uploads as it allows; retry shortly', {
      'Retry-After': String(lease.retryAfterSeconds),
    });
  }
  const watchdog = uploadWatchdog(limits.idleMs, Math.max(1000, limits.leaseMs / 3), () => {
    // Keep the slot while bytes arrive. A renewal that finds no lease means the slot was given up:
    // stop the upload rather than let it run uncounted. A failed RPC only shortens the slot to the
    // lease; the next renewal tries again.
    gate
      .renew(leaseId, limits.leaseMs)
      .then((held) => {
        if (!held) watchdog.loseLease();
      })
      .catch(() => undefined);
  });
  try {
    const atomic = length <= CELLD_CONDITIONAL_PUT_MAX_BYTES;
    if (!atomic && (await env.R2.head(claims.key))) return await conflict(env, claims, length);
    // FixedLengthStream makes a short or long body an error instead of a truncated object.
    const stream = body
      ? body.pipeThrough(watchdog.stream).pipeThrough(new FixedLengthStream(length))
      : new Uint8Array(0);
    let written: R2Object | null;
    try {
      written = await env.R2.put(claims.key, stream, {
        ...(atomic ? { onlyIf: { etagDoesNotMatch: '*' } } : {}),
        ...(claims.ct ? { httpMetadata: { contentType: claims.ct } } : {}),
        ...(claims.md ? { customMetadata: claims.md } : {}),
        ...(claims.sha ? { sha256: claims.sha } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn('box_objects.upload_failed', { ...logFields(claims), length, error: message });
      if (watchdog.stopped() === 'idle') {
        return plain(408, 'The upload stopped sending data', {}, 'UPLOAD_TIMEOUT');
      }
      if (watchdog.stopped() === 'lease-lost') {
        log.warn('box_objects.upload_lease_lost', { ...logFields(claims), length });
        return plain(503, 'The upload lost its slot; retry it', { 'Retry-After': '5' });
      }
      if (claims.sha && /sha-?256/i.test(message)) {
        return plain(400, 'Upload body does not match the declared sha256');
      }
      if (/FixedLengthStream|too (many|few) bytes|length/i.test(message)) {
        return plain(400, `Upload body did not match its Content-Length of ${length} bytes`);
      }
      return plain(502, 'The upload did not complete; retry it', {}, 'UPLOAD_FAILED');
    }
    if (!written) return await conflict(env, claims, length);
    log.info('box_objects.uploaded', { ...logFields(claims), length });
    return new Response(null, { status: 200, headers: { ETag: written.httpEtag } });
  } finally {
    watchdog.dispose();
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
  const headers = new Headers({
    'Content-Length': String(object.size),
    ETag: object.httpEtag,
    // The URL carries a bearer token: nothing in between may keep the response.
    'Cache-Control': 'private, no-store',
  });
  if (object.httpMetadata?.contentType)
    headers.set('Content-Type', object.httpMetadata.contentType);
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
