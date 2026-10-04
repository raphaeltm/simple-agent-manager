import { eq } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import { maybeJsonRecord, parseJsonRecord } from '../lib/runtime-validation';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export const DEFAULT_SESSION_SNAPSHOT_TTL_DAYS = 7;
export const DEFAULT_SESSION_SNAPSHOT_TOTAL_BUDGET_BYTES = 256 * 1024 * 1024;
export const DEFAULT_SESSION_SNAPSHOT_ENTRY_THRESHOLD_BYTES = 256 * 1024 * 1024;
export const DEFAULT_SESSION_SNAPSHOT_TRANSFER_IDLE_TIMEOUT_MS = 30_000;
export const DEFAULT_SESSION_SNAPSHOT_JSON_BODY_MAX_BYTES = 256 * 1024;
export const DEFAULT_SESSION_SNAPSHOT_R2_PREFIX = 'session-snapshots';
export const DEFAULT_SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS = 3;
export const DEFAULT_SESSION_SLEEP_AFTER_MS = 15 * 60 * 1000;
export const DEFAULT_SESSION_SLEEP_CLAIM_LEASE_MS = 10 * 60 * 1000;
export const DEFAULT_SESSION_SLEEP_RETRY_DELAY_MS = 5 * 60 * 1000;
export const DEFAULT_SESSION_SLEEP_MAX_ATTEMPTS = 9;
export const DEFAULT_SESSION_SNAPSHOT_RECOVERY_CLAIM_LEASE_MS = 10 * 60 * 1000;

/**
 * Whether a snapshot's `status`/`degradation` pair still permits a restore.
 * The in-memory twin of `restorableSnapshotCondition()` in
 * `session-snapshot-recovery-lifecycle.ts`, which is the SQL predicate
 * `claimSessionSnapshotRecovery` uses to authorize a wake.
 *
 * Lives here (rather than beside the SQL) so the task-runtime liveness
 * classifier can mirror the real resume gate without duplicating the rule
 * (`.claude/rules/58-terminal-verdicts-must-match-the-resumer.md`).
 */
export function isRestorableSnapshot(status: string | null, degradation: string | null): boolean {
  return (
    (status === 'available' && degradation === 'none') ||
    (status === 'degraded' && Boolean(degradation) && degradation !== 'none')
  );
}

type SnapshotLeaseEnv = Env & {
  SESSION_SLEEP_CLAIM_LEASE_MS?: string;
  SESSION_SNAPSHOT_RECOVERY_CLAIM_LEASE_MS?: string;
  SESSION_SLEEP_RETRY_DELAY_MS?: string;
  SESSION_SLEEP_MAX_ATTEMPTS?: string;
  SESSION_LIFECYCLE_ERROR_MAX_LENGTH?: string;
};

export const DEFAULT_SESSION_LIFECYCLE_ERROR_MAX_LENGTH = 2048;

export function sessionLifecycleError(env: Env, error: unknown): string {
  const maxLength = parsePositiveInt(
    (env as SnapshotLeaseEnv).SESSION_LIFECYCLE_ERROR_MAX_LENGTH,
    DEFAULT_SESSION_LIFECYCLE_ERROR_MAX_LENGTH
  );
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, maxLength);
}

export type SessionSnapshotArtifact = 'home' | 'wip' | 'manifest';
export type SessionSnapshotStatus = 'pending' | 'available' | 'degraded' | 'failed' | 'expired';
export type SessionSnapshotDegradation =
  | 'none'
  | 'home-skipped'
  | 'wip-skipped'
  | 'entries-skipped'
  | 'agent-context-skipped'
  | 'wip-only'
  | 'transcript-only';

export interface SessionSnapshotManifest {
  version: 1;
  chatSessionId: string;
  workspaceId: string;
  agentSessionId?: string;
  acpSessionId?: string;
  agentType?: string;
  baseCommit?: string;
  git?: {
    branch?: string;
    upstream?: string;
    remote?: string;
    detached: boolean;
  };
  status: SessionSnapshotStatus;
  degradation: SessionSnapshotDegradation;
  skipped: Array<{
    path: string;
    reason: string;
    sizeBytes?: number;
  }>;
  artifacts: {
    home?: { sizeBytes: number; sha256?: string };
    wip?: { sizeBytes: number; sha256?: string };
  };
  createdAt: string;
}

