import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { ProjectData } from '../durable-objects/project-data';
import type { Env } from '../env';
import { resolveD1BindingIdentity } from '../lib/d1-session';
import { maybeJsonRecord } from '../lib/runtime-validation';
import { errors } from '../middleware/error';
import { buildSessionSnapshotR2Key, getSessionSnapshotConfig } from './session-snapshot-artifacts';

export type OwnerSnapshotArtifact = 'manifest' | 'wip';
export const retainedSnapshotNotFound = () => errors.notFound('Retained snapshot');
const SHA256 = /^[a-f0-9]{64}$/;
const encoder = new TextEncoder();

function hex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Fresh primary reads are required: a request's D1 replica bookmark cannot see concurrent expiry. */
async function authorizedSnapshot(env: Env, projectId: string, sessionId: string, userId: string) {
  const db = drizzle(resolveD1BindingIdentity(env.DATABASE), { schema });
  // One primary statement binds current account, membership and snapshot ownership together.
  // This is the same active-membership project-read contract as requireProjectAccess, without
  // a gap between checking membership and reading the retained capture.
  const readSnapshot = () =>
    db
      .select({ snapshot: schema.sessionSnapshots })
      .from(schema.sessionSnapshots)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.sessionSnapshots.projectId))
      .innerJoin(
        schema.projectMembers,
        and(
          eq(schema.projectMembers.projectId, schema.projects.id),
          eq(schema.projectMembers.userId, schema.sessionSnapshots.userId)
        )
      )
      .innerJoin(schema.users, eq(schema.users.id, schema.sessionSnapshots.userId))
      .where(
        and(
          eq(schema.sessionSnapshots.projectId, projectId),
          eq(schema.sessionSnapshots.chatSessionId, sessionId),
          eq(schema.sessionSnapshots.userId, userId),
          eq(schema.projectMembers.status, 'active'),
          eq(schema.users.status, 'active')
        )
      )
      .get();
  // Deny foreign/missing projects before resolving any Durable Object.
  if (!(await exportDeadline(env, readSnapshot))) throw retainedSnapshotNotFound();
  // Session metadata remains canonical in the project's root DO even when transcript data is archived.
  // Direct read deliberately avoids ensureProjectId writes and retry logging of provider error text.
  const stub = env.PROJECT_DATA.get(
    env.PROJECT_DATA.idFromName(projectId)
  ) as DurableObjectStub<ProjectData>;
  const session = maybeJsonRecord(await exportDeadline(env, () => stub.getSession(sessionId)));
  if (!session || session.createdByUserId !== userId) throw retainedSnapshotNotFound();
  const snapshot = (await exportDeadline(env, readSnapshot))?.snapshot;
  if (
    !snapshot ||
    snapshot.projectId !== projectId ||
    snapshot.chatSessionId !== sessionId ||
    snapshot.userId !== userId ||
    !snapshot.snapshotGeneration ||
    !['available', 'degraded'].includes(snapshot.status) ||
    !Number.isFinite(Date.parse(snapshot.expiresAt)) ||
    Date.parse(snapshot.expiresAt) <= Date.now()
  ) {
    throw retainedSnapshotNotFound();
  }
  return snapshot;
}

function exportContract(
  env: Env,
  snapshot: schema.SessionSnapshot,
  artifact: OwnerSnapshotArtifact
) {
  const generation = snapshot.snapshotGeneration;
  if (!generation) throw retainedSnapshotNotFound();
  const config = getSessionSnapshotConfig(env);
  const json = snapshot.manifestJson;
  if (!json || encoder.encode(json).byteLength > config.jsonBodyMaxBytes)
    throw retainedSnapshotNotFound();
  let manifest: Record<string, unknown> | null;
  try {
    manifest = maybeJsonRecord(JSON.parse(json));
  } catch {
    throw retainedSnapshotNotFound();
  }
  if (
    !manifest ||
    manifest.version !== 1 ||
    manifest.chatSessionId !== snapshot.chatSessionId ||
    typeof manifest.workspaceId !== 'string' ||
    !manifest.workspaceId ||
    (snapshot.workspaceId !== null && manifest.workspaceId !== snapshot.workspaceId) ||
    (manifest.agentSessionId ?? null) !== snapshot.agentSessionId ||
    (manifest.baseCommit ?? null) !== snapshot.baseCommit ||
    manifest.status !== snapshot.status ||
    manifest.degradation !== snapshot.degradation
  )
    throw retainedSnapshotNotFound();
  const manifestKey = buildSessionSnapshotR2Key(
    env,
    snapshot.chatSessionId,
    generation,
    'manifest'
  );
  if (snapshot.manifestR2Key !== manifestKey) throw retainedSnapshotNotFound();
  if (artifact === 'manifest')
    return { key: manifestKey, size: encoder.encode(json).byteLength, sha256: null, json };
  const wip = maybeJsonRecord(maybeJsonRecord(manifest.artifacts)?.wip);
  if (
    !wip ||
    typeof wip.sizeBytes !== 'number' ||
    !Number.isSafeInteger(wip.sizeBytes) ||
    wip.sizeBytes < 0 ||
    wip.sizeBytes > config.totalBudgetBytes ||
    typeof wip.sha256 !== 'string' ||
    !SHA256.test(wip.sha256) ||
    wip.sha256 !== snapshot.wipSha256
  )
    throw retainedSnapshotNotFound();
  const key = buildSessionSnapshotR2Key(env, snapshot.chatSessionId, generation, 'wip');
  if (snapshot.wipR2Key !== key) throw retainedSnapshotNotFound();
  return { key, size: wip.sizeBytes, sha256: wip.sha256, json };
}

