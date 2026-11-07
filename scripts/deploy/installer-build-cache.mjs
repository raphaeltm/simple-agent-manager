// Installation build cache, content-addressed under `installer-cache/` in the
// installation's Pulumi state bucket (`<prefix>-pulumi-state-<environment>`). That bucket
// is deterministic for an account and domain and already inside the installation's
// scoped R2 credential: no authority is widened. The deployed SAM runtime token has
// no R2 permission.
//
// Two trust anchors, because the bucket outlives any one installation and a previous
// installation's state credential could still write to it:
// - Build outputs (binaries) are reused only when their manifest carries an HMAC made
//   with a key derived from THIS installation's private Pulumi passphrase. Entries from
//   any other writer are a miss, so binaries are shared across retries and resumes of
//   one installation, never between installations.
// - The source bundle may be shared across installations because the restore never
//   trusts its manifest: it accepts only a repository whose approved commit hash, and
//   so its tree, it verifies itself (installer-source-cache.mjs).
// Every hit is also verified byte-for-byte (size and SHA-256). A miss, a transport
// error, an invalid MAC or a mismatch builds instead, and a failed save only costs the
// next run a rebuild: the cache can never fail an install.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export const CACHE_PREFIX = 'installer-cache';
const MAX_OBJECT_BYTES = 1024 ** 3;
const MAX_MANIFEST_BYTES = 65536;
const KEY = /^[a-z0-9][a-z0-9./-]{0,255}$/;
const HEX64 = /^[a-f0-9]{64}$/;

/** Outputs of the engine's `build` phase VM-agent steps (`make prepare-container`
 * and `make build-all`). Order is part of the manifest contract. */
export const VM_AGENT_OUTPUTS = [
  'packages/vm-agent/bin/vm-agent-linux-amd64',
  'packages/vm-agent/bin/vm-agent-linux-arm64',
  'packages/vm-agent/bin/vm-agent-darwin-amd64',
  'packages/vm-agent/bin/vm-agent-darwin-arm64',
  'apps/api/container-artifacts/vm-agent-linux-amd64',
  'apps/api/container-artifacts/install-opencode.sh',
  'apps/api/container-artifacts/vm-agent-version.json',
];
/** Outputs of the `publish-cli` phase (`make -C packages/cli build-all version`). */
export const CLI_OUTPUTS = [
  'packages/cli/bin/sam-linux-amd64',
  'packages/cli/bin/sam-linux-arm64',
  'packages/cli/bin/sam-darwin-amd64',
  'packages/cli/bin/sam-darwin-arm64',
  'packages/cli/bin/version.json',
];

const sha256File = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const MAC_CONTEXT = 'sam-installer-build-cache-v1';

/** Per-installation manifest key. Derived in memory only; never written or logged. */
export function cacheAuthKey(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < 16)
    throw new Error('Build cache authentication unavailable');
  return createHmac('sha256', passphrase).update(MAC_CONTEXT).digest();
}
// Manifest location is installation-scoped too: another installation's entry for the
// same inputs is never found, and neither installation overwrites the other's.
const manifestName = (authKey, key) =>
  `outputs/${createHmac('sha256', authKey).update(`manifest:${key}`).digest('hex')}.json`;
const manifestMac = (authKey, key, files) =>
  createHmac('sha256', authKey)
    .update(JSON.stringify({ version: 2, key, files }))
    .digest();

export function cacheKey(kind, inputs) {
  return createHash('sha256')
    .update(JSON.stringify({ format: 'sam-installer-build-cache-v1', kind, inputs }))
    .digest('hex');
}