export interface SessionSnapshotConfig {
  ttlDays: number;
  totalBudgetBytes: number;
  entryThresholdBytes: number;
  transferIdleTimeoutMs: number;
  jsonBodyMaxBytes: number;
  r2Prefix: string;
}

export type SessionSnapshotRecoveryClaim =
  | { status: 'claimed'; taskId: string }
  | { status: 'waking'; taskId: string }
  | { status: 'unavailable'; reason: string };

export type SessionSnapshotSleepClaim =
  | { status: 'claimed'; claimId: string; phase: 'preparing' | 'stopping' }
  | { status: 'unavailable'; reason: string };

export interface PrepareSessionSnapshotInput {
  workspaceId: string;
  nodeId: string | null;
  projectId: string | null;
  userId: string;
  chatSessionId: string;
  agentSessionId: string | null;
  runtime: string;
}

export interface CompleteSessionSnapshotInput {
  workspaceId: string;
  chatSessionId: string;
  agentSessionId: string | null;
  runtime: string;
  baseCommit: string | null;
  status: SessionSnapshotStatus;
  degradation: SessionSnapshotDegradation;
  captureGeneration?: string;
  artifactSha256?: { homeSha256?: string; wipSha256?: string };
  manifest: SessionSnapshotManifest;
  artifactSizes: {
    homeBytes?: number;
    wipBytes?: number;
  };
}

export interface SessionSnapshotCaptureState {
  status: string;
  degradation: string;
  snapshotGeneration: string | null;
  captureGeneration: string | null;
  captureError: string | null;
  updatedAt: string;
}

export async function getSessionSnapshotCaptureState(
  db: Db,
  chatSessionId: string
): Promise<SessionSnapshotCaptureState | null> {
  return (
    (await db
      .select({
        status: schema.sessionSnapshots.status,
        degradation: schema.sessionSnapshots.degradation,
        snapshotGeneration: schema.sessionSnapshots.snapshotGeneration,
        captureGeneration: schema.sessionSnapshots.captureGeneration,
        captureError: schema.sessionSnapshots.captureError,
        updatedAt: schema.sessionSnapshots.updatedAt,
      })
      .from(schema.sessionSnapshots)
      .where(eq(schema.sessionSnapshots.chatSessionId, chatSessionId))
      .get()) ?? null
  );
}

export function getSessionSnapshotConfig(env: Env): SessionSnapshotConfig {
  return {
    ttlDays: parsePositiveInt(env.SESSION_SNAPSHOT_TTL_DAYS, DEFAULT_SESSION_SNAPSHOT_TTL_DAYS),
    totalBudgetBytes: parsePositiveInt(
      env.SESSION_SNAPSHOT_TOTAL_BUDGET_BYTES,
      DEFAULT_SESSION_SNAPSHOT_TOTAL_BUDGET_BYTES
    ),
    entryThresholdBytes: parsePositiveInt(
      env.SESSION_SNAPSHOT_ENTRY_THRESHOLD_BYTES,
      DEFAULT_SESSION_SNAPSHOT_ENTRY_THRESHOLD_BYTES
    ),
    transferIdleTimeoutMs: parsePositiveInt(
      env.SESSION_SNAPSHOT_TRANSFER_IDLE_TIMEOUT_MS,
      DEFAULT_SESSION_SNAPSHOT_TRANSFER_IDLE_TIMEOUT_MS
    ),
    jsonBodyMaxBytes: parsePositiveInt(
      env.SESSION_SNAPSHOT_JSON_BODY_MAX_BYTES,
      DEFAULT_SESSION_SNAPSHOT_JSON_BODY_MAX_BYTES
    ),
    r2Prefix: sanitizeSnapshotPrefix(
      env.SESSION_SNAPSHOT_R2_PREFIX || DEFAULT_SESSION_SNAPSHOT_R2_PREFIX
    ),
  };
}