/** Bound metadata/object waits using the existing snapshot transfer budget. */
async function exportDeadline<T>(env: Env, operation: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(errors.internal('Retained snapshot download unavailable')),
      getSessionSnapshotConfig(env).transferIdleTimeoutMs
    );
  });
  try {
    return await Promise.race([operation(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function discardObject(object: R2Object | R2ObjectBody | null): void {
  if (object && 'body' in object) void object.body.cancel().catch(() => undefined);
}

async function readObject(env: Env, key: string, options?: R2GetOptions) {
  let abandoned = false;
  try {
    return await exportDeadline(env, async () => {
      const object = await env.R2.get(key, options);
      if (abandoned) discardObject(object);
      return object;
    });
  } catch (error) {
    abandoned = true;
    throw error;
  }
}

/** Hash privately without buffering WIP; never include bytes or storage errors in diagnostics. */
async function verifyObject(env: Env, key: string, size: number, expected: string) {
  const object = await readObject(env, key);
  if (!object || !('body' in object) || object.size !== size) {
    discardObject(object);
    throw retainedSnapshotNotFound();
  }
  const digest = new crypto.DigestStream('SHA-256');
  const reader = object.body.getReader();
  const writer = digest.getWriter();
  // Attach immediately so aborting the writer never produces an unhandled rejection.
  const digestResult = digest.digest.catch(() => null);
  let length = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(retainedSnapshotNotFound()),
      getSessionSnapshotConfig(env).transferIdleTimeoutMs
    );
  });
  const consume = async () => {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > size) throw retainedSnapshotNotFound();
      await writer.write(chunk.value);
    }
    await writer.close();
    const hash = await digestResult;
    if (length !== size || !hash || hex(hash) !== expected) throw retainedSnapshotNotFound();
  };
  try {
    await Promise.race([consume(), timeout]);
  } catch {
    void reader.cancel().catch(() => undefined);
    void writer.abort().catch(() => undefined);
    throw retainedSnapshotNotFound();
  } finally {
    clearTimeout(timer);
  }
  return object.etag;
}

/** Read-only export; no lifecycle claim, workspace lookup, wake, mutation, HOME read or signed URL. */
export async function exportOwnerSessionSnapshot(
  env: Env,
  input: {
    projectId: string;
    sessionId: string;
    userId: string;
    artifact: OwnerSnapshotArtifact;
  }
): Promise<Response> {
  const snapshot = await authorizedSnapshot(env, input.projectId, input.sessionId, input.userId);
  const contract = exportContract(env, snapshot, input.artifact);
  const expected =
    contract.sha256 ?? hex(await crypto.subtle.digest('SHA-256', encoder.encode(contract.json)));
  const etag = await verifyObject(env, contract.key, contract.size, expected);
  // Conditional second read streams only the very object whose full hash was verified.
  const object = await readObject(env, contract.key, { onlyIf: { etagMatches: etag } });
  if (!object || !('body' in object) || object.size !== contract.size) {
    discardObject(object);
    throw retainedSnapshotNotFound();
  }
  try {
    const current = await authorizedSnapshot(env, input.projectId, input.sessionId, input.userId);
    // Be conservative during capture/expiry/ownership changes, even if the old object still exists.
    if (JSON.stringify(current) !== JSON.stringify(snapshot)) throw retainedSnapshotNotFound();
  } catch (error) {
    discardObject(object);
    throw error;
  }
  const safeId = snapshot.chatSessionId.replace(/[^a-zA-Z0-9_-]/g, '-');
  return new Response(object.body, {
    headers: {
      'Content-Type':
        input.artifact === 'manifest' ? 'application/json' : 'application/octet-stream',
      'Content-Length': String(contract.size),
      'Content-Disposition': `attachment; filename="session-${safeId}-${input.artifact === 'manifest' ? 'manifest.json' : 'wip.bundle'}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
