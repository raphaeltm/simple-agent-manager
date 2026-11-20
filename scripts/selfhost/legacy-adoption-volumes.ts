/**
 * Volume moves for legacy adoption (legacy-adoption.ts). Each legacy volume is copied into a new
 * canonical volume by a short-lived helper container with a deterministic name, so a copy killed
 * with its operator process can be found and removed before it is retried. Copies are verified
 * by a digest of every path's type, owner and mode plus every file's content (directory sizes are
 * not compared: ext4 never shrinks a directory, so an emptied-and-recopied one differs).
 */
import { type BoxContext, check } from './backup-lib';

/**
 * Digest-pinned Alpine (busybox: sh, cp, find, stat, sha256sum): the egress fence's own base
 * (deploy/selfhost/egress-fence/Dockerfile, kept equal by a test). Installs older than the fence
 * never built a local image, so the pinned base is pulled before adoption changes anything.
 */
export const DEFAULT_ADOPTION_HELPER_IMAGE =
  'alpine:3.22@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f';

/** Present or pulled before any mutation, so a missing image cannot strand a stopped stack. */
export function ensureHelperImage(ctx: Pick<BoxContext, 'run'>, image: string): void {
  if (ctx.run('docker', ['image', 'inspect', '--format', '{{.Id}}', image]).status === 0) return;
  check(ctx.run('docker', ['pull', '--quiet', image]), 'pull adoption helper image');
}
/** Marks a canonical volume this adoption created, with the journal's random adoption id. */
export const ADOPTION_LABEL = 'sam.selfhost.legacy-adoption';

const PROJECT_LABEL = 'com.docker.compose.project';
const VOLUME_LABEL = 'com.docker.compose.volume';

/** Same digest on both sides; paths are sorted so readdir order does not matter. */
const DIGEST_SCRIPT =
  'set -eu; cd "$1"; ' +
  "{ find . -exec stat -c '%n|%F|%u|%g|%a' {} + | LC_ALL=C sort; " +
  "find . -type f -exec sha256sum {} + | LC_ALL=C sort -k2; } | sha256sum | cut -d' ' -f1";

/** Empty the destination first: a retry after a kill must not merge with a partial copy. */
const COPY_SCRIPT = 'set -eu; find /to -mindepth 1 -delete; cp -a /from/. /to/';

export function helperName(canonicalProject: string, suffix: string): string {
  return `${canonicalProject}-legacy-adoption-${suffix}`;
}

/** Every helper container name an adoption of these volumes can leave behind. */
export function helperNames(canonicalProject: string, suffixes: readonly string[]): string[] {
  return [
    ...suffixes.flatMap((suffix) => {
      const name = helperName(canonicalProject, suffix);
      return [name, `${name}-digest`];
    }),
    helperName(canonicalProject, 'cache-return'),
    `${helperName(canonicalProject, 'cache-return')}-digest`,
  ];
}

export interface Helper {
  image: string;
  /** The journal's adoption id: helpers are labelled with it so a retry removes only its own. */
  adoptionId: string;
}

function helperArgs(helper: Helper, name: string, mounts: string[], script: string[]): string[] {
  return [
    'run',
    '--rm',
    '--name',
    name,
    '--label',
    `${ADOPTION_LABEL}=${helper.adoptionId}`,
    '--network',
    'none',
    '--cap-drop',
    'ALL',
    // Root needs these to read every file and recreate exact owners, modes and setuid bits.
    ...['CHOWN', 'FOWNER', 'DAC_OVERRIDE', 'DAC_READ_SEARCH', 'FSETID'].flatMap((cap) => [
      '--cap-add',
      cap,
    ]),
    '--security-opt',
    'no-new-privileges',
    ...mounts.flatMap((mount) => ['-v', mount]),
    '--entrypoint',
    'sh',
    helper.image,
    '-c',
    ...script,
  ];
}

interface VolumeDetail {
  Name?: unknown;
  CreatedAt?: unknown;
  Labels?: Record<string, unknown> | null;
}

function inspectVolume(ctx: Pick<BoxContext, 'run'>, name: string): VolumeDetail | null {
  const result = ctx.run('docker', ['volume', 'inspect', name]);
  if (result.status !== 0) {
    if (/no such volume/i.test(result.stderr)) return null;
    check(result, 'inspect adoption volume');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error('Legacy adoption: cannot parse a volume inspection');
  }
  if (!Array.isArray(parsed) || parsed.length !== 1)
    throw new Error('Legacy adoption: ambiguous volume inspection');
  return parsed[0] as VolumeDetail;
}

