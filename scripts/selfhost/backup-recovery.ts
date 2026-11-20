/** Restore an upgrade's authenticated snapshot to the same owned installation. */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { readRecord } from '../../deploy/selfhost/created-resources.mjs';
import { decryptBackupTree } from './backup-encryption';
import {
  assertBackupOutside,
  backupKey,
  backupScratch,
  type BoxContext,
  BUCKET_DIR,
  bucketPath,
  check,
  composeArgs,
  composeRunEnv,
  ENV_FILE,
  mcArgs,
  mcEnv,
  parseBucketUrl,
  readManifest,
  STATE_DIR,
} from './backup-lib';
import { repairFenceRulesMode } from './fence-state';
import { composeProjectFor, SELFHOST_ENVIRONMENT } from './install-record';
import { KEY_SERVICE_BACKUP_EXCLUDES } from './key-service';
import { assertOperatorExecution } from './operator-only';
import { removePrivateTree } from './private-tree';
import {
  assertCacheHelpers,
  type CacheHelperProof,
  parseCacheHelpers,
  readCacheHelpers,
  removeCacheHelpers,
} from './rollback-cache-helper';
import {
  type CacheStartProof,
  cacheStartTime,
  recoverCacheStart,
} from './rollback-cache-transition';
import { publishRollbackState, recoverRollbackState, rollbackStatePending } from './rollback-state';
import { assertPrivateFile, replacePrivateFile } from './secret-files';
import { stateInstallationId } from './state-installation';
import { assertRollbackReady } from './upgrade-preflight';
function compose(ctx: BoxContext, args: string[]): void {
  check(
    ctx.run('docker', composeArgs(ctx, args), composeRunEnv(ctx)),
    'rollback compose operation'
  );
}
/**
 * The installation id of a live or snapshotted state directory. A plaintext box keeps it in
 * platform-keys.json; a sealed box has no such file (`selfhost:secrets migrate` removes it) and
 * carries the id in its sealed bundles' plaintext headers.
 */
function installationIdOf(state: string): string {
  try {
    return stateInstallationId(state);
  } catch {
    throw new Error('Cannot verify rollback installation identity');
  }
}

/**
 * Same-install rollback keeps the live key-service secrets (the file key, key-service credentials).
 * Backups leave them out (backup-lib.ts isKeyServiceSecretPath), so the snapshot cannot hold them,
 * and replacing the state directory without them leaves a key agent that cannot open any bundle.
 */
function carryKeyServiceSecrets(live: string, staged: string): void {
  for (const rel of KEY_SERVICE_BACKUP_EXCLUDES) {
    const from = join(live, rel);
    if (!existsSync(from)) continue;
    const stat = lstatSync(from);
    if (stat.isSymbolicLink()) throw new Error(`Refusing a symlinked key-service secret: ${rel}`);
    if (stat.isFile()) assertPrivateFile(from);
    const to = join(staged, rel);
    rmSync(to, { recursive: true, force: true });
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    cpSync(from, to, { recursive: true, preserveTimestamps: true });
  }
}
function assertStateReceipt(path: string, expected: string, id: unknown, live = false): void {
  let record;
  try {
    record = readRecord(join(path, 'created-resources.json'));
  } catch {
    throw new Error('Cannot verify rollback state ownership');
  }
  const states = record.resources.filter(
    (r) => r.cloud === 'box' && r.kind === 'state-dir' && r.action === 'created' && !r.removedAt
  );
  const installs = record.resources.filter(
    (r) => r.cloud === 'box' && r.kind === 'installation' && r.action === 'created' && !r.removedAt
  );
  if (
    states.length !== 1 ||
    states[0]?.name !== expected ||
    installs.length !== 1 ||
    installs[0]?.name !== id
  ) {
    throw new Error('Rollback state directory has no exact installation ownership receipt');
  }
  const attributes = states[0]?.attributes;
  if (attributes?.installation !== id)
    throw new Error('Rollback state receipt has a foreign installation');
  if (live) {
    const stat = lstatSync(path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      attributes.device !== String(stat.dev) ||
      attributes.inode !== String(stat.ino)
    ) {
      throw new Error('Rollback state directory identity changed; refusing removal');
    }
  }
}

