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
 * They are code defaults today. Making them admin settings is listed as follow-up work in the
 * PR that introduced them.
 */
export const DEFAULT_HOSTED_GIT_MAX_PUSH_BYTES = 64 * 1024 * 1024;
export const DEFAULT_HOSTED_GIT_MAX_REPO_OBJECTS = 30_000;
export const DEFAULT_HOSTED_GIT_MAX_REPO_BYTES = 256 * 1024 * 1024;

export interface HostedGitLimits {
  maxPushBytes: number;
  maxRepoObjects: number;
  maxRepoBytes: number;
}

export const DEFAULT_HOSTED_GIT_LIMITS: HostedGitLimits = {
  maxPushBytes: DEFAULT_HOSTED_GIT_MAX_PUSH_BYTES,
  maxRepoObjects: DEFAULT_HOSTED_GIT_MAX_REPO_OBJECTS,
  maxRepoBytes: DEFAULT_HOSTED_GIT_MAX_REPO_BYTES,
};

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
export function hostedGitPushByteBudget(currentBytes: number, limits: HostedGitLimits): number {
  return Math.max(0, Math.min(limits.maxPushBytes, limits.maxRepoBytes - currentBytes));
}

export function hostedGitPushTooLargeMessage(maxBytes: number): string {
  return `SAM: push refused: the pack is larger than the ${mib(maxBytes)} limit for one push to a SAM-hosted repository; push in smaller pieces`;
}
