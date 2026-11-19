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
 * Go is not. The source is `git archive HEAD -- packages/vm-agent`, never the working tree: the
 * release key names a commit, so a local edit must not be published under it, and the build
 * container never sees the rest of the checkout (`.state/` holds the platform keys). Modules
 * are fetched in one container; the compile runs in another with no network and no
 * capabilities. `-trimpath -buildvcs=false` (packages/vm-agent/Makefile) plus the pinned image
 * make the bytes reproducible per image, which the immutable-key check depends on.
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sha256Hex } from './celld-binary.js';

/** Matches `toolchain` in packages/vm-agent/go.mod. */
export const VM_AGENT_BUILD_IMAGE =
  'golang:1.26.11-bookworm@sha256:dc40a13b61304647ed7e5d581d246b86413dfc29d63c6d018310feb93cd98fc0';

export const VM_AGENT_ARCHITECTURES = ['amd64', 'arm64'] as const;
export type VmAgentArchitecture = (typeof VM_AGENT_ARCHITECTURES)[number];

export interface VmAgentRelease {
  release: string;
  buildDate: string;
}

/** `git show --format=%cI` output: strict ISO-8601 with an offset (it reaches a make recipe). */
const ISO_COMMIT_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/;

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
  if (!buildDate || !ISO_COMMIT_DATE.test(buildDate)) {
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

/**
 * True only for celld's exact missing-object error for this key and bucket (celld 0.6.3:
 * `Error: no object "<key>" in r2 bucket "<bucket>"`). Anything else is not "absent": treating
 * a misaddressed bucket as empty would let an upload replace an immutable object.
 */
export function isR2NoObjectError(stderr: string, bucketName: string, key: string): boolean {
  const expected = `Error: no object ${JSON.stringify(key)} in r2 bucket ${JSON.stringify(bucketName)}`;
  return stderr.split('\n').some((line) => line.trim() === expected);
}

// ---------------------------------------------------------------------------------------------
// Orchestration (child processes). Kept apart from the pure rules above, which the tests cover.

/** Upper bound on a fetched object (the binaries are about 18 MB). */
const R2_GET_MAX_BYTES = 256 * 1024 * 1024;

type Redact = (text: string) => string;

function childFailure(
  what: string,
  result: SpawnSyncReturns<string | Buffer>,
  redact: Redact
): Error {
  if (result.error) return new Error(`${what}: ${result.error.message}`);
  const stderr = redact(String(result.stderr ?? '').trim());
  return new Error(`${what} (exit ${result.status ?? 'signal'}): ${stderr}`);
}

export function resolveVmAgentRelease(repoRoot: string): VmAgentRelease {
  const result = spawnSync('bash', ['scripts/deploy/resolve-vm-agent-release.sh', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw childFailure('resolve-vm-agent-release.sh', result, (t) => t);
  return parseVmAgentRelease(result.stdout);
}

function docker(args: string[], what: string): void {
  const result = spawnSync('docker', args, { stdio: ['ignore', 'inherit', 'inherit'] });
  if (result.status !== 0) {
    throw new Error(`${what} failed (docker ${result.error?.message ?? `exit ${result.status}`})`);
  }
}

/**
 * Builds vm-agent-linux-{amd64,arm64} from HEAD's packages/vm-agent in the pinned Go image.
 * HEAD's agent tree is the release tree: the release is the last commit that changed it.
 * Returns the directory holding the binaries; the caller removes it with `rmSync`.
 */
export function buildVmAgentBinaries(
  repoRoot: string,
  cacheDir: string,
  { release, buildDate }: VmAgentRelease
): string {
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const workDir = mkdtempSync(join(tmpdir(), 'sam-vm-agent-'));
  const archive = spawnSync(
    'sh',
    ['-c', 'git archive --format=tar HEAD -- packages/vm-agent | tar -x -C "$1"', 'sh', workDir],
    { cwd: repoRoot, encoding: 'utf8' }
  );
  if (archive.status !== 0) throw childFailure('git archive packages/vm-agent', archive, (t) => t);
  const src = join(workDir, 'packages/vm-agent');
  try {
    runVmAgentBuild(src, cacheDir, { release, buildDate });
  } catch (error) {
    rmSync(workDir, { recursive: true, force: true });
    throw error;
  }
  return join(src, 'bin');
}

// GOFLAGS is not passed: the Makefile defines its own, and make exports it to `go`.
function runVmAgentBuild(src: string, cacheDir: string, { release, buildDate }: VmAgentRelease) {
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  const common = [
    'run',
    '--rm',
    '--user',
    `${uid}:${gid}`,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--mount',
    `type=bind,src=${src},dst=/src`,
    '--mount',
    `type=bind,src=${cacheDir},dst=/cache`,
    '-e',
    'HOME=/tmp',
    '-e',
    'GOCACHE=/cache/build',
    '-e',
    'GOMODCACHE=/cache/mod',
    '-e',
    'GOTOOLCHAIN=local',
    '-w',
    '/src',
  ];
  docker([...common, VM_AGENT_BUILD_IMAGE, 'go', 'mod', 'download'], 'vm-agent module download');
  docker(
    [
      ...common.slice(0, 2),
      '--network',
      'none',
      ...common.slice(2),
      VM_AGENT_BUILD_IMAGE,
      'make',
      'build-linux-amd64',
      'build-linux-arm64',
      `VERSION=${release}`,
      `BUILD_DATE=${buildDate}`,
    ],
    'vm-agent build'
  );
}

export function removeVmAgentBuild(binDir: string): void {
  // binDir is <mkdtemp>/packages/vm-agent/bin; remove the whole temporary tree.
  rmSync(join(binDir, '../../..'), { recursive: true, force: true });
}

interface R2Target {
  celld: string;
  env: NodeJS.ProcessEnv;
  fleetBucket: string;
  bucketName: string;
  redact: Redact;
}

/** sha256 of an R2 object behind the binding, or null when the key does not exist. */
function existingObjectSha256(target: R2Target, key: string): string | null {
  const { celld, env, fleetBucket, bucketName, redact } = target;
  const result = spawnSync(celld, ['r2', 'get', bucketName, key, '--bucket', fleetBucket], {
    env,
    maxBuffer: R2_GET_MAX_BYTES,
  });
  if (result.status === 0) return sha256Hex(result.stdout);
  if (!result.error && isR2NoObjectError(String(result.stderr ?? ''), bucketName, key)) return null;
  throw childFailure(`could not check ${key} in r2 bucket ${bucketName}`, result, redact);
}

export interface PublishVmAgentOptions extends Omit<R2Target, 'bucketName'> {
  /** The `bucket_name` of the Worker's `R2` binding, as rendered into wrangler.json. */
  r2BucketName: string;
  binDir: string;
  release: string;
  log: (message: string) => void;
}

export function publishVmAgentArtifacts(options: PublishVmAgentOptions): void {
  const { binDir, release, log, r2BucketName, ...rest } = options;
  const target: R2Target = { ...rest, bucketName: r2BucketName };
  // Same order as publish-vm-agent-artifacts.sh: every release key, then the legacy keys.
  const plan = [
    ...VM_AGENT_ARCHITECTURES.map((arch) => ({ arch, kind: 'release' as const })),
    ...VM_AGENT_ARCHITECTURES.map((arch) => ({ arch, kind: 'legacy' as const })),
  ];
  for (const { arch, kind } of plan) {
    const source = join(binDir, `vm-agent-linux-${arch}`);
    const builtSha = sha256Hex(readFileSync(source));
    const key = kind === 'release' ? vmAgentReleaseKey(release, arch) : vmAgentLegacyKey(arch);
    const action = decideVmAgentPublish(kind, key, existingObjectSha256(target, key), builtSha);
    if (action !== 'upload') {
      log(`vm-agent ${key}: ${action === 'reuse' ? 'identical, reused' : 'kept (legacy key)'}`);
      continue;
    }
    const put = spawnSync(
      target.celld,
      ['r2', 'put', r2BucketName, key, '--path', source, '--bucket', target.fleetBucket],
      { env: target.env, encoding: 'utf8' }
    );
    if (put.status !== 0) throw childFailure(`celld r2 put ${key}`, put, target.redact);
    // Read back: the object nodes will download must be the bytes that were built.
    const stored = existingObjectSha256(target, key);
    if (stored !== builtSha) {
      throw new Error(`vm-agent ${key}: read back sha256=${stored}, built sha256=${builtSha}`);
    }
    log(`vm-agent ${key}: uploaded and verified (sha256 ${builtSha})`);
  }
}
