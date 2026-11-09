import { and, eq } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';
import * as schema from '../db/schema';
import { BUILD_CONTEXT_PREFIX } from './build-context-defaults';

type Db = ReturnType<typeof drizzle<typeof schema>>;
export interface BuildContextOwner {
  id: string;
  projectId: string;
  environmentId: string;
  workspaceId: string;
  requestedBy: string;
  attempt: number;
}
export interface BuildContextDescriptor {
  sizeBytes: number;
  sha256: string;
}
export function buildContextKey(owner: BuildContextOwner): string {
  const parts = [owner.projectId, owner.environmentId, owner.id];
  if (
    parts.some((part) => !/^[a-zA-Z0-9_-]+$/.test(part)) ||
    !Number.isSafeInteger(owner.attempt) ||
    owner.attempt < 1
  )
    throw new Error('Invalid build-context identity');
  return `${BUILD_CONTEXT_PREFIX}${parts.join('/')}/${owner.attempt}.tar.zst`;
}
function ownerPredicate(owner: BuildContextOwner) {
  const j = schema.deploymentPublishJobs;
  return and(
    eq(j.id, owner.id),
    eq(j.projectId, owner.projectId),
    eq(j.environmentId, owner.environmentId),
    eq(j.workspaceId, owner.workspaceId),
    eq(j.requestedBy, owner.requestedBy),
    eq(j.attempt, owner.attempt),
    eq(j.executor, 'cloudflare')
  );
}
export async function reserveBuildContext(
  db: Db,
  owner: BuildContextOwner,
  descriptor: BuildContextDescriptor
) {
  const now = new Date().toISOString();
  const [row] = await db
    .update(schema.deploymentPublishJobs)
    .set({
      status: 'collecting',
      currentStep: 'collecting',
      contextR2Key: buildContextKey(owner),
      contextBytes: descriptor.sizeBytes,
      contextSha256: descriptor.sha256,
      updatedAt: now,
      lastHeartbeatAt: now,
    })
    .where(and(ownerPredicate(owner), eq(schema.deploymentPublishJobs.status, 'queued')))
    .returning();
  return row ?? null;
}
export async function completeBuildContext(
  db: Db,
  owner: BuildContextOwner,
  descriptor: BuildContextDescriptor
) {
  const j = schema.deploymentPublishJobs;
  const now = new Date().toISOString();
  const [row] = await db
    .update(j)
    .set({
      status: 'context_ready',
      currentStep: 'context_ready',
      queuedAt: now,
      updatedAt: now,
      lastHeartbeatAt: now,
    })
    .where(
      and(
        ownerPredicate(owner),
        eq(j.status, 'collecting'),
        eq(j.contextR2Key, buildContextKey(owner)),
        eq(j.contextBytes, descriptor.sizeBytes),
        eq(j.contextSha256, descriptor.sha256)
      )
    )
    .returning();
  return row ?? null;
}
