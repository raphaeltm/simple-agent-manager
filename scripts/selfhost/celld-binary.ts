/**
 * Locate the tools `celld deploy` needs on the deploying machine: the pinned celld binary
 * (downloaded and checksum-verified) and an esbuild executable.
 */

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { arch, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { CELLD_RELEASE_SHA256, CELLD_VERSION, DEFAULT_CELLD_RELEASE_BASE_URL } from './versions.js';

export function celldReleaseTarget(os = platform(), cpu = arch()): string {
  const target =
    os === 'linux' && cpu === 'x64'
      ? 'x86_64-unknown-linux-gnu'
      : os === 'linux' && cpu === 'arm64'
        ? 'aarch64-unknown-linux-gnu'
        : os === 'darwin' && cpu === 'arm64'
          ? 'aarch64-apple-darwin'
          : null;
  if (!target || !CELLD_RELEASE_SHA256[target]) {
    throw new Error(
      `celld ${CELLD_VERSION} has no release for ${os}/${cpu}; set CELLD_BIN to a celld binary`
    );
  }
  return target;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Returns a celld binary path: `CELLD_BIN` when set (unverified, and said so), otherwise the
 * pinned release under `binDir`. The compressed asset is kept beside the binary; every run
 * re-checks it against the pinned sha256 and the binary against its decompressed bytes, so a
 * tampered cache is replaced rather than executed with the bucket credential.
 */
export async function ensureCelldBinary(
  binDir: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  if (env.CELLD_BIN) {
    console.warn(`[selfhost] using CELLD_BIN=${env.CELLD_BIN} without checksum verification`);
    return env.CELLD_BIN;
  }
  const target = celldReleaseTarget();
  const expected = CELLD_RELEASE_SHA256[target];
  const path = join(binDir, `celld-${CELLD_VERSION}`);
  const gzPath = `${path}.gz`;

  if (existsSync(gzPath) && existsSync(path)) {
    const gz = readFileSync(gzPath);
    if (sha256Hex(gz) === expected && sha256Hex(gunzipSync(gz)) === sha256Hex(readFileSync(path))) {
      return path;
    }
    console.warn(`[selfhost] cached celld in ${binDir} failed verification; downloading again`);
  }

  const base = env.CELLD_RELEASE_BASE_URL || DEFAULT_CELLD_RELEASE_BASE_URL;
  const url = `${base}/v${CELLD_VERSION}/celld-${target}.gz`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`downloading ${url}: HTTP ${response.status}`);
  const gz = new Uint8Array(await response.arrayBuffer());
  const actual = sha256Hex(gz);
  if (actual !== expected) throw new Error(`${url}: sha256 ${actual}, expected ${expected}`);

  mkdirSync(binDir, { recursive: true, mode: 0o700 });
  writeFileSync(`${gzPath}.download`, gz, { mode: 0o600 });
  renameSync(`${gzPath}.download`, gzPath);
  const temp = `${path}.download`;
  writeFileSync(temp, gunzipSync(gz), { mode: 0o700 });
  chmodSync(temp, 0o700);
  renameSync(temp, path);
  return path;
}

/**
 * An esbuild executable for celld's bundler: `CELLD_ESBUILD` when set, otherwise the esbuild
 * wrangler depends on (the same toolchain that bundles the Worker for Cloudflare).
 */
export function resolveEsbuild(apiDir: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.CELLD_ESBUILD) return env.CELLD_ESBUILD;
  const fromApi = createRequire(join(apiDir, 'package.json'));
  const fromWrangler = createRequire(fromApi.resolve('wrangler/package.json'));
  const pkgPath = fromWrangler.resolve('esbuild/package.json');
  const pkg: unknown = JSON.parse(readFileSync(pkgPath, 'utf8')) as unknown;
  const binField = typeof pkg === 'object' && pkg !== null && 'bin' in pkg ? pkg.bin : undefined;
  const bin =
    typeof binField === 'string'
      ? binField
      : typeof binField === 'object' && binField !== null && 'esbuild' in binField
        ? String(binField.esbuild)
        : undefined;
  if (!bin) throw new Error(`${pkgPath} declares no esbuild binary; set CELLD_ESBUILD`);
  return join(dirname(pkgPath), bin);
}