/** S3 transport over curl. Credentials stay in a private config file, never argv. */
export function r2CacheStore({ accountId, bucket, accessKeyId, secretAccessKey, work }) {
  if (
    !/^[a-f0-9]{32}$/.test(accountId) ||
    !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) ||
    !/^[a-f0-9]{32}$/.test(accessKeyId) ||
    !HEX64.test(secretAccessKey)
  )
    throw new Error('Invalid build cache authority');
  const root = `https://${accountId}.r2.cloudflarestorage.com/${bucket}/${CACHE_PREFIX}`;
  // Credentials exist on disk only for one request, in a private directory removed
  // afterwards, and never in argv.
  const curl = async (args, output) => {
    mkdirSync(work, { recursive: true, mode: 0o700 });
    const scratch = mkdtempSync(join(work, 'r2-'));
    try {
      const config = join(scratch, 'curl.conf');
      writeFileSync(config, `user = "${accessKeyId}:${secretAccessKey}"\n`, { mode: 0o600 });
      return await new Promise((accept, reject) =>
        execFile(
          'curl',
          [
            '--config',
            config,
            '--silent',
            '--proto',
            '=https',
            '--max-time',
            '600',
            '--aws-sigv4',
            'aws:amz:auto:s3',
            '--write-out',
            '%{http_code}',
            '--output',
            output ?? join(scratch, 'response'),
            ...args,
          ],
          { encoding: 'utf8' },
          (error, stdout) =>
            error ? reject(new Error('Build cache transport failed')) : accept(stdout)
        )
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };
  const url = (key) => {
    if (!KEY.test(key) || key.includes('..')) throw new Error('Invalid build cache key');
    return `${root}/${key}`;
  };
  return {
    async get(key, file) {
      const status = await curl(['--max-filesize', String(MAX_OBJECT_BYTES), url(key)], file);
      if (status === '200') return true;
      rmSync(file, { force: true });
      if (status === '404') return false;
      throw new Error(`Build cache read failed (HTTP ${status})`);
    },
    async put(key, file) {
      // Unconditional: objects are content-addressed, and overwriting a manifest
      // with a freshly verified one repairs a corrupted entry.
      const status = await curl(['--request', 'PUT', '--upload-file', file, url(key)]);
      if (!['200', '201', '204'].includes(status))
        throw new Error(`Build cache write failed (HTTP ${status})`);
    },
  };
}

async function restore(store, authKey, key, root, files, work) {
  const dir = mkdtempSync(join(work, 'restore-'));
  try {
    const manifestFile = join(dir, 'manifest.json');
    if (!(await store.get(manifestName(authKey, key), manifestFile))) return false;
    if (statSync(manifestFile).size > MAX_MANIFEST_BYTES) return false;
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    if (
      manifest?.version !== 2 ||
      manifest.key !== key ||
      !Array.isArray(manifest.files) ||
      manifest.files.length !== files.length ||
      typeof manifest.mac !== 'string' ||
      !HEX64.test(manifest.mac)
    )
      return false;
    const entries = files.map((path, index) => {
      const entry = manifest.files[index];
      return {
        path: entry?.path,
        sha256: entry?.sha256,
        bytes: entry?.bytes,
        mode: entry?.mode,
      };
    });
    // Authenticate before trusting any digest the manifest names.
    if (!timingSafeEqual(Buffer.from(manifest.mac, 'hex'), manifestMac(authKey, key, entries)))
      return false;
    const staged = [];
    for (const [index, path] of files.entries()) {
      const entry = entries[index];
      if (
        entry.path !== path ||
        !HEX64.test(entry.sha256) ||
        !Number.isSafeInteger(entry.bytes) ||
        entry.bytes < 0 ||
        entry.bytes > MAX_OBJECT_BYTES ||
        ![0o644, 0o755].includes(entry.mode)
      )
        return false;
      const file = join(dir, String(index));
      if (
        !(await store.get(`objects/${entry.sha256}`, file)) ||
        statSync(file).size !== entry.bytes ||
        sha256File(file) !== entry.sha256
      )
        return false;
      staged.push([file, path, entry.mode]);
    }
    // Every file verified before the first one is installed.
    for (const [file, path, mode] of staged) {
      const target = join(root, path);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(file, target);
      chmodSync(target, mode);
    }
    return true;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function save(store, authKey, key, root, files, work) {
  const entries = [];
  for (const path of files) {
    const file = join(root, path);
    if (!existsSync(file) || !lstatSync(file).isFile()) return false;
    entries.push({
      path,
      sha256: sha256File(file),
      bytes: statSync(file).size,
      mode: statSync(file).mode & 0o111 ? 0o755 : 0o644,
    });
  }
  for (const [index, entry] of entries.entries())
    await store.put(`objects/${entry.sha256}`, join(root, files[index]));
  // Manifest last: a partially written entry is a miss, never a hit.
  const manifestFile = join(work, `${key}.json`);
  const mac = manifestMac(authKey, key, entries).toString('hex');
  writeFileSync(manifestFile, JSON.stringify({ version: 2, key, files: entries, mac }), {
    mode: 0o600,
  });
  try {
    await store.put(manifestName(authKey, key), manifestFile);
  } finally {
    rmSync(manifestFile, { force: true });
  }
  return true;
}

/** Restore authenticated, verified `files` for `key`, or run `build` and store what it
 * produced. Without both a store and this installation's `authKey` it only builds.
 * Returns 'hit', 'stored' or 'built'. Only `build` failures propagate. */
export async function cachedOutputs({ store: candidate, authKey, key, root, files, build, work }) {
  if (!HEX64.test(key)) throw new Error('Invalid build cache key');
  const store = Buffer.isBuffer(authKey) && authKey.length === 32 ? candidate : undefined;
  if (store) {
    mkdirSync(work, { recursive: true, mode: 0o700 });
    try {
      if (await restore(store, authKey, key, root, files, work)) return 'hit';
    } catch {
      /* A cache fault is a miss. */
    }
  }
  await build();
  if (!store) return 'built';
  try {
    return (await save(store, authKey, key, root, files, work)) ? 'stored' : 'built';
  } catch {
    return 'built';
  }
}

/** Offer the verified source bundle that the builder restored to later installations
 * of the same account and domain. The restore names the bundle after its origin:
 * `upstream` means the shared entry was absent or failed verification, so it is
 * (re)written; `installation` (a same-installation resume) only fills a gap.
 * A bundle that came from this cache is not kept. Never throws; always frees the disk. */
export async function publishSourceBundle({ store, root, commit }) {
  const kept = ['upstream', 'installation']
    .map((origin) => [origin, join(root, `.wrangler/installer-source-${origin}.bundle`)])
    .filter(([, path]) => existsSync(path));
  try {
    const [origin, bundle] = kept[0] ?? [];
    if (!store || !bundle) return 'skipped';
    const manifest = JSON.parse(
      readFileSync(join(root, '.wrangler/installer-source-identity.json'), 'utf8')
    );
    if (
      manifest.version !== 1 ||
      manifest.commit !== commit ||
      !/^[a-f0-9]{40}$/.test(String(manifest.tree)) ||
      !HEX64.test(String(manifest.bundleSHA256)) ||
      statSync(bundle).size !== manifest.bundleBytes ||
      sha256File(bundle) !== manifest.bundleSHA256
    )
      return 'skipped';
    const accepted = join(root, '.wrangler/installer-source-cache.json');
    try {
      if (origin === 'installation' && (await store.get(`source/${commit}.json`, accepted)))
        return 'present';
      await store.put(`source/objects/${manifest.bundleSHA256}.bundle`, bundle);
      // Manifest last, with exactly the fields the restore accepts.
      writeFileSync(
        accepted,
        JSON.stringify({
          version: 1,
          commit,
          tree: manifest.tree,
          bundleSHA256: manifest.bundleSHA256,
          bundleBytes: manifest.bundleBytes,
        }),
        { mode: 0o600 }
      );
      await store.put(`source/${commit}.json`, accepted);
      return 'published';
    } finally {
      rmSync(accepted, { force: true });
    }
  } catch {
    return 'skipped';
  } finally {
    for (const [, path] of kept) rmSync(path, { force: true });
  }
}