/** Ownership history follows the live installation, including post-backup removals/creations. */
function currentLedger(ctx: BoxContext, id: string): string {
  assertStateReceipt(ctx.stateDir, ctx.stateDir, id, true);
  const path = join(ctx.stateDir, 'created-resources.json');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid rollback ownership ledger');
  assertPrivateFile(path);
  const record = readRecord(path);
  const installation = record.resources.find(
    (r) => r.cloud === 'box' && r.kind === 'installation' && r.name === id
  );
  if (
    installation?.attributes?.domain !== (ctx.box.SAM_DOMAIN ?? '') ||
    installation.attributes.environment !== SELFHOST_ENVIRONMENT ||
    installation.attributes.composeProject !== composeProjectFor(ctx.box, ctx.stateDir)
  )
    throw new Error('Rollback ownership ledger belongs to a different installation scope');
  return `${JSON.stringify(record, null, 2)}\n`;
}

export interface RollbackCacheProof {
  name: string;
  createdAt: string;
  container: string;
  helpers?: CacheHelperProof[];
}

function inspectCacheVolume(ctx: BoxContext): { name: string; createdAt: string } {
  const project = composeProjectFor(ctx.box, ctx.stateDir);
  const name = `${project}_celld-data`;
  const result = check(
    ctx.run('docker', ['volume', 'inspect', name]),
    'inspect celld cache ownership'
  );
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error('Cannot verify celld cache ownership');
  }
  if (!Array.isArray(value) || value.length !== 1)
    throw new Error('Ambiguous celld cache ownership');
  const volume = value[0] as {
    Name?: unknown;
    Labels?: Record<string, unknown>;
    CreatedAt?: unknown;
  };
  if (
    volume?.Name !== name ||
    volume.Labels?.['com.docker.compose.project'] !== project ||
    volume.Labels?.['com.docker.compose.volume'] !== 'celld-data'
  )
    throw new Error('Foreign celld cache; refusing rollback cache removal');
  if (typeof volume.CreatedAt !== 'string' || !Number.isFinite(Date.parse(volume.CreatedAt)))
    throw new Error('Cannot verify celld cache creation identity');
  return { name, createdAt: volume.CreatedAt };
}

/** Prove the actual selected celld container uses the canonical owned cache before an upgrade. */
export function assertRollbackCacheReady(ctx: BoxContext): RollbackCacheProof {
  assertOperatorExecution();
  assertRollbackReady(ctx);
  const selected = check(
    ctx.run(
      'docker',
      composeArgs(ctx, ['ps', '--all', '--no-trunc', '-q', 'celld']),
      composeRunEnv(ctx)
    ),
    'inspect rollback celld container'
  )
    .stdout.trim()
    .split(/\s+/);
  if (selected.length !== 1 || !/^[a-f0-9]{64}$/.test(selected[0] ?? ''))
    throw new Error('Cannot verify one rollback celld container');
  const container = selected[0] ?? '';
  const result = check(
    ctx.run('docker', ['inspect', '--format', '{{json .Mounts}}', container]),
    'inspect rollback celld cache mount'
  );
  let mounts: unknown;
  try {
    mounts = JSON.parse(result.stdout);
  } catch {
    throw new Error('Cannot verify rollback celld cache mount');
  }
  if (!Array.isArray(mounts) || mounts.some((mount) => typeof mount !== 'object' || mount === null))
    throw new Error('Cannot verify rollback celld cache mount');
  const caches = mounts.filter((mount) => mount.Destination === '/var/lib/celld');
  const proof = inspectCacheVolume(ctx);
  if (caches.length !== 1 || caches[0]?.Type !== 'volume' || caches[0]?.Name !== proof.name)
    throw new Error('Selected celld cache mount is not the canonical owned volume');
  return { ...proof, container, helpers: readCacheHelpers(ctx) };
}

