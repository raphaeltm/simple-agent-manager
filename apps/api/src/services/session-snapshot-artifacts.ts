import { eq } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import { maybeJsonRecord, parseJsonRecord } from '../lib/runtime-validation';
import { ulid } from '../lib/ulid';

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

function manifestArtifact(
  manifestJson: string | null,
  artifact: 'home' | 'wip'
): { sizeBytes: number; sha256: string } | null {
  if (!manifestJson) return null;
  try {
    const manifest = parseJsonRecord(manifestJson, 'session snapshot manifest');
    const artifacts = maybeJsonRecord(manifest.artifacts);
    const artifactEntry = maybeJsonRecord(artifacts?.[artifact]);
    if (!artifactEntry) return null;
    const sizeBytes = artifactEntry.sizeBytes;
    const sha256 = artifactEntry.sha256;
    if (
      typeof sizeBytes !== 'number' ||
      !Number.isSafeInteger(sizeBytes) ||
      sizeBytes < 0 ||
      typeof sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(sha256)
    ) {
      return null;
    }
    return { sizeBytes, sha256: sha256.toLowerCase() };
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
    checksumHex(home.checksums.sha256) !== snapshot.homeSha256.toLowerCase()
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
    checksumHex(wip.checksums.sha256) === snapshot.wipSha256.toLowerCase()
  );
}

/**
 * Re-certify a snapshot generation that is safe to release compute for sleep.
 *
 * `available/none` keeps the stricter restorable contract: HOME must exist and
 * match the manifest. Degraded snapshots can release compute only after the
 * manifest is durable and every artifact still claimed by the manifest is
 * present with the expected key, size, and checksum. Transcript-only degraded
 * snapshots therefore verify the manifest and intentionally have no artifacts.
 */
export async function verifySessionSnapshotArtifactsForSleep(
  env: Env,
  snapshot: schema.SessionSnapshot
): Promise<boolean> {
  if (!isSessionSnapshotSleepReleasable(snapshot) || !snapshot.snapshotGeneration) return false;
  if (snapshot.status === 'available' && snapshot.degradation === 'none') {
    return verifyRestorableSessionSnapshotArtifacts(env, snapshot);
  }

  const expectedManifestKey = buildSessionSnapshotR2Key(
    env,
    snapshot.chatSessionId,
    snapshot.snapshotGeneration,
    'manifest'
  );
  if (snapshot.manifestR2Key !== expectedManifestKey) return false;

  const manifestJson = snapshot.manifestJson;
  if (!manifestJson) return false;
  let manifest: Record<string, unknown>;
  try {
    manifest = parseJsonRecord(manifestJson, 'session snapshot manifest');
  } catch {
    return false;
  }
  if (
    manifest.version !== 1 ||
    manifest.chatSessionId !== snapshot.chatSessionId ||
    manifest.workspaceId !== snapshot.workspaceId ||
    manifest.status !== snapshot.status ||
    manifest.degradation !== snapshot.degradation
  ) {
    return false;
  }

  const manifestHead = await env.R2.head(snapshot.manifestR2Key);
  if (!manifestHead) return false;

  for (const artifact of ['home', 'wip'] as const) {
    const claimed = manifestArtifact(snapshot.manifestJson, artifact);
    const key = artifact === 'home' ? snapshot.homeR2Key : snapshot.wipR2Key;
    const sha256 = artifact === 'home' ? snapshot.homeSha256 : snapshot.wipSha256;
    if (!claimed) {
      if (key || sha256) return false;
      continue;
    }
    if (!key || !sha256 || sha256.toLowerCase() !== claimed.sha256) return false;
    const expectedKey = buildSessionSnapshotR2Key(
      env,
      snapshot.chatSessionId,
      snapshot.snapshotGeneration,
      artifact
    );
    if (key !== expectedKey) return false;
    const object = await env.R2.head(key);
    if (
      !object ||
      object.size !== claimed.sizeBytes ||
      checksumHex(object.checksums.sha256) !== claimed.sha256
    ) {
      return false;
    }
  }

  return true;
}

function snapshotExpiry(now: Date, ttlDays: number): string {
  return new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
}