function sanitizeSnapshotPrefix(prefix: string): string {
  const normalized = prefix
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .replace(/[^A-Za-z0-9._/-]/g, '-');
  return normalized || DEFAULT_SESSION_SNAPSHOT_R2_PREFIX;
}

function sanitizeKeySegment(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]/g, '-');
}

function checksumHex(value: ArrayBuffer | undefined): string | null {
  if (!value) return null;
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function objectChecksumMatchesOrIsAbsent(
  object: { checksums: { sha256?: ArrayBuffer } },
  expectedSha256: string
): boolean {
  const actualSha256 = checksumHex(object.checksums.sha256);
  return actualSha256 === null || actualSha256 === expectedSha256.toLowerCase();
}

function manifestArtifactSize(
  manifestJson: string | null,
  artifact: 'home' | 'wip'
): number | null {
  if (!manifestJson) return null;
  try {
    const manifest = parseJsonRecord(manifestJson, 'session snapshot manifest');
    const artifacts = maybeJsonRecord(manifest.artifacts);
    const artifactEntry = maybeJsonRecord(artifacts?.[artifact]);
    if (!artifactEntry) return null;
    const size = artifactEntry.sizeBytes;
    return typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 ? size : null;
  } catch {
    return null;
  }
}

export function buildSessionSnapshotR2Key(
  env: Env,
  chatSessionId: string,
  generation: string,
  artifact: SessionSnapshotArtifact
): string {
  const { r2Prefix } = getSessionSnapshotConfig(env);
  const sessionKey = sanitizeKeySegment(chatSessionId);
  const generationKey = sanitizeKeySegment(generation);
  const suffix =
    artifact === 'home' ? 'home.tar' : artifact === 'wip' ? 'wip.bundle' : 'manifest.json';
  return `${r2Prefix}/${sessionKey}/${generationKey}/${suffix}`;
}

export function isSessionSnapshotSleepReleasable(
  snapshot: schema.SessionSnapshot | null | undefined
): snapshot is schema.SessionSnapshot {
  if (!snapshot?.snapshotGeneration || !snapshot.manifestR2Key || !snapshot.manifestJson) {
    return false;
  }
  if (snapshot.status === 'available') {
    return snapshot.degradation === 'none' && Boolean(snapshot.homeR2Key && snapshot.homeSha256);
  }
  return snapshot.status === 'degraded' && snapshot.degradation !== 'none';
}

/** Re-certify the exact immutable generation before releasing live compute. */
export async function verifyRestorableSessionSnapshotArtifacts(
  env: Env,
  snapshot: schema.SessionSnapshot
): Promise<boolean> {
  if (
    snapshot.status !== 'available' ||
    snapshot.degradation !== 'none' ||
    !snapshot.snapshotGeneration ||
    !snapshot.homeR2Key ||
    !snapshot.homeSha256 ||
    !snapshot.manifestR2Key
  ) {
    return false;
  }
  const expectedHomeKey = buildSessionSnapshotR2Key(
    env,
    snapshot.chatSessionId,
    snapshot.snapshotGeneration,
    'home'
  );
  const expectedManifestKey = buildSessionSnapshotR2Key(
    env,
    snapshot.chatSessionId,
    snapshot.snapshotGeneration,
    'manifest'
  );
  if (snapshot.homeR2Key !== expectedHomeKey || snapshot.manifestR2Key !== expectedManifestKey) {
    return false;
  }
  const homeSize = manifestArtifactSize(snapshot.manifestJson, 'home');
  if (homeSize === null) return false;

  const [home, manifest] = await Promise.all([
    env.R2.head(snapshot.homeR2Key),
    env.R2.head(snapshot.manifestR2Key),
  ]);
  if (
    !home ||
    !manifest ||
    home.size !== homeSize ||
    !objectChecksumMatchesOrIsAbsent(home, snapshot.homeSha256)
  ) {
    return false;
  }

  if (!snapshot.wipR2Key && !snapshot.wipSha256) return true;
  if (!snapshot.wipR2Key || !snapshot.wipSha256) return false;
  const expectedWipKey = buildSessionSnapshotR2Key(
    env,
    snapshot.chatSessionId,
    snapshot.snapshotGeneration,
    'wip'
  );
  const wipSize = manifestArtifactSize(snapshot.manifestJson, 'wip');
  if (snapshot.wipR2Key !== expectedWipKey || wipSize === null) return false;
  const wip = await env.R2.head(snapshot.wipR2Key);
  return (
    Boolean(wip) &&
    wip?.size === wipSize &&
    objectChecksumMatchesOrIsAbsent(wip, snapshot.wipSha256)
  );
}

/**
 * Re-certify every artifact a completed generation records, whatever its status: each
 * recorded HOME archive and WIP bundle must sit at its canonical key for that generation,
 * with the size the manifest declares and a matching SHA-256 where R2 reports one. A
 * restore downloads every recorded artifact and aborts on the first missing one, so a
 * recovery point is only as good as all of them. Used by the bounded sleep fallback
 * (`session-sleep-recovery-point.ts`), which may release compute with a degraded
 * generation; a full sleep keeps the stricter `verifySessionSnapshotArtifactsForSleep`.
 */
export async function verifySessionSnapshotRecordedArtifacts(
  env: Env,
  snapshot: schema.SessionSnapshot
): Promise<boolean> {
  const generation = snapshot.snapshotGeneration;
  if (!generation) return false;
  const checks: Array<{ key: string; size: number; sha256: string }> = [];
  for (const artifact of ['home', 'wip'] as const) {
    const key = artifact === 'home' ? snapshot.homeR2Key : snapshot.wipR2Key;
    const sha256 = artifact === 'home' ? snapshot.homeSha256 : snapshot.wipSha256;
    if (!key && !sha256) continue;
    if (!key || !sha256) return false;
    if (key !== buildSessionSnapshotR2Key(env, snapshot.chatSessionId, generation, artifact)) {
      return false;
    }
    const size = manifestArtifactSize(snapshot.manifestJson, artifact);
    if (size === null) return false;
    checks.push({ key, size, sha256 });
  }
  const objects = await Promise.all(checks.map((check) => env.R2.head(check.key)));
  return checks.every((check, index) => {
    const object = objects[index];
    return (
      Boolean(object) &&
      object?.size === check.size &&
      objectChecksumMatchesOrIsAbsent(object, check.sha256)
    );
  });
}

/**
 * Re-certify a snapshot generation that is safe to release compute for sleep.
 *
 * Only a complete `available/none` capture can release live compute. HOME
 * must exist and match the manifest; degraded captures remain wakeable but do
 * not prove that the live agent home was preserved.
 */
export async function verifySessionSnapshotArtifactsForSleep(
  env: Env,
  snapshot: schema.SessionSnapshot
): Promise<boolean> {
  // Releasing a live runtime requires its complete agent home. A degraded
  // snapshot remains useful for explicit recovery, but cannot authorize the
  // irreversible stop/sleep that would discard an uncaptured home.
  if (snapshot.status !== 'available' || snapshot.degradation !== 'none') return false;
  if (!snapshot.manifestJson) return false;
  let manifest: Record<string, unknown>;
  try {
    manifest = parseJsonRecord(snapshot.manifestJson, 'session snapshot manifest');
  } catch {
    return false;
  }
  if (
    manifest.version !== 1 ||
    manifest.chatSessionId !== snapshot.chatSessionId ||
    manifest.workspaceId !== snapshot.workspaceId ||
    manifest.status !== 'available' ||
    manifest.degradation !== 'none' ||
    (manifest.agentSessionId !== undefined && manifest.agentSessionId !== snapshot.agentSessionId)
  ) {
    return false;
  }
  const artifacts = maybeJsonRecord(manifest.artifacts);
  const home = maybeJsonRecord(artifacts?.home);
  const wip = maybeJsonRecord(artifacts?.wip);
  if (
    home?.sha256 !== snapshot.homeSha256 ||
    (snapshot.wipR2Key ? wip?.sha256 !== snapshot.wipSha256 : wip !== null)
  ) {
    return false;
  }
  return verifyRestorableSessionSnapshotArtifacts(env, snapshot);
}