/** A private receipt permits retry after this process removed only part of the cache. */
const CACHE_PENDING = 'rollback-cache-pending.json';
function pendingCache(ctx: BoxContext, from: string): CacheStartProof | null {
  const path = join(ctx.stateDir, CACHE_PENDING);
  if (!existsSync(path)) return null;
  assertPrivateFile(path);
  let value: {
    snapshot?: unknown;
    name?: unknown;
    createdAt?: unknown;
    container?: unknown;
    startingAt?: unknown;
    helpers?: unknown;
  };
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('Invalid rollback cache recovery receipt');
  }
  if (
    value.snapshot !== resolve(from) ||
    value.name !== `${composeProjectFor(ctx.box, ctx.stateDir)}_celld-data` ||
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    typeof value.container !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.container) ||
    (value.startingAt !== undefined &&
      (typeof value.startingAt !== 'string' || !Number.isFinite(Date.parse(value.startingAt))))
  )
    throw new Error('Invalid rollback cache recovery receipt');
  return {
    name: value.name,
    createdAt: value.createdAt,
    container: value.container,
    helpers: parseCacheHelpers(value.helpers),
    ...(typeof value.startingAt === 'string' ? { startingAt: value.startingAt } : {}),
  };
}
function cachePresence(
  ctx: BoxContext,
  expected: RollbackCacheProof
): { container: boolean; volume: boolean } {
  assertRollbackReady(ctx);
  assertCacheHelpers(ctx, expected.helpers ?? []);
  const selected = check(
    ctx.run(
      'docker',
      composeArgs(ctx, ['ps', '--all', '--no-trunc', '-q', 'celld']),
      composeRunEnv(ctx)
    ),
    'inspect recovering celld'
  ).stdout.trim();
  if (selected && selected !== expected.container)
    throw new Error('Rollback celld cache identity changed; refusing removal');
  const volumes = check(
    ctx.run('docker', [
      'volume',
      'ls',
      '--filter',
      `name=^${expected.name}$`,
      '--format',
      '{{.Name}}',
    ]),
    'inspect recovering cache'
  ).stdout.trim();
  if (volumes && volumes !== expected.name) throw new Error('Ambiguous recovering celld cache');
  if (volumes) {
    const current = inspectCacheVolume(ctx);
    if (current.createdAt !== expected.createdAt)
      throw new Error('Rollback celld cache identity changed; refusing removal');
  }
  if (selected) {
    const current = assertRollbackCacheReady(ctx);
    if (!volumes || current.createdAt !== expected.createdAt)
      throw new Error('Rollback celld cache identity changed; refusing removal');
  }
  return { container: Boolean(selected), volume: Boolean(volumes) };
}
/** Keep the proof durable until both exact resources have disappeared. */
function discardCelldCache(ctx: BoxContext, expected: RollbackCacheProof, from: string): void {
  replacePrivateFile(
    join(ctx.stateDir, CACHE_PENDING),
    JSON.stringify({ ...expected, snapshot: resolve(from) })
  );
  const present = cachePresence(ctx, expected);
  if (present.container)
    check(
      ctx.run('docker', ['container', 'rm', '--force', expected.container]),
      'remove exact rollback celld container'
    );
  removeCacheHelpers(ctx, expected.helpers ?? []);
  if (present.volume) {
    const after = inspectCacheVolume(ctx);
    if (after.createdAt !== expected.createdAt)
      throw new Error('Rollback celld cache identity changed; refusing removal');
    check(ctx.run('docker', ['volume', 'rm', expected.name]), 'remove owned celld cache');
  }
  // recoverUpgrade keeps this receipt until old code and dependencies are healthy.
}

/** After an authorized Compose recreation, bind retry to its newly observed exact cache. */
export function beginRollbackCacheStart(ctx: BoxContext, from: string): void {
  assertOperatorExecution();
  const pending = pendingCache(ctx, from);
  if (!pending) throw new Error('Missing rollback cache recovery receipt');
  const present = cachePresence(ctx, pending);
  if (present.container || present.volume)
    throw new Error('Recovery start requires the previous cache to be absent');
  currentLedger(ctx, installationIdOf(ctx.stateDir));
  replacePrivateFile(
    join(ctx.stateDir, CACHE_PENDING),
    JSON.stringify({ ...pending, snapshot: resolve(from), startingAt: cacheStartTime() })
  );
}

export function refreshRollbackCacheReceipt(ctx: BoxContext, from: string): void {
  assertOperatorExecution();
  const pending = pendingCache(ctx, from);
  if (!pending) throw new Error('Missing rollback cache recovery receipt');
  const proof = pending.startingAt
    ? recoverCacheStart(ctx, pending, inspectCacheVolume, assertRollbackCacheReady, true)
    : assertRollbackCacheReady(ctx);
  replacePrivateFile(
    join(ctx.stateDir, CACHE_PENDING),
    JSON.stringify({ ...proof, snapshot: resolve(from) })
  );
}

