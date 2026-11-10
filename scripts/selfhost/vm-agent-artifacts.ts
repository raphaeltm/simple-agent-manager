/**
 * The self-host equivalent of `scripts/deploy/publish-vm-agent-artifacts.sh`: nodes download
 * the vm-agent from `GET /api/agent/download`, which reads the Worker's `R2` binding, so the
 * binaries must be in the fleet bucket before a node can boot.
 *
 * Same object layout and rules as the Cloudflare pipeline:
 *   - `agents/releases/<release>/vm-agent-linux-<arch>` is immutable. Identical bytes are reused;
 *     different bytes under an existing key fail closed.
 *   - `agents/vm-agent-linux-<arch>` (legacy, unpinned callers) is seeded once, never advanced.
 * The release is the last commit that changed the agent's build inputs
 * (`scripts/deploy/resolve-vm-agent-release.sh`), and the Worker gets it as
 * `VM_AGENT_REQUIRED_VERSION`, so cloud-init downloads exactly this build.
 *
 * The binaries are built in a pinned Go image because Docker is already a box prerequisite and
 * Go is not. `-trimpath -buildvcs=false` (packages/vm-agent/Makefile) makes the bytes
 * reproducible across checkouts, which the immutable-key check depends on.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Matches `toolchain` in packages/vm-agent/go.mod. */
export const VM_AGENT_BUILD_IMAGE =
  'golang:1.26.10-bookworm@sha256:5de7c99eb78ca5e515a4c340235d0955ec5964a5071c492c15503d7c267da473';

export const VM_AGENT_ARCHITECTURES = ['amd64', 'arm64'] as const;
export type VmAgentArchitecture = (typeof VM_AGENT_ARCHITECTURES)[number];

export interface VmAgentRelease {
  release: string;
  buildDate: string;
}

/** Parses the `release=` / `build_date=` lines `resolve-vm-agent-release.sh` prints. */
export function parseVmAgentRelease(output: string): VmAgentRelease {
  const value = (name: string): string | undefined =>
    output
      .split('\n')
      .find((line) => line.startsWith(`${name}=`))
      ?.slice(name.length + 1)
      .trim();
  const release = value('release');
  const buildDate = value('build_date');
  if (!release || !/^[0-9a-f]{40}$/.test(release)) {
    throw new Error(`resolve-vm-agent-release.sh printed no 40-hex release: ${output.trim()}`);
  }
  if (!buildDate || Number.isNaN(Date.parse(buildDate))) {
    throw new Error(`resolve-vm-agent-release.sh printed no ISO build_date: ${output.trim()}`);
  }
  return { release, buildDate };
}

export function vmAgentReleaseKey(release: string, arch: VmAgentArchitecture): string {
  return `agents/releases/${release}/vm-agent-linux-${arch}`;
}

export function vmAgentLegacyKey(arch: VmAgentArchitecture): string {
  return `agents/vm-agent-linux-${arch}`;
}

export type VmAgentPublishAction = 'upload' | 'reuse' | 'preserve-legacy';

/**
 * What to do with one object. `existingSha256` is null when the key does not exist.
 * Throws when an immutable release key already holds different bytes.
 */
export function decideVmAgentPublish(
  kind: 'release' | 'legacy',
  key: string,
  existingSha256: string | null,
  builtSha256: string
): VmAgentPublishAction {
  if (existingSha256 === null) return 'upload';
  if (kind === 'legacy') return 'preserve-legacy';
  if (existingSha256 === builtSha256) return 'reuse';
  throw new Error(
    `refusing to overwrite immutable vm-agent artifact ${key} ` +
      `(existing sha256=${existingSha256}, built sha256=${builtSha256})`
  );
}

/** celld's `r2 get` error for a missing key (any other failure is not "absent"). */
export const R2_NO_OBJECT = /no object "[^"]*" in r2 bucket/;

// ---------------------------------------------------------------------------------------------
// Orchestration (child processes). Kept apart from the pure rules above, which the tests cover.

