import { ulid } from '@simple-agent-manager/worker-core';
import * as schema from '@simple-agent-manager/worker-core/schema';
import { and, eq, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

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
  durationMs?: number;
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
  return transitionContext(
    db,
    owner,
    descriptor,
    'collecting',
    and(ownerPredicate(owner), eq(schema.deploymentPublishJobs.status, 'queued'))
  );
}
export async function completeBuildContext(
  db: Db,
  owner: BuildContextOwner,
  descriptor: BuildContextDescriptor
) {
  const j = schema.deploymentPublishJobs;
  return transitionContext(
    db,
    owner,
    descriptor,
    'context_ready',
    and(
      ownerPredicate(owner),
      eq(j.status, 'collecting'),
      eq(j.contextR2Key, buildContextKey(owner)),
      eq(j.contextBytes, descriptor.sizeBytes),
      eq(j.contextSha256, descriptor.sha256)
    )
  );
}
async function transitionContext(
  db: Db,
  owner: BuildContextOwner,
  descriptor: BuildContextDescriptor,
  status: 'collecting' | 'context_ready',
  predicate: ReturnType<typeof and>
) {
  const j = schema.deploymentPublishJobs;
  const now = new Date().toISOString();
  // History and state share a transaction and predicate, so cancellation cannot
  // leave timing evidence for a rejected transition or advance a stale attempt.
  const history = db.insert(schema.deploymentPublishJobEvents).select(
    db
      .select({
        id: sql<string>`${ulid()}`.as('id'),
        publishJobId: sql<string>`${owner.id}`.as('publish_job_id'),
        projectId: j.projectId,
        environmentId: j.environmentId,
        nodeId: j.nodeId,
        nodeIdentifier: j.nodeId,
        workspaceId: j.workspaceId,
        seq: sql<number>`(SELECT coalesce(max(seq),0)+1 FROM deployment_publish_job_events WHERE publish_job_id=${owner.id})`.as(
          'seq'
        ),
        level: sql<string>`'info'`.as('level'),
        eventType: sql<string>`${'publish.context.' + status}`.as('event_type'),
        step: sql<string>`${status}`.as('step'),
        message:
          sql<string>`${status === 'collecting' ? 'Build context collected; uploading' : 'Build context verified and queued'}`.as(
            'message'
          ),
        detailJson:
          sql<string>`${JSON.stringify({ sizeBytes: descriptor.sizeBytes, sha256: descriptor.sha256, collectionDurationMs: descriptor.durationMs ?? null })}`.as(
            'detail_json'
          ),
        createdAt: sql<string>`${now}`.as('created_at'),
      })
      .from(j)
      .where(predicate)
  );
  const update: Partial<schema.NewDeploymentPublishJobRow> = {
    status,
    currentStep: status,
    updatedAt: now,
    lastEventAt: now,
    lastHeartbeatAt: now,
  };
  if (status === 'collecting') {
    update.contextR2Key = buildContextKey(owner);
    update.contextBytes = descriptor.sizeBytes;
    update.contextSha256 = descriptor.sha256;
  } else update.queuedAt = now;
  const [, rows] = await db.batch([history, db.update(j).set(update).where(predicate).returning()]);
  return rows[0] ?? null;
}
