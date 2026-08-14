import { and, eq } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import {
  buildSessionSnapshotR2Key,
  type CompleteSessionSnapshotInput,
  getSessionSnapshotConfig,
} from './session-snapshot-artifacts';
import { scheduleSessionSnapshotSleep } from './session-snapshot-sleep-lifecycle';

type Db = ReturnType<typeof drizzle<typeof schema>>;

function snapshotExpiry(now: Date, ttlDays: number): string {
  return new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
}

/** Explicit archive/delete is destructive: remove object state before metadata. */
export async function deleteSessionSnapshotState(
  db: Db,
  env: Env,
  chatSessionId: string
): Promise<boolean> {
  const snapshot = await db
    .select({
      id: schema.sessionSnapshots.id,
      homeR2Key: schema.sessionSnapshots.homeR2Key,
      wipR2Key: schema.sessionSnapshots.wipR2Key,
      manifestR2Key: schema.sessionSnapshots.manifestR2Key,
    })
    .from(schema.sessionSnapshots)
    .where(eq(schema.sessionSnapshots.chatSessionId, chatSessionId))
    .get();
  if (!snapshot) return false;
  const keys = [snapshot.homeR2Key, snapshot.wipR2Key, snapshot.manifestR2Key].filter(
    (key): key is string => Boolean(key)
  );
  if (keys.length > 0) await env.R2.delete(keys);
  await db.delete(schema.sessionSnapshots).where(eq(schema.sessionSnapshots.id, snapshot.id));
  return true;
}

export async function completeSessionSnapshot(
  db: Db,
  env: Env,
  input: CompleteSessionSnapshotInput
): Promise<void> {
  if (
    (input.artifactSizes.homeBytes != null) !== Boolean(input.artifactSha256?.homeSha256) ||
    (input.artifactSizes.wipBytes != null) !== Boolean(input.artifactSha256?.wipSha256)
  ) {
    throw new Error('Snapshot artifact hashes must match the captured artifacts');
  }
  const current = await db
    .select({
      captureGeneration: schema.sessionSnapshots.captureGeneration,
      homeR2Key: schema.sessionSnapshots.homeR2Key,
      wipR2Key: schema.sessionSnapshots.wipR2Key,
      manifestR2Key: schema.sessionSnapshots.manifestR2Key,
    })
    .from(schema.sessionSnapshots)
    .where(eq(schema.sessionSnapshots.chatSessionId, input.chatSessionId))
    .get();
  const captureGeneration = input.captureGeneration ?? current?.captureGeneration;
  if (!captureGeneration || captureGeneration !== current?.captureGeneration) {
    throw new Error('Snapshot capture generation is no longer current');
  }
  const homeR2Key =
    input.artifactSizes.homeBytes == null
      ? null
      : buildSessionSnapshotR2Key(env, input.chatSessionId, captureGeneration, 'home');
  const wipR2Key =
    input.artifactSizes.wipBytes == null
      ? null
      : buildSessionSnapshotR2Key(env, input.chatSessionId, captureGeneration, 'wip');
  const manifestR2Key = buildSessionSnapshotR2Key(
    env,
    input.chatSessionId,
    captureGeneration,
    'manifest'
  );
  const manifestJson = JSON.stringify(input.manifest);
  const completedAt = new Date();
  await env.R2.put(manifestR2Key, manifestJson, {
    httpMetadata: { contentType: 'application/json' },
  });

  const completed = await db
    .update(schema.sessionSnapshots)
    .set({
      agentSessionId: input.agentSessionId,
      runtime: input.runtime,
      status: input.status,
      degradation: input.degradation,
      homeR2Key,
      wipR2Key,
      manifestR2Key,
      snapshotGeneration: captureGeneration,
      captureGeneration: null,
      homeSha256: input.artifactSha256?.homeSha256 ?? null,
      wipSha256: input.artifactSha256?.wipSha256 ?? null,
      baseCommit: input.baseCommit,
      manifestJson,
      expiresAt: snapshotExpiry(completedAt, getSessionSnapshotConfig(env).ttlDays),
      updatedAt: completedAt.toISOString(),
    })
    .where(
      and(
        eq(schema.sessionSnapshots.chatSessionId, input.chatSessionId),
        eq(schema.sessionSnapshots.captureGeneration, captureGeneration)
      )
    );
  if (!(completed.meta.changes ?? 0)) {
    throw new Error('Snapshot completion lost its capture-generation claim');
  }

  const oldKeys = [current?.homeR2Key, current?.wipR2Key, current?.manifestR2Key].filter(
    (key): key is string =>
      Boolean(key) && key !== homeR2Key && key !== wipR2Key && key !== manifestR2Key
  );
  if (oldKeys.length > 0) {
    await env.R2.delete(oldKeys).catch(() => undefined);
  }

  if (input.status === 'available' && input.degradation === 'none') {
    await scheduleSessionSnapshotSleep(db, env, input.chatSessionId, completedAt, {
      runtime: input.runtime,
    });
  }
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