/** Upper bound on a fetched object (the binaries are about 18 MB). */
const R2_GET_MAX_BYTES = 256 * 1024 * 1024;

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function resolveVmAgentRelease(repoRoot: string): VmAgentRelease {
  const result = spawnSync('bash', ['scripts/deploy/resolve-vm-agent-release.sh', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`resolve-vm-agent-release.sh failed: ${result.stderr || result.stdout}`);
  }
  return parseVmAgentRelease(result.stdout);
}

/** Builds packages/vm-agent/bin/vm-agent-linux-{amd64,arm64} in the pinned Go image. */
export function buildVmAgentBinaries(
  repoRoot: string,
  cacheDir: string,
  { release, buildDate }: VmAgentRelease
): string {
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  const args = [
    'run',
    '--rm',
    '--user',
    `${uid}:${gid}`,
    '-v',
    `${repoRoot}:/src`,
    '-v',
    `${cacheDir}:/cache`,
    '-e',
    'HOME=/tmp',
    '-e',
    'GOCACHE=/cache/build',
    '-e',
    'GOMODCACHE=/cache/mod',
    '-e',
    'GOTOOLCHAIN=local',
    '-w',
    '/src/packages/vm-agent',
    VM_AGENT_BUILD_IMAGE,
    // The same target the Cloudflare pipeline runs (deploy-reusable.yml), so one release
    // produces the same bytes on either platform.
    'make',
    'build-all',
    `VERSION=${release}`,
    `BUILD_DATE=${buildDate}`,
  ];
  const result = spawnSync('docker', args, { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('vm-agent build failed (docker run golang)');
  return join(repoRoot, 'packages/vm-agent/bin');
}

/** sha256 of an R2 object behind the binding, or null when the key does not exist. */
function existingObjectSha256(
  celld: string,
  bucketName: string,
  key: string,
  fleetBucket: string,
  env: NodeJS.ProcessEnv
): string | null {
  const result = spawnSync(celld, ['r2', 'get', bucketName, key, '--bucket', fleetBucket], {
    env,
    maxBuffer: R2_GET_MAX_BYTES,
  });
  if (result.status === 0) return sha256(result.stdout);
  const stderr = result.stderr.toString('utf8');
  if (R2_NO_OBJECT.test(stderr)) return null;
  throw new Error(`could not check ${key} in r2 bucket ${bucketName}: ${stderr.trim()}`);
}

export interface PublishVmAgentOptions {
  celld: string;
  env: NodeJS.ProcessEnv;
  fleetBucket: string;
  /** The `bucket_name` of the Worker's `R2` binding, as rendered into wrangler.json. */
  r2BucketName: string;
  binDir: string;
  release: string;
  log: (message: string) => void;
}

export function publishVmAgentArtifacts(options: PublishVmAgentOptions): void {
  const { celld, env, fleetBucket, r2BucketName, binDir, release, log } = options;
  for (const arch of VM_AGENT_ARCHITECTURES) {
    const source = join(binDir, `vm-agent-linux-${arch}`);
    const builtSha = sha256(readFileSync(source));
    const targets = [
      ['release', vmAgentReleaseKey(release, arch)],
      ['legacy', vmAgentLegacyKey(arch)],
    ] as const;
    for (const [kind, key] of targets) {
      const existing = existingObjectSha256(celld, r2BucketName, key, fleetBucket, env);
      const action = decideVmAgentPublish(kind, key, existing, builtSha);
      if (action !== 'upload') {
        log(`vm-agent ${key}: ${action === 'reuse' ? 'identical, reused' : 'kept (legacy key)'}`);
        continue;
      }
      const put = spawnSync(
        celld,
        ['r2', 'put', r2BucketName, key, '--path', source, '--bucket', fleetBucket],
        { env, encoding: 'utf8' }
      );
      if (put.status !== 0) throw new Error(`celld r2 put ${key} failed: ${put.stderr.trim()}`);
      log(`vm-agent ${key}: uploaded (sha256 ${builtSha})`);
    }
  }
}
