/**
 * One SAM-hosted git repository: a Durable Object speaking git smart HTTP.
 *
 * Adapted from dgit's `RepoCell` (https://github.com/littledivy/durable-git, MIT, commit
 * d5eba04, see `src/vendor/dgit/UPSTREAM.md`): the git protocol paths, delete and the GC alarm.
 * Dropped: the web UI, R2 pack offload and the content API. Added: SAM's push and repository caps
 * (`services/hosted-git/limits.ts`), checked before a pack is stored.
 *
 * Authentication is NOT done here. The only caller is `services/hosted-git/http.ts`, which checks
 * SAM's repository token on every request before forwarding to this object. The object is
 * addressed by `idFromName(<repository name>)`, so one repository is one object.
 */
import { DurableObject } from 'cloudflare:workers';

import { log } from '../lib/logger';
import {
  DEFAULT_HOSTED_GIT_LIMITS,
  hostedGitPushByteBudget,
  hostedGitPushRefusal,
  hostedGitPushTooLargeMessage,
} from '../services/hosted-git/limits';
import { ObjCache } from '../vendor/dgit/git/packstore';
import {
  advertisement,
  commitPush,
  parsePushCommands,
  renderStatus,
  type Service,
  sidebandFrames,
  uploadPack,
  validatePush,
} from '../vendor/dgit/git/protocol';
import { GitStore } from '../vendor/dgit/git/store';
import { concat, td, te } from '../vendor/dgit/git/util';
import { gunzipLimited } from '../vendor/dgit/git/zlib';

/** An upload-pack request is wants/haves/caps only. */
const MAX_UPLOAD_PACK_BYTES = 16 * 1024 * 1024;
/** Concurrent clone/fetch walks contend on one event loop. */
const MAX_ACTIVE_UPLOADS = 4;
/** Decompressed objects held for delta-base resolution during one push. */
const INGEST_CACHE_BYTES = 32 * 1024 * 1024;
const GC_DELAY_MS = 5 * 60 * 1000;
const PACK_HEADER_BYTES = 12;
/** The pkt-line command section of a push (ref updates + capabilities) before the pack. */
const MAX_COMMAND_SECTION_BYTES = 1024 * 1024;
const PKT_LENGTH = /^[0-9a-f]{4}$/i;

class RequestTooLargeError extends Error {
  constructor() {
    super('request body exceeds maximum size');
  }
}

/**
 * A pkt-line length: exactly four hex digits. 0 is a flush packet; 1-3 are invalid. `parseInt`
 * alone would accept "-004" and walk the parser backwards forever (security review, HIGH).
 */
function pktLength(bytes: Uint8Array): number {
  const text = td.decode(bytes);
  if (!PKT_LENGTH.test(text)) throw new Error('bad pkt-line in push request');
  const len = parseInt(text, 16);
  if (len !== 0 && len < 4) throw new Error('bad pkt-line in push request');
  return len;
}

/** Read a whole request body, refusing (without buffering further) past `maxBytes`. */
async function readBodyBounded(req: Request, maxBytes: number): Promise<Uint8Array> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new RequestTooLargeError();
    }
    parts.push(value);
  }
  return concat(parts);
}

/** Discard up to `maxBytes` of a request body, then cancel whatever is left. */
async function drainBounded(
  reader: ReadableStreamDefaultReader<Uint8Array> | null,
  maxBytes: number
): Promise<void> {
  if (!reader) return;
  let drained = 0;
  try {
    while (drained <= maxBytes) {
      const { done, value } = await reader.read();
      if (done) return;
      drained += value?.byteLength ?? 0;
    }
    await reader.cancel();
  } catch {
    // The client may already be gone.
  }
}

