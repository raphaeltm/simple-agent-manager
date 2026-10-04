/**
 * The minimum a bounded sleep fallback must keep before it may release compute:
 * a completed snapshot generation that records the exact Git commit the workspace was
 * on, with that commit's objects retained so a fresh workspace can restore it.
 *
 * A commit hash on its own is not restorable: if it was never pushed, a new clone
 * cannot fetch it. The WIP bundle a capture uploads holds the objects the restore
 * needs (pre-fix agents bundle the whole branch history; current agents bundle the
 * unpushed commits plus the snapshot commits on top of the remote refs). So the
 * fallback requires that bundle, verified in R2, unless the generation is a complete
 * snapshot, whose recorded artifacts are all verified instead.
 *
 * The restore this mirrors is the vm-agent's `restoreSessionSnapshot`
 * (`packages/vm-agent/internal/server/session_snapshot_restore.go`): it downloads every
 * recorded artifact, checks out `baseCommit` (on `manifest.git.branch` when present),
 * applies the WIP bundle, and — with no HOME archive — starts the agent fresh. Pre-fix
 * agents already run that path, so a Git-baseline wake needs no agent upgrade.
 */
import type * as schema from '../db/schema';
import type { Env } from '../env';
import { maybeJsonRecord, parseJsonRecord } from '../lib/runtime-validation';
import {
  type SessionSleepBlockedReason,
  type SessionSleepFallbackRecord,
  type SessionSleepRecoveryPoint,
  sleptFallbackRecord,
} from './session-sleep-episode';
import { verifySessionSnapshotRecordedArtifacts } from './session-snapshot-artifacts';

const FULL_GIT_OBJECT_ID = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;

export type SessionSleepRecoveryPointAssessment =
  | { ok: true; recoveryPoint: SessionSleepRecoveryPoint }
  | {
      ok: false;
      reason: Exclude<SessionSleepBlockedReason, 'unsupported_runtime' | 'retry_ceiling'>;
    };

interface ManifestGitState {
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  createdAt: string | null;
  commit: string | null;
}

function manifestGitState(manifestJson: string | null): ManifestGitState | null {
  if (!manifestJson) return null;
  try {
    const manifest = parseJsonRecord(manifestJson, 'session snapshot manifest');
    const git = maybeJsonRecord(manifest.git);
    return {
      branch: typeof git?.branch === 'string' && git.branch ? git.branch : null,
      detached: git?.detached === true,
      upstream: typeof git?.upstream === 'string' && git.upstream ? git.upstream : null,
      createdAt: typeof manifest.createdAt === 'string' ? manifest.createdAt : null,
      commit: typeof manifest.baseCommit === 'string' ? manifest.baseCommit : null,
    };
  } catch {
    return null;
  }
}

/**
 * Decide whether the session's current completed generation is a recovery point the
 * fallback may release compute with. Deterministic refusals are returned as a reason;
 * an R2 outage throws, so the caller counts it as a failed attempt and retries rather
 * than ending the episode on a transient fault.
 */
export async function assessSessionSleepRecoveryPoint(
  env: Env,
  snapshot: schema.SessionSnapshot | null,
  now: Date
): Promise<SessionSleepRecoveryPointAssessment> {
  if (!snapshot?.snapshotGeneration) return { ok: false, reason: 'no_git_baseline' };
  // `getRestorableSessionSnapshot` reports an expired row as status `expired`.
  const expiresAt = Date.parse(snapshot.expiresAt);
  if (snapshot.status === 'expired' || !Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
    return { ok: false, reason: 'recovery_point_expired' };
  }
  if (snapshot.status !== 'available' && snapshot.status !== 'degraded') {
    return { ok: false, reason: 'no_git_baseline' };
  }
  const git = manifestGitState(snapshot.manifestJson);
  const commit = snapshot.baseCommit ?? git?.commit ?? null;
  if (!git || !commit || !FULL_GIT_OBJECT_ID.test(commit)) {
    return { ok: false, reason: 'no_git_baseline' };
  }
  const complete = snapshot.status === 'available' && snapshot.degradation === 'none';
  // A degraded generation is only restorable at its commit when the bundle carrying the
  // commit objects was retained. A complete one carries them too.
  if (!snapshot.wipR2Key || !snapshot.wipSha256) {
    return { ok: false, reason: 'commit_objects_unavailable' };
  }
  if (!(await verifySessionSnapshotRecordedArtifacts(env, snapshot))) {
    return { ok: false, reason: 'commit_objects_unavailable' };
  }
  return {
    ok: true,
    recoveryPoint: {
      generation: snapshot.snapshotGeneration,
      commit,
      branch: git.detached ? null : git.branch,
      detached: git.detached,
      upstream: git.upstream,
      capturedAt: git.createdAt,
      snapshotStatus: snapshot.status,
      degradation: snapshot.degradation,
      workingTreeSaved: true,
      homeSaved: complete || Boolean(snapshot.homeR2Key),
    },
  };
}

/**
 * Re-check a `stopping` claim that a fallback recorded, before its teardown is rolled
 * forward after a crash: the decision must name the generation the row still holds,
 * and that recovery point must still verify. Mirrors `runSessionSleepFallback`.
 */
export async function confirmSessionSleepFallbackStopping(
  env: Env,
  snapshot: schema.SessionSnapshot,
  now: Date
): Promise<SessionSleepFallbackRecord | null> {
  const record = sleptFallbackRecord(snapshot);
  if (!record) return null;
  const assessment = await assessSessionSleepRecoveryPoint(env, snapshot, now);
  return assessment.ok ? record : null;
}
