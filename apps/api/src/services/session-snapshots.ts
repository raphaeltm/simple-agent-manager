import { eq } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';
import { ulid } from '../lib/ulid';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export const DEFAULT_SESSION_SNAPSHOT_TTL_DAYS = 7;
export const DEFAULT_SESSION_SNAPSHOT_TOTAL_BUDGET_BYTES = 100 * 1024 * 1024;
export const DEFAULT_SESSION_SNAPSHOT_ENTRY_THRESHOLD_BYTES = 50 * 1024 * 1024;
export const DEFAULT_SESSION_SNAPSHOT_TRANSFER_IDLE_TIMEOUT_MS = 30_000;
export const DEFAULT_SESSION_SNAPSHOT_JSON_BODY_MAX_BYTES = 256 * 1024;
export const DEFAULT_SESSION_SNAPSHOT_R2_PREFIX = 'session-snapshots';

export type SessionSnapshotArtifact = 'home' | 'wip' | 'manifest';
export type SessionSnapshotStatus = 'pending' | 'available' | 'degraded' | 'failed' | 'expired';
export type SessionSnapshotDegradation = 'none' | 'home-skipped' | 'wip-only' | 'transcript-only';

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
  manifest: SessionSnapshotManifest;
  artifactSizes: {
    homeBytes?: number;
    wipBytes?: number;
  };
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

export function buildSessionSnapshotR2Key(
  env: Env,
  chatSessionId: string,
  artifact: SessionSnapshotArtifact
): string {
  const { r2Prefix } = getSessionSnapshotConfig(env);
  const sessionKey = sanitizeKeySegment(chatSessionId);
  const suffix =
    artifact === 'home' ? 'home.tar' : artifact === 'wip' ? 'wip.bundle' : 'manifest.json';
  return `${r2Prefix}/${sessionKey}/${suffix}`;
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
  expiresAt: string;
  keys: Record<SessionSnapshotArtifact, string>;
  config: SessionSnapshotConfig;
}> {
  const config = getSessionSnapshotConfig(env);
  const now = new Date();
  const expiresAt = snapshotExpiry(now, config.ttlDays);
  const keys = {
    home: buildSessionSnapshotR2Key(env, input.chatSessionId, 'home'),
    wip: buildSessionSnapshotR2Key(env, input.chatSessionId, 'wip'),
    manifest: buildSessionSnapshotR2Key(env, input.chatSessionId, 'manifest'),
  };

  const existing = await db
    .select({ id: schema.sessionSnapshots.id })
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
    updatedAt: now.toISOString(),
  } satisfies schema.NewSessionSnapshot;

  if (existing[0]) {
    await db
      .update(schema.sessionSnapshots)
      .set(row)
      .where(eq(schema.sessionSnapshots.id, snapshotId));
  } else {
    await db.insert(schema.sessionSnapshots).values({ ...row, createdAt: now.toISOString() });
  }

  return { snapshotId, expiresAt, keys, config };
}

export async function completeSessionSnapshot(
  db: Db,
  env: Env,
  input: CompleteSessionSnapshotInput
): Promise<void> {
  const homeR2Key =
    input.artifactSizes.homeBytes == null
      ? null
      : buildSessionSnapshotR2Key(env, input.chatSessionId, 'home');
  const wipR2Key =
    input.artifactSizes.wipBytes == null
      ? null
      : buildSessionSnapshotR2Key(env, input.chatSessionId, 'wip');
  const manifestR2Key = buildSessionSnapshotR2Key(env, input.chatSessionId, 'manifest');
  const manifestJson = JSON.stringify(input.manifest);
  await env.R2.put(manifestR2Key, manifestJson, {
    httpMetadata: { contentType: 'application/json' },
  });

  await db
    .update(schema.sessionSnapshots)
    .set({
      agentSessionId: input.agentSessionId,
      runtime: input.runtime,
      status: input.status,
      degradation: input.degradation,
      homeR2Key,
      wipR2Key,
      manifestR2Key,
      baseCommit: input.baseCommit,
      manifestJson,
      expiresAt:
        (
          await db
            .select({ expiresAt: schema.sessionSnapshots.expiresAt })
            .from(schema.sessionSnapshots)
            .where(eq(schema.sessionSnapshots.chatSessionId, input.chatSessionId))
            .limit(1)
        )[0]?.expiresAt || snapshotExpiry(new Date(), getSessionSnapshotConfig(env).ttlDays),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.sessionSnapshots.chatSessionId, input.chatSessionId));
}

export async function getRestorableSessionSnapshot(
  db: Db,
  chatSessionId: string,
  now = new Date()
): Promise<schema.SessionSnapshot | null> {
  const rows = await db
    .select()
    .from(schema.sessionSnapshots)
    .where(eq(schema.sessionSnapshots.chatSessionId, chatSessionId))
    .limit(1);
  const snapshot = rows[0];
  if (!snapshot) return null;
  if (Date.parse(snapshot.expiresAt) <= now.getTime()) {
    return { ...snapshot, status: 'expired' };
  }
  if (snapshot.status !== 'available' && snapshot.status !== 'degraded') {
    return null;
  }
  return snapshot;
}

export async function recordSessionSnapshotRestoreResult(
  db: Db,
  input: {
    chatSessionId: string;
    status: string;
    message: string | null;
  }
): Promise<void> {
  await db
    .update(schema.sessionSnapshots)
    .set({
      restoreStatus: input.status,
      restoreMessage: input.message,
      restoredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.sessionSnapshots.chatSessionId, input.chatSessionId));
}

export async function deleteSessionSnapshotArtifacts(
  env: Env,
  chatSessionId: string
): Promise<void> {
  await Promise.all(
    (['home', 'wip', 'manifest'] as const).map((artifact) =>
      env.R2.delete(buildSessionSnapshotR2Key(env, chatSessionId, artifact)).catch((err) => {
        log.warn('session_snapshot.r2_delete_failed', {
          chatSessionId,
          artifact,
          error: err instanceof Error ? err.message : String(err),
        });
      })
    )
  );
}
