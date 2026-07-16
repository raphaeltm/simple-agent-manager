import { and, eq, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { ulid } from '../lib/ulid';
import { sanitizePublishEventText } from './deployment-publish-jobs';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export interface AppendDeploymentReleaseEventInput {
  projectId: string;
  environmentId: string;
  nodeId: string;
  releaseId?: string | null;
  releaseVersion?: number | null;
  level?: string;
  eventType: string;
  step?: string | null;
  message: string;
  detail?: unknown;
}

function normalizeLevel(level: unknown): string {
  return ['debug', 'info', 'warn', 'error'].includes(String(level)) ? String(level) : 'info';
}

function detailJson(detail: unknown): string | null {
  if (detail == null) return null;
  try {
    return sanitizePublishEventText(JSON.stringify(detail), 4000);
  } catch {
    return JSON.stringify({ note: 'event detail was not JSON serializable' });
  }
}

export async function appendDeploymentReleaseEvent(
  db: Db,
  input: AppendDeploymentReleaseEventInput
): Promise<void> {
  let releaseId = input.releaseId ?? null;
  const releaseVersion = input.releaseVersion ?? null;
  if (!releaseId && releaseVersion != null) {
    const [release] = await db
      .select({ id: schema.deploymentReleases.id })
      .from(schema.deploymentReleases)
      .where(
        and(
          eq(schema.deploymentReleases.environmentId, input.environmentId),
          eq(schema.deploymentReleases.version, releaseVersion)
        )
      )
      .limit(1);
    releaseId = release?.id ?? null;
  }

  const seqWhere = releaseId
    ? eq(schema.deploymentReleaseEvents.releaseId, releaseId)
    : and(
        eq(schema.deploymentReleaseEvents.environmentId, input.environmentId),
        eq(schema.deploymentReleaseEvents.releaseVersion, releaseVersion ?? -1)
      );
  const maxRows = await db
    .select({ maxSeq: sql<number>`coalesce(max(${schema.deploymentReleaseEvents.seq}), 0)` })
    .from(schema.deploymentReleaseEvents)
    .where(seqWhere);
  const seq = Number(maxRows[0]?.maxSeq ?? 0) + 1;

  await db.insert(schema.deploymentReleaseEvents).values({
    id: ulid(),
    projectId: input.projectId,
    environmentId: input.environmentId,
    releaseId,
    releaseVersion,
    nodeId: input.nodeId,
    nodeIdentifier: input.nodeId,
    seq,
    level: normalizeLevel(input.level),
    eventType: sanitizePublishEventText(input.eventType, 200),
    step: input.step ? sanitizePublishEventText(input.step, 200) : null,
    message: sanitizePublishEventText(input.message),
    detailJson: detailJson(input.detail),
    createdAt: new Date().toISOString(),
  });
}