export interface CanonicalVolume {
  name: string;
  createdAt: string;
}

/** A canonical volume this adoption (and only this adoption) created, or null when absent. */
export function ownedCanonicalVolume(
  ctx: Pick<BoxContext, 'run'>,
  canonicalProject: string,
  suffix: string,
  adoptionId: string,
  expectedCreatedAt?: string
): CanonicalVolume | null {
  const name = `${canonicalProject}_${suffix}`;
  const detail = inspectVolume(ctx, name);
  if (!detail) return null;
  const labels = detail.Labels ?? {};
  if (
    detail.Name !== name ||
    labels[PROJECT_LABEL] !== canonicalProject ||
    labels[VOLUME_LABEL] !== suffix ||
    labels[ADOPTION_LABEL] !== adoptionId ||
    typeof detail.CreatedAt !== 'string' ||
    (expectedCreatedAt !== undefined && detail.CreatedAt !== expectedCreatedAt)
  )
    throw new Error(
      `Legacy adoption refused: ${name} exists but was not created by this adoption; inspect it`
    );
  return { name, createdAt: detail.CreatedAt };
}

/** Creates the canonical volume with the labels Compose expects plus this adoption's id. */
export function createCanonicalVolume(
  ctx: Pick<BoxContext, 'run'>,
  canonicalProject: string,
  suffix: string,
  adoptionId: string
): CanonicalVolume {
  const name = `${canonicalProject}_${suffix}`;
  check(
    ctx.run('docker', [
      'volume',
      'create',
      '--label',
      `${PROJECT_LABEL}=${canonicalProject}`,
      '--label',
      `${VOLUME_LABEL}=${suffix}`,
      '--label',
      `${ADOPTION_LABEL}=${adoptionId}`,
      name,
    ]),
    'create canonical volume'
  );
  const created = ownedCanonicalVolume(ctx, canonicalProject, suffix, adoptionId);
  if (!created) throw new Error(`Legacy adoption: ${name} was not created`);
  return created;
}

/** Removes a helper a killed run left behind: only the exact name, and only if it is ours. */
export function removeStaleHelper(
  ctx: Pick<BoxContext, 'run'>,
  helper: Helper,
  name: string
): void {
  const result = ctx.run('docker', [
    'inspect',
    '--type',
    'container',
    '--format',
    `{{index .Config.Labels "${ADOPTION_LABEL}"}}`,
    name,
  ]);
  if (result.status !== 0) {
    if (/no such (object|container)/i.test(result.stderr)) return;
    check(result, 'inspect adoption helper');
  }
  if (result.stdout.trim() !== helper.adoptionId)
    throw new Error(`Legacy adoption refused: container ${name} is not this adoption's helper`);
  check(ctx.run('docker', ['rm', '--force', name]), 'remove stale adoption helper');
}

export function volumeDigest(
  ctx: Pick<BoxContext, 'run'>,
  helper: Helper,
  name: string,
  container: string
): string {
  removeStaleHelper(ctx, helper, container);
  const digest = check(
    ctx.run(
      'docker',
      helperArgs(helper, container, [`${name}:/data:ro`], [DIGEST_SCRIPT, 'digest', '/data'])
    ),
    'digest adoption volume'
  ).stdout.trim();
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Legacy adoption: invalid volume digest');
  return digest;
}

/** Copies `from` into `to` (emptied first) and proves the two digests are equal. */
export function copyVolume(
  ctx: Pick<BoxContext, 'run'>,
  helper: Helper,
  from: string,
  to: string,
  container: string
): string {
  removeStaleHelper(ctx, helper, container);
  check(
    ctx.run(
      'docker',
      helperArgs(helper, container, [`${from}:/from:ro`, `${to}:/to`], [COPY_SCRIPT])
    ),
    'copy legacy volume'
  );
  const source = volumeDigest(ctx, helper, from, `${container}-digest`);
  const copy = volumeDigest(ctx, helper, to, `${container}-digest`);
  if (source !== copy)
    throw new Error(`Legacy adoption: copy of ${from} does not match its source`);
  return copy;
}

export function removeVolume(ctx: Pick<BoxContext, 'run'>, name: string): void {
  check(ctx.run('docker', ['volume', 'rm', name]), 'remove canonical adoption volume');
}
