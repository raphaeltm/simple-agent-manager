/**
 * Caps for SAM-hosted repositories (the self-host Durable Object git server).
 *
 * Why these numbers (measured on celld 0.6.3 with the self-host box's settings, idea
 * 01M75V57RG8GR4NA0KC91TM1J7, "HOSTED REPOS ON DURABLE OBJECTS" part 6): every request to a
 * repository runs inside celld's node-wide 300 s handler budget, and one repository is one
 * single-threaded cell. A 24.8k-object repository (32 MiB pack) pushed in 29.5 s and cold-cloned
 * in 67 s; a 97k-object repository (448 MiB) could not cold-clone within 300 s at all, and the
 * cost grows faster than the object count. Ingest ran at about 5.5 MB/s.
 *
 * - Push: 64 MiB at ~5.5 MB/s is ~12 s of receive plus indexing and the connectivity check, well
 *   inside 300 s even for a fresh repository.
 * - Objects: 30,000 keeps a cold full clone near the measured 25k-object point (~70-90 s).
 * - Storage: 256 MiB of SQLite per repository (packs are stored about 1-2.5x their wire size).
 *
 * Administrators can lower these bounds through repositories.* settings. Maximums remain at
 * the measured safe envelope; increasing that envelope requires a new measurement.
 */
import {
  REPOSITORY_POLICY_DEFAULTS,
  type RepositoryPolicyKey,
} from '../../services/artifacts/settings';

export const DEFAULT_HOSTED_GIT_MAX_PUSH_BYTES = REPOSITORY_POLICY_DEFAULTS.maxPushBytes;
export const DEFAULT_HOSTED_GIT_MAX_REPO_OBJECTS = REPOSITORY_POLICY_DEFAULTS.maxRepoObjects;
export const DEFAULT_HOSTED_GIT_MAX_REPO_BYTES = REPOSITORY_POLICY_DEFAULTS.maxRepoBytes;
export type HostedGitLimits = { [K in RepositoryPolicyKey]: number };
export const DEFAULT_HOSTED_GIT_LIMITS: HostedGitLimits = REPOSITORY_POLICY_DEFAULTS;

function mib(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MiB`;
}

/**
 * Decide whether a push may start, from the repository's current size and the object count the
 * pushed pack declares in its header. Returns the refusal message shown to the git client, or
 * null when the push may proceed.
 */
export function hostedGitPushRefusal(
  current: { objects: number; bytes: number },
  incomingObjects: number,
  limits: HostedGitLimits
): string | null {
  if (current.bytes >= limits.maxRepoBytes) {
    return (
      `SAM: push refused: this repository already uses ${mib(current.bytes)} of its ` +
      `${mib(limits.maxRepoBytes)} storage limit`
    );
  }
  if (current.objects + incomingObjects > limits.maxRepoObjects) {
    return (
      `SAM: push refused: it would bring this repository to ${current.objects + incomingObjects} ` +
      `objects, over the ${limits.maxRepoObjects}-object limit for SAM-hosted repositories`
    );
  }
  return null;
}

/** The most bytes this push may stream: the push cap, or less when the repository is nearly full. */
/**
 * The refusal when a pack that fit the raw byte budget pushed stored size over the cap once its
 * index rows and page overhead were written (enforced at the final write, after ingest).
 */
export function hostedGitStoredOverCapMessage(
  storedBytes: number,
  limits: HostedGitLimits
): string {
  return (
    `SAM: push refused: storing this pack would bring this repository to ${mib(storedBytes)}, ` +
    `over its ${mib(limits.maxRepoBytes)} storage limit`
  );
}

export function hostedGitPushByteBudget(currentBytes: number, limits: HostedGitLimits): number {
  return Math.max(0, Math.min(limits.maxPushBytes, limits.maxRepoBytes - currentBytes));
}

export function hostedGitPushTooLargeMessage(maxBytes: number): string {
  return `SAM: push refused: the pack is larger than the ${mib(maxBytes)} limit for one push to a SAM-hosted repository; push in smaller pieces`;
}

/** SQLite page reserved for each new ref, including index overhead. */
const REF_RESERVATION_BYTES = 4096;

/** Bytes to reserve for the refs a push would create (deletions earn nothing). */
export function hostedGitNewRefBytes(
  existing: readonly { name: string }[],
  commands: readonly { ref: string; next: string }[]
): number {
  const refs = new Set(existing.map((ref) => ref.name));
  let additions = 0;
  for (const command of commands) {
    if (command.next !== '0'.repeat(40) && !refs.has(command.ref)) {
      additions++;
      refs.add(command.ref);
    }
  }
  return additions * REF_RESERVATION_BYTES;
}

/** Check ref-only pushes too. Reserve a SQLite page per new ref, including index overhead. */
export function hostedGitRefRefusal(
  existing: readonly { name: string }[],
  commands: readonly { ref: string; next: string }[],
  currentBytes: number,
  limits: HostedGitLimits
): string | null {
  const refs = new Set(existing.map((ref) => ref.name));
  let additions = 0;
  let writes = false;
  for (const command of commands) {
    // Do not credit deletions: their old-OID check may fail while an addition succeeds.
    if (command.next !== '0'.repeat(40)) {
      writes = true;
      if (!refs.has(command.ref)) additions++;
      refs.add(command.ref);
    }
  }
  // Deletions remain available when an administrator lowers a limit below current usage.
  if (!writes) return null;
  if (refs.size > limits.maxRepoRefs)
    return `SAM: push refused: repository exceeds its ${limits.maxRepoRefs}-ref limit`;
  if (currentBytes + additions * REF_RESERVATION_BYTES >= limits.maxRepoBytes)
    return 'SAM: push refused: repository storage limit leaves no room for ref updates';
  return null;
}