export class HostedGitRepo extends DurableObject {
  private store: GitStore;
  /** Pushes are serialized: concurrent ingests would race pack-id allocation. */
  private receiveChain: Promise<void> = Promise.resolve();
  private activeUploads = 0;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.store = new GitStore(ctx.storage.sql);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (path === '/info/refs' && req.method === 'GET') {
        const service = url.searchParams.get('service');
        if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
          return new Response('smart HTTP only\n', { status: 400 });
        }
        const v2 = req.headers
          .get('git-protocol')
          ?.split(':')
          .some((value) => value.trim() === 'version=2');
        return new Response(advertisement(this.store, service as Service, v2), {
          headers: {
            'content-type': `application/x-${service}-advertisement`,
            'cache-control': 'no-cache',
          },
        });
      }
      if (path === '/git-upload-pack' && req.method === 'POST') {
        return await this.upload(req);
      }
      if (path === '/git-receive-pack' && req.method === 'POST') {
        return await this.receive(req);
      }
      if (path === '/init' && req.method === 'PUT') {
        const body = (await req.json().catch(() => ({}))) as { defaultBranch?: unknown };
        const branch = typeof body.defaultBranch === 'string' ? body.defaultBranch : 'main';
        this.store.setHead(`refs/heads/${branch}`);
        this.store.setMeta('created', '1');
        return Response.json({ ok: true });
      }
      if (path === '/info' && req.method === 'GET') {
        return Response.json({
          exists: this.store.getMeta('created') === '1',
          head: this.store.head(),
          objects: this.store.objectCount(),
          bytes: this.store.dbSize(),
        });
      }
      if (path === '/' && req.method === 'DELETE') {
        await this.ctx.blockConcurrencyWhile(async () => {
          // wipe() drops dgit's tables. Not storage.deleteAll(): on celld that also sweeps the
          // replication control tables and breaks WAL capture for the cell (upstream note).
          this.store.wipe();
          await this.ctx.storage.deleteAlarm();
          this.store = new GitStore(this.ctx.storage.sql);
        });
        return new Response('deleted\n');
      }
      return new Response('not found\n', { status: 404 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('hosted_git.request_failed', { path, method: req.method, error: msg });
      return new Response('error: the repository could not process this request\n', {
        status: 500,
      });
    }
  }

  async alarm(): Promise<void> {
    if (this.store.getMeta('gc-pending') !== '1') return;
    if (this.activeUploads > 0) {
      await this.ctx.storage.setAlarm(Date.now() + 30_000).catch(() => undefined);
      return;
    }
    this.store.setMeta('gc-pending', '0');
    // dgit's GC (repacking loose objects) is not vendored; packs stay as pushed. The flag is
    // cleared so the alarm does not re-arm. Orphaned pack rows are swept at the next push.
  }

  private async upload(req: Request): Promise<Response> {
    const declared = parseInt(req.headers.get('content-length') ?? '', 10);
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_PACK_BYTES) {
      return new Response('error: fetch request too large\n', { status: 413 });
    }
    if (this.activeUploads >= MAX_ACTIVE_UPLOADS) {
      return new Response('busy: too many concurrent fetches, retry shortly\n', {
        status: 503,
        headers: { 'retry-after': '15' },
      });
    }
    // The slot spans the whole response stream; release() fires once from close/cancel.
    this.activeUploads++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.activeUploads--;
    };
    try {
      let body = await readBodyBounded(req, MAX_UPLOAD_PACK_BYTES);
      if (req.headers.get('content-encoding')?.includes('gzip')) {
        body = gunzipLimited(body, MAX_UPLOAD_PACK_BYTES);
      }
      return await uploadPack(this.store, body, release);
    } catch (err) {
      release();
      if (
        err instanceof RequestTooLargeError ||
        (err instanceof Error && err.message.includes('exceeds maximum size'))
      ) {
        return new Response('error: fetch request too large\n', { status: 413 });
      }
      throw err;
    }
  }

  /**
   * The response is returned only after processing completes: returning a stream early lets
   * celld treat the request as finished and evict the cell mid-ingest (upstream note).
   */
  private async receive(req: Request): Promise<Response> {
    const limits = DEFAULT_HOSTED_GIT_LIMITS;
    const declared = parseInt(req.headers.get('content-length') ?? '', 10);
    if (Number.isFinite(declared) && declared > limits.maxPushBytes) {
      return new Response(`error: ${hostedGitPushTooLargeMessage(limits.maxPushBytes)}\n`, {
        status: 413,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    const chunks: Uint8Array[] = [];
    const run = this.receiveChain.then(() => this.processReceive(req, (c) => chunks.push(c)));
    this.receiveChain = run.then(
      () => undefined,
      () => undefined
    );
    try {
      await run;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('hosted_git.receive_failed', { error: msg });
      if (err instanceof RequestTooLargeError) {
        return new Response(`error: ${hostedGitPushTooLargeMessage(limits.maxPushBytes)}\n`, {
          status: 413,
        });
      }
      // Malformed requests are the client's fault; keep the detail out of the response.
      const status = /pkt-line|push request|command section/.test(msg) ? 400 : 500;
      return new Response(
        status === 400
          ? 'error: malformed push request\n'
          : 'error: the push could not be processed\n',
        { status }
      );
    }
    return new Response(concat(chunks), {
      headers: {
        'content-type': 'application/x-git-receive-pack-result',
        'cache-control': 'no-cache',
      },
    });
  }

  private async processReceive(req: Request, emit: (chunk: Uint8Array) => void): Promise<void> {
    const limits = DEFAULT_HOSTED_GIT_LIMITS;
    const currentBytes = this.store.dbSize();
    const maxBytes = hostedGitPushByteBudget(currentBytes, limits);
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let buf: Uint8Array;
    if (req.headers.get('content-encoding')?.includes('gzip')) {
      buf = gunzipLimited(await readBodyBounded(req, limits.maxPushBytes), limits.maxPushBytes);
    } else {
      reader = req.body?.getReader() ?? null;
      buf = new Uint8Array(0);
    }

    // The pkt-line command section is small; everything after it is the pack.
    let pos = 0;
    const need = async (n: number): Promise<boolean> => {
      while (buf.length - pos < n) {
        if (!reader) return false;
        const { done, value } = await reader.read();
        if (done) return false;
        if (value?.length) buf = concat([buf, value]);
      }
      return true;
    };
    for (;;) {
      if (!(await need(4))) break;
      const len = pktLength(buf.subarray(pos, pos + 4));
      if (len === 0) {
        pos += 4;
        break;
      }
      if (pos + len > MAX_COMMAND_SECTION_BYTES) throw new Error('push command section too large');
      if (!(await need(len))) throw new Error('truncated push request');
      pos += len;
    }
    const { commands, caps } = parsePushCommands(buf.subarray(0, pos));
    const sideband = caps.includes('side-band-64k');
    const progress = (msg: string) => {
      if (!sideband) return;
      for (const f of sidebandFrames(2, te.encode(msg))) emit(f);
    };

    // Read up to the pack header so the declared object count can be checked before storing.
    const packStart = pos;
    const hasPack = (await need(PACK_HEADER_BYTES)) || buf.length > packStart;
    let unpackError: string | null = null;
    let packId: number | null = null;
    if (hasPack) {
      const header = buf.subarray(packStart, packStart + PACK_HEADER_BYTES);
      const incomingObjects =
        header.length === PACK_HEADER_BYTES
          ? new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(8)
          : 0;
      const refusal = hostedGitPushRefusal(
        { objects: this.store.objectCount(), bytes: currentBytes },
        incomingObjects,
        limits
      );
      if (refusal) {
        unpackError = refusal;
      } else {
        try {
          const ingested = await this.store.packs.ingest(buf.subarray(packStart), reader, {
            maxBytes,
            sizeHint: Number.isFinite(parseInt(req.headers.get('content-length') ?? '', 10))
              ? parseInt(req.headers.get('content-length') ?? '', 10)
              : undefined,
            cache: new ObjCache(INGEST_CACHE_BYTES),
            onProgress: progress,
            flush: () => this.ctx.storage.sync(),
            collisionDetect: false,
          });
          packId = ingested.packId;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          unpackError = msg.includes('exceeds maximum push size')
            ? hostedGitPushTooLargeMessage(maxBytes)
            : msg;
        }
      }
      if (unpackError) {
        log.warn('hosted_git.push_refused', { reason: unpackError });
        progress(`${unpackError}\n`);
        // Read (and discard) the rest of the upload before answering: a response sent while the
        // client is still uploading resets the connection, and git then shows "remote end hung up"
        // instead of the reason. Bounded, so a refused client cannot keep the cell busy forever.
        await drainBounded(reader, limits.maxPushBytes * 2);
      }
    }

    const plan = await validatePush(this.store, commands, unpackError, packId);
    const { results, changed, needsGc } = this.ctx.storage.transactionSync(() =>
      commitPush(this.store, plan)
    );
    if (changed) {
      this.store.setMeta('created', '1');
      this.store.setMeta('last-push', String(Date.now()));
    }
    if (needsGc) {
      this.store.setMeta('gc-pending', '1');
      await this.ctx.storage.setAlarm(Date.now() + GC_DELAY_MS).catch(() => undefined);
    }
    if (caps.includes('report-status')) emit(renderStatus(results, unpackError, sideband));
  }
}
