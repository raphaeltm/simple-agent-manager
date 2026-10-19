/**
 * Optional exact Git recovery assessment for the bounded sleep fallback.
 * A verified point allows file restoration; its absence never prevents exhausted
 * idle-runtime cleanup. The fallback instead retains backups and continues fresh
 * from the transcript, without claiming exact recovery.
 */
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { maybeJsonRecord, parseJsonRecord } from '../lib/runtime-validation';
import {
  serializeSessionSleepFallbackRecord,
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
 * fallback may restore files from. Deterministic refusals are returned as a reason;
 * an R2 outage throws, and the bounded fallback treats it as unavailable recovery
 * while retaining the saved artifacts and proceeding through guarded cleanup.
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
  // commit objects was retained. A complete one carries them too. Accepting a pushed
  // commit without a bundle needs a remote check (idea 01M434S53HGTY09BS09NMWEP9E).
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
  if (!record || !snapshot.sleepClaimId || !snapshot.sleepFallbackJson) return null;
  if (!record.recoveryPoint) return record;
  const assessment = await assessSessionSleepRecoveryPoint(env, snapshot, now).catch(() => ({
    ok: false as const,
  }));
  if (assessment.ok) return record;
  const degraded = { ...record, recoveryPoint: null, decidedAt: now.toISOString() };
  const result = await drizzle(env.DATABASE, { schema })
    .update(schema.sessionSnapshots)
    .set({ sleepFallbackJson: serializeSessionSleepFallbackRecord(degraded) })
    .where(
      and(
        eq(schema.sessionSnapshots.id, snapshot.id),
        eq(schema.sessionSnapshots.sleepStatus, 'stopping'),
        eq(schema.sessionSnapshots.sleepClaimId, snapshot.sleepClaimId),
        eq(schema.sessionSnapshots.sleepFallbackJson, snapshot.sleepFallbackJson)
      )
    );
  return (result.meta.changes ?? 0) > 0 ? degraded : null;
}
