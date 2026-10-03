import type { Env } from '../env';
import { log } from '../lib/logger';
import { redactSecretPatterns } from './secret-redaction';
import {
  buildSessionSnapshotR2Key,
  sessionLifecycleError,
  type SessionSnapshotArtifact,
} from './session-snapshot-artifacts';

export const SESSION_SNAPSHOT_CAPTURE_ARTIFACTS = [
  'home',
  'wip',
  'manifest',
] as const satisfies readonly SessionSnapshotArtifact[];

/** R2 keys a capture generation may have written for the given artifacts. */
export function sessionSnapshotCaptureKeys(
  env: Env,
  chatSessionId: string,
  generation: string,
  artifacts: readonly SessionSnapshotArtifact[] = SESSION_SNAPSHOT_CAPTURE_ARTIFACTS
): string[] {
  return artifacts.map((artifact) =>
    buildSessionSnapshotR2Key(env, chatSessionId, generation, artifact)
  );
}

/**
 * Best-effort removal of objects that a capture generation uploaded but that
 * will never become part of the session's snapshot. That covers a capture
 * superseded by a newer one, a capture that failed, and a completion that did
 * not record an artifact it had uploaded.
 *
 * Nothing references these objects once their generation is abandoned. The
 * snapshot row records only its completed generation's keys (or, before the
 * first completion, its latest capture's). Without this cleanup every
 * abandoned capture leaked its uploads: one stuck session left fifteen
 * orphaned 246.6 MiB wip.bundle objects on 2026-10-03. `keep` lists keys that
 * must survive regardless, such as the completed snapshot's.
 */
export async function deleteAbandonedSessionSnapshotObjects(
  env: Env,
  input: {
    chatSessionId: string;
    generation: string;
    keys: readonly string[];
    keep?: ReadonlyArray<string | null | undefined>;
  }
): Promise<void> {
  const keep = new Set(input.keep?.filter((key): key is string => Boolean(key)));
  const keys = [...new Set(input.keys)].filter((key) => !keep.has(key));
  if (keys.length === 0) return;
  try {
    await env.R2.delete(keys);
  } catch (error) {
    log.warn('session_snapshot.abandoned_capture_cleanup_failed', {
      chatSessionId: input.chatSessionId,
      generation: input.generation,
      keyCount: keys.length,
      error: sessionLifecycleError(
        env,
        redactSecretPatterns(error instanceof Error ? error.message : String(error))
      ),
    });
  }
}
