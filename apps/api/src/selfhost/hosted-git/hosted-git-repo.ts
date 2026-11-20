/**
 * One SAM-hosted git repository: a Durable Object speaking git smart HTTP.
 *
 * Adapted from dgit's `RepoCell` (https://github.com/littledivy/durable-git, MIT, commit
 * d5eba04, see `src/vendor/dgit/UPSTREAM.md`): the git protocol paths, delete and the GC alarm.
 * Dropped: the web UI, R2 pack offload and the content API. GC lives in `hosted-git-gc.ts`. Added: SAM's push and repository caps
 * (`selfhost/hosted-git/limits.ts`), checked before a pack is stored.
 *
 * Authentication is NOT done here. The only caller is `selfhost/hosted-git/http.ts`, which checks
 * SAM's repository token on every request before forwarding to this object. The object is
 * addressed by `idFromName(<repository name>)`, so one repository is one object.
 */
import { DurableObject } from 'cloudflare:workers';

import { log } from '../../lib/logger';
import { maybeJsonRecord } from '../../lib/runtime-validation';
import { bindGitResponse, readGitChunk, withGitWorkBudget } from '../../vendor/dgit/git/budget';
import { ObjCache } from '../../vendor/dgit/git/packstore';
import {
  advertisement,
  commitPush,
  parsePushCommands,
  renderStatus,
  type Service,
  sidebandFrames,
  uploadPack,
  validatePush,
} from '../../vendor/dgit/git/protocol';
import { GitStore } from '../../vendor/dgit/git/store';
import { concat, te } from '../../vendor/dgit/git/util';
import { gunzipLimited } from '../../vendor/dgit/git/zlib';
import type { HostedGitEnv } from './env';
import {
  ChunkBuffer,
  drainBounded,
  pktLength,
  readBodyBounded,
  RequestTooLargeError,
} from './hosted-git-body';
import {
  armHostedGitGcAlarm,
  GC_DELAY_MS,
  type HostedGitGcResult,
  queueHostedGitGc,
  runHostedGitGc,
} from './hosted-git-gc';
import { filterLsRefsResponse, lsRefsPrefixes } from './hosted-git-ls-refs';
import {
  type HostedGitLimits,
  hostedGitPushByteBudget,
  hostedGitPushRefusal,
  hostedGitPushTooLargeMessage,
  hostedGitRefRefusal,
  hostedGitStoredOverCapMessage,
} from './limits';
import { resolveHostedGitLimits } from './policy';
import { HostedGitUploads } from './uploads';