export async function prepareSessionSnapshot(
  db: Db,
  env: Env,
  input: PrepareSessionSnapshotInput
): Promise<{
  snapshotId: string;
  generation: string;
  expiresAt: string;
  keys: Record<SessionSnapshotArtifact, string>;
  config: SessionSnapshotConfig;
}> {
  const config = getSessionSnapshotConfig(env);
  const now = new Date();
  const expiresAt = snapshotExpiry(now, config.ttlDays);
  const generation = ulid();
  const keys = {
    home: buildSessionSnapshotR2Key(env, input.chatSessionId, generation, 'home'),
    wip: buildSessionSnapshotR2Key(env, input.chatSessionId, generation, 'wip'),
    manifest: buildSessionSnapshotR2Key(env, input.chatSessionId, generation, 'manifest'),
  };

  const existing = await db
    .select({
      id: schema.sessionSnapshots.id,
      status: schema.sessionSnapshots.status,
      sleepStatus: schema.sessionSnapshots.sleepStatus,
      sleepingAt: schema.sessionSnapshots.sleepingAt,
    })
    .from(schema.sessionSnapshots)
    .where(eq(schema.sessionSnapshots.chatSessionId, input.chatSessionId))
    .limit(1);

  const snapshotId = existing[0]?.id || ulid();
  const row = {
    id: snapshotId,
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    nodeId: input.nodeId,
    userId: input.userId,
    chatSessionId: input.chatSessionId,
    agentSessionId: input.agentSessionId,
    runtime: input.runtime,
    status: 'pending',
    degradation: 'none',
    homeR2Key: keys.home,
    wipR2Key: keys.wip,
    manifestR2Key: keys.manifest,
    baseCommit: null,
    expiresAt,
    manifestJson: null,
    restoreStatus: null,
    restoreMessage: null,
    restoredAt: null,
    sleepingAt: null,
    recoveryStatus: null,
    recoveryTaskId: null,
    recoveryWorkspaceId: null,
    recoveryAttempts: 0,
    recoveryError: null,
    recoveryClaimedAt: null,
    snapshotGeneration: null,
    captureGeneration: generation,
    homeSha256: null,
    wipSha256: null,
    updatedAt: now.toISOString(),
  } satisfies schema.NewSessionSnapshot;

  if (existing[0]) {
    const current = existing[0];
    if (current.sleepingAt || current.sleepStatus === 'sleeping') {
      // A background capture can outlive the sleep operation that requested it.
      // Once the session is durably sleeping, a stale prepare must not overwrite
      // the terminal restorable generation or re-open capture_generation.
    } else if (current.status === 'available' || current.status === 'degraded') {
      // A checkpoint upload is not the current snapshot until completion
      // certifies it. Preserve the last complete generation and lifecycle state
      // so an interrupted capture cannot make a sleeping session unwakeable.
      await db
        .update(schema.sessionSnapshots)
        .set({
          workspaceId: input.workspaceId,
          nodeId: input.nodeId,
          projectId: input.projectId,
          userId: input.userId,
          agentSessionId: input.agentSessionId,
          runtime: input.runtime,
          captureGeneration: generation,
          updatedAt: now.toISOString(),
        })
        .where(eq(schema.sessionSnapshots.id, snapshotId));
    } else {
      await db
        .update(schema.sessionSnapshots)
        .set(row)
        .where(eq(schema.sessionSnapshots.id, snapshotId));
    }
  } else {
    await db.insert(schema.sessionSnapshots).values({ ...row, createdAt: now.toISOString() });
  }

  return { snapshotId, generation, expiresAt, keys, config };
}

/**
 * Establishes the D1 lifecycle lock row before a first checkpoint exists.
 * Explicit/task-completion sleep can therefore claim the session while an
 * idle checkpoint is still running (or before the idle callback arrives).
 * The placeholder generation is never restorable and writes no R2 objects.
 */
export async function ensureSessionSnapshotForSleep(
  db: Db,
  env: Env,
  input: PrepareSessionSnapshotInput
): Promise<void> {
  const now = new Date();
  const placeholderGeneration = ulid();
  await db
    .insert(schema.sessionSnapshots)
    .values({
      id: ulid(),
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      nodeId: input.nodeId,
      userId: input.userId,
      chatSessionId: input.chatSessionId,
      agentSessionId: input.agentSessionId,
      runtime: input.runtime,
      status: 'pending',
      degradation: 'none',
      manifestR2Key: buildSessionSnapshotR2Key(
        env,
        input.chatSessionId,
        placeholderGeneration,
        'manifest'
      ),
      expiresAt: snapshotExpiry(now, getSessionSnapshotConfig(env).ttlDays),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    })
    .onConflictDoUpdate({
      target: schema.sessionSnapshots.chatSessionId,
      // Recovery can move a conversation to a replacement workspace. Refresh
      // only ownership/routing metadata here: the last verified generation and
      // all sleep/recovery lifecycle state remain authoritative until the final
      // capture replaces them.
      set: {
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        nodeId: input.nodeId,
        userId: input.userId,
        agentSessionId: input.agentSessionId,
        runtime: input.runtime,
        updatedAt: now.toISOString(),
      },
    });
}