/** Clear progress only after the recovered installation has passed its health check. */
export function finishRollbackCache(ctx: BoxContext): void {
  assertOperatorExecution();
  assertRollbackReady(ctx);
  const path = join(ctx.stateDir, CACHE_PENDING);
  assertPrivateFile(path);
  rmSync(path);
}
/** Stage the full replacement before swapping directories; failed copying retains live state. */
function restoreState(
  ctx: BoxContext,
  source: string,
  id: string,
  pending: RollbackCacheProof | null,
  from: string
): void {
  const stage = mkdtempSync(join(dirname(ctx.stateDir), '.rollback-state-'));
  const staged = join(stage, 'restored');
  try {
    cpSync(source, staged, { recursive: true });
    carryKeyServiceSecrets(ctx.stateDir, staged);
    // Keep the original upgrade's recovery pointer until recoverUpgrade verifies health.
    const upgradePending = join(ctx.stateDir, 'upgrade-pending.json');
    if (existsSync(upgradePending)) {
      assertPrivateFile(upgradePending);
      replacePrivateFile(
        join(staged, 'upgrade-pending.json'),
        readFileSync(upgradePending, 'utf8')
      );
    }
    if (pending)
      replacePrivateFile(
        join(staged, CACHE_PENDING),
        JSON.stringify({ ...pending, snapshot: resolve(from) })
      );
    replacePrivateFile(join(staged, 'created-resources.json'), currentLedger(ctx, id));
    publishRollbackState(ctx, stage, id);
  } finally {
    if (!rollbackStatePending(ctx)) removePrivateTree(stage);
  }
}

/**
 * Compensate only an upgrade of this exact install using its own pre-upgrade snapshot.
 * The target is the original scoped bucket, never an arbitrary restore destination.
 */
export function runRollback(ctx: BoxContext, from: string, expectedSamCommit?: string): void {
  assertOperatorExecution();
  recoverRollbackState(ctx);
  const key = backupKey(ctx);
  assertBackupOutside(ctx, from);
  const temp = backupScratch();
  try {
    const plain = join(temp, 'plain');
    decryptBackupTree(from, plain, key);
    const manifest = readManifest(plain);
    if (expectedSamCommit && manifest.samCommit !== expectedSamCommit)
      throw new Error('Rollback snapshot belongs to a different code revision');
    if (manifest.bucket !== ctx.box.CELLD_BUCKET)
      throw new Error('Rollback snapshot belongs to a different bucket');
    const installation = installationIdOf(join(plain, STATE_DIR));
    if (installation !== installationIdOf(ctx.stateDir))
      throw new Error('Rollback snapshot belongs to a different installation');
    assertStateReceipt(join(plain, STATE_DIR), ctx.stateDir, installation);
    currentLedger(ctx, installation);
    let pending = pendingCache(ctx, from);
    if (pending?.startingAt) {
      pending = recoverCacheStart(ctx, pending, inspectCacheVolume, assertRollbackCacheReady);
      replacePrivateFile(
        join(ctx.stateDir, CACHE_PENDING),
        JSON.stringify({ ...pending, snapshot: resolve(from) })
      );
    }
    const cache = pending ?? assertRollbackCacheReady(ctx);
    if (pending) cachePresence(ctx, pending);
    compose(ctx, ['stop', 'celld']);
    // Recheck before bucket mutation, retaining the stopped cache until all data is restored.
    if (!pending) {
      const current = assertRollbackCacheReady(ctx);
      if (JSON.stringify(current) !== JSON.stringify(cache))
        throw new Error('Rollback cache identity changed; refusing removal');
    }
    const url = parseBucketUrl(ctx.box.CELLD_BUCKET ?? '');
    const source = join(plain, BUCKET_DIR);
    if (url.scheme === 'gs') {
      check(
        ctx.run('gcloud', [
          'storage',
          'rsync',
          '--recursive',
          '--delete-unmatched-destination-objects',
          source,
          `gs://${bucketPath(url)}`,
        ]),
        'restore pre-upgrade bucket'
      );
    } else {
      check(
        ctx.run(
          'docker',
          mcArgs(
            ctx,
            [`${resolve(source)}:/backup:ro`],
            ['mirror', '--overwrite', '--remove', '--quiet', '/backup', `src/${bucketPath(url)}`]
          ),
          mcEnv(ctx)
        ),
        'restore pre-upgrade bucket'
      );
    }
    restoreState(ctx, join(plain, STATE_DIR), installation, pending, from);
    // The snapshot keeps only the exec bit: files a container reads as another user need their mode.
    repairFenceRulesMode(ctx.stateDir);
    // A previous partial cache deletion must remain retryable even if copying the env fails.
    if (pending)
      replacePrivateFile(
        join(ctx.stateDir, CACHE_PENDING),
        JSON.stringify({ ...cache, snapshot: resolve(from) })
      );
    replacePrivateFile(ctx.envFile, readFileSync(join(plain, ENV_FILE), 'utf8'));
    discardCelldCache(ctx, cache, from);
  } finally {
    removePrivateTree(temp);
  }
}