/** An upload-pack request is wants/haves/caps only. */
const MAX_UPLOAD_PACK_BYTES = 16 * 1024 * 1024;
/** Concurrent clone/fetch walks contend on one event loop. */
const MAX_ACTIVE_UPLOADS = 4;
/** Decompressed objects held for delta-base resolution during one push. */
const INGEST_CACHE_BYTES = 32 * 1024 * 1024;
const PACK_HEADER_BYTES = 12;
/** The pkt-line command section of a push (ref updates + capabilities) before the pack. */
const MAX_COMMAND_SECTION_BYTES = 1024 * 1024;
export class HostedGitRepo extends DurableObject {
  private store: GitStore;
  private readonly settingsEnv: HostedGitEnv;
  /** Pushes are serialized: concurrent ingests would race pack-id allocation. */
  private receiveChain: Promise<void> = Promise.resolve();
  private activeUploads = 0;
  private readonly uploads = new HostedGitUploads();
  private deletion: Promise<void> | undefined;
  private deleting = false;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    // celld supplies the same installation bindings to this class as its Worker.
    this.settingsEnv = env as HostedGitEnv;
    this.store = new GitStore(ctx.storage.sql);
  }

  async fetch(req: Request): Promise<Response> {
    const limits = await resolveHostedGitLimits(this.settingsEnv);
    return withGitWorkBudget(limits, async () => bindGitResponse(await this.handleFetch(req)));
  }

  private async handleFetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (path === '/' && req.method === 'DELETE') {
        this.deleting = true;
        this.deletion ??= this.receiveChain
          .then(async () => {
            await this.uploads.close();
            await this.ctx.blockConcurrencyWhile(async () => {
              // Preserve celld replication control tables; deleteAll would remove them.
              this.store.setMeta('deleted', '1');
              this.ctx.storage.transactionSync(() => {
                this.store.wipe();
                this.store = new GitStore(this.ctx.storage.sql);
                this.store.setMeta('deleted', '1');
              });
              await this.ctx.storage.deleteAlarm();
            });
          })
          .catch((error) => {
            this.deletion = undefined;
            throw error;
          });
        this.receiveChain = this.deletion.catch(() => undefined);
        await this.deletion;
        return new Response('deleted\n');
      }
      if (this.deleting || this.store.getMeta('deleted') === '1')
        return new Response('repository deleted\n', { status: 410 });
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
        const body = maybeJsonRecord(await req.json().catch(() => null));
        const branch = typeof body?.defaultBranch === 'string' ? body.defaultBranch : 'main';
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
          reachableCache: this.store.reachableCacheValid(),
        });
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
    const limits = await resolveHostedGitLimits(this.settingsEnv);
    return withGitWorkBudget(limits, () => this.runAlarm(limits));
  }

  private async runAlarm(limits: HostedGitLimits): Promise<void> {
    if (this.deleting || this.store.getMeta('gc-pending') !== '1') return;
    // GC drops packs: never while a clone is streaming. Leave gc-pending set and retry.
    if (this.activeUploads > 0) {
      await this.ctx.storage.setAlarm(Date.now() + 30_000).catch(() => undefined);
      return;
    }
    try {
      const result = await this.gc(limits);
      log.info('hosted_git.gc', { ...result });
    } catch (err) {
      log.error('hosted_git.gc_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** GC serialized behind pushes and with no other request interleaving (it resets packs). */
  private gc(limits: HostedGitLimits): Promise<HostedGitGcResult> {
    let result: HostedGitGcResult = { removed: 0, kept: 0 };
    let failure: unknown;
    let failed = false;
    const run = this.receiveChain.then(() =>
      this.ctx.blockConcurrencyWhile(async () => {
        try {
          // Recheck after acquiring the push slot: a clone may have started while GC queued.
          if (this.activeUploads > 0) {
            this.store.setMeta('gc-pending', '1');
            await this.ctx.storage.setAlarm(Date.now() + GC_DELAY_MS);
            return;
          }
          await this.store.packs.cleanupOrphans();
          result = await runHostedGitGc(this.store);
          this.store.setMeta('gc-pending', '0');
          this.store.setMeta('gc-attempts', '0');
        } catch (err) {
          // Rejecting blockConcurrencyWhile resets a DO before the outer alarm can retain retry
          // intent. Carry the failure out after the input gate completes successfully instead.
          const attempts = Number(this.store.getMeta('gc-attempts') ?? '0') + 1;
          this.store.setMeta('gc-attempts', String(attempts));
          // Keep repairable work pending, but stop automatic retries at the configured budget.
          this.store.setMeta('gc-pending', attempts < limits.maxGcAttempts ? '1' : 'failed');
          if (attempts < limits.maxGcAttempts) {
            await this.ctx.storage.setAlarm(Date.now() + GC_DELAY_MS).catch(() => {
              log.error('hosted_git.gc_retry_schedule_failed');
            });
          }
          failure = err;
          failed = true;
        }
      })
    );
    this.receiveChain = run.then(
      () => undefined,
      () => undefined
    );
    return run.then(() => {
      if (failed) throw failure;
      return result;
    });
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
    const slot = this.uploads.start();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.activeUploads--;
      slot.release();
    };
    try {
      let body = await readBodyBounded(req, MAX_UPLOAD_PACK_BYTES);
      if (this.deleting) {
        release();
        return new Response('repository deleted\n', { status: 410 });
      }
      if (req.headers.get('content-encoding')?.includes('gzip')) {
        body = gunzipLimited(body, MAX_UPLOAD_PACK_BYTES);
      }
      // dgit answers ls-refs with every ref whatever `ref-prefix` asks; filter the answer here.
      const prefixes = lsRefsPrefixes(body);
      const response = await uploadPack(this.store, body, release);
      const filtered = prefixes ? await filterLsRefsResponse(response, prefixes) : response;
      if (this.deleting) {
        await filtered.body?.cancel();
        release();
        return new Response('repository deleted\n', { status: 410 });
      }
      return slot.response(filtered);
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
    const limits = await resolveHostedGitLimits(this.settingsEnv);
    const declared = parseInt(req.headers.get('content-length') ?? '', 10);
    if (Number.isFinite(declared) && declared > limits.maxPushBytes) {
      return new Response(`error: ${hostedGitPushTooLargeMessage(limits.maxPushBytes)}\n`, {
        status: 413,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    if (this.deleting) return new Response('repository deleted\n', { status: 410 });
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
      if (err instanceof RequestTooLargeError || msg.includes('exceeds maximum size')) {
        return new Response(`error: ${hostedGitPushTooLargeMessage(limits.maxPushBytes)}\n`, {
          status: 413,
        });
      }
      // Malformed requests are the client's fault; keep the detail out of the response.
      const status = /pkt-line|push request|command section|git work|inflated size/.test(msg)
        ? 400
        : 500;
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
    const limits = await resolveHostedGitLimits(this.settingsEnv);
    const currentBytes = this.store.dbSize();
    const maxBytes = hostedGitPushByteBudget(currentBytes, limits);
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let body: ChunkBuffer;
    if (req.headers.get('content-encoding')?.includes('gzip')) {
      body = new ChunkBuffer(
        gunzipLimited(await readBodyBounded(req, limits.maxPushBytes), limits.maxPushBytes)
      );
    } else {
      reader = req.body?.getReader() ?? null;
      body = new ChunkBuffer();
    }

    // The pkt-line command section is small; everything after it is the pack.
    let pos = 0;
    const need = async (n: number): Promise<boolean> => {
      while (body.length - pos < n) {
        if (!reader) return false;
        const { done, value } = await readGitChunk(reader);
        if (done) return false;
        if (value?.length) body.append(value);
      }
      return true;
    };
    for (;;) {
      if (!(await need(4))) break;
      const len = pktLength(body.view(pos, pos + 4));
      if (len === 0) {
        pos += 4;
        break;
      }
      if (pos + len > MAX_COMMAND_SECTION_BYTES) throw new Error('push command section too large');
      if (!(await need(len))) throw new Error('truncated push request');
      pos += len;
    }
    const { commands, caps } = parsePushCommands(body.view(0, pos));
    const sideband = caps.includes('side-band-64k');
    const progress = (msg: string) => {
      if (!sideband) return;
      for (const f of sidebandFrames(2, te.encode(msg))) emit(f);
    };

    // Read up to the pack header so the declared object count can be checked before storing.
    const packStart = pos;
    const hasPack = (await need(PACK_HEADER_BYTES)) || body.length > packStart;
    let unpackError = hostedGitRefRefusal(this.store.refs(), commands, currentBytes, limits);
    let packId: number | null = null;
    if (hasPack) {
      const header = body.view(packStart, packStart + PACK_HEADER_BYTES);
      const incomingObjects =
        header.length === PACK_HEADER_BYTES
          ? new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(8)
          : 0;
      const refusal =
        unpackError ??
        hostedGitPushRefusal(
          { objects: this.store.objectCount(), bytes: currentBytes },
          incomingObjects,
          limits
        );
      if (refusal) {
        unpackError = refusal;
      } else {
        try {
          const ingested = await this.store.packs.ingest(body.view(packStart), reader, {
            maxBytes,
            sizeHint: Number.isFinite(parseInt(req.headers.get('content-length') ?? '', 10))
              ? parseInt(req.headers.get('content-length') ?? '', 10)
              : undefined,
            cache: new ObjCache(INGEST_CACHE_BYTES),
            onProgress: progress,
            flush: () => this.ctx.storage.sync(),
            collisionDetect: false,
          });
          // Final reservation: the byte budget covered the raw pack, not its index rows and
          // page overhead. Refuse the push and drop its pack if the stored total crossed the cap.
          const stored = this.store.dbSize();
          if (stored > limits.maxRepoBytes) {
            await this.store.packs.dropPack(ingested.packId);
            unpackError = hostedGitStoredOverCapMessage(stored, limits);
          } else {
            packId = ingested.packId;
          }
        } catch (err) {
          // Ingest writes chunks before checksum/index validation. Reclaim those rows now,
          // before the next push's quota check; retain an alarm if storage cleanup itself fails.
          this.store.setMeta('gc-pending', '1');
          this.store.setMeta('gc-attempts', '0');
          await this.store.packs.cleanupOrphans().catch((cleanupError: unknown) => {
            log.error('hosted_git.ingest_cleanup_failed', {
              error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
            });
          });
          await armHostedGitGcAlarm(this.ctx.storage);
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

    let outcome: ReturnType<typeof commitPush>;
    try {
      const plan = await validatePush(this.store, commands, unpackError);
      outcome = this.ctx.storage.transactionSync(() => commitPush(this.store, plan));
    } catch (err) {
      // Reclaim a pack that never reached a ref decision, or it holds quota with no cleanup queued.
      if (packId !== null) await queueHostedGitGc(this.store, this.ctx.storage);
      throw err;
    }
    const { results, changed, needsGc } = outcome;
    if (changed) {
      this.store.setMeta('created', '1');
      this.store.setMeta('last-push', String(Date.now()));
    }
    if (needsGc || packId !== null) await queueHostedGitGc(this.store, this.ctx.storage);
    if (caps.includes('report-status')) emit(renderStatus(results, unpackError, sideband));
  }
}
