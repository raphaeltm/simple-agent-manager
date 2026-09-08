import { and, asc, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';

import * as schema from '../db/schema';
import { nextCapacityPoolTimestamp } from './capacity-pool-clock';
import { type CapacityCandidatePublicationCursorStore } from './default-capacity-pool-candidates';
import {
  type Db,
  type DefaultCapacityPoolsBackfillOptions,
  type ScopeIdentity,
} from './default-capacity-pool-types';

const DEFAULT_BACKFILL_SCOPE_BATCH_SIZE = 25;

const MAX_BACKFILL_SCOPE_BATCH_SIZE = 200;

export const BACKFILL_USER_CURSOR_KEY = 'capacityPools.backfill.userCursor.v1';

export const BACKFILL_PROJECT_CURSOR_KEY = 'capacityPools.backfill.projectCursor.v1';

const SOURCE_GENERATION_SETTING_KEY_PREFIX = 'capacityPools.sourceGeneration.v1';

export const SOURCE_KIND_CLOUD_PROVIDER = 'cloud-provider-credential';

export const CREDENTIAL_TYPE_CLOUD_PROVIDER = 'cloud-provider';

export const ACTIVE_STATUS = 'active';

export const DISABLED_STATUS = 'disabled';

export async function listCredentialUserIdsForBackfill(db: Db, limit: number): Promise<string[]> {
  const cursor = await readBackfillCursor(db, BACKFILL_USER_CURSOR_KEY);
  let ids = await listCredentialUserIdsPage(db, cursor, limit);
  if (ids.length === 0 && cursor) {
    await writeBackfillCursor(db, BACKFILL_USER_CURSOR_KEY, null);
    ids = await listCredentialUserIdsPage(db, null, limit);
  }
  return ids;
}

async function listCredentialUserIdsPage(
  db: Db,
  cursor: string | null,
  limit: number
): Promise<string[]> {
  const legacyRows = await db
    .select({ userId: schema.credentials.userId })
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.credentialType, CREDENTIAL_TYPE_CLOUD_PROVIDER),
        isNull(schema.credentials.projectId),
        cursor ? gt(schema.credentials.userId, cursor) : undefined
      )
    )
    .orderBy(asc(schema.credentials.userId))
    .limit(limit);
  const ccRows = await db
    .select({ userId: schema.ccAttachments.userId })
    .from(schema.ccAttachments)
    .where(
      and(
        eq(schema.ccAttachments.consumerKind, 'compute'),
        isNull(schema.ccAttachments.projectId),
        cursor ? gt(schema.ccAttachments.userId, cursor) : undefined
      )
    )
    .orderBy(asc(schema.ccAttachments.userId))
    .limit(limit);
  const poolRows = await db
    .select({ userId: schema.capacityPools.ownerUserId })
    .from(schema.capacityPools)
    .where(
      and(
        eq(schema.capacityPools.scope, 'user'),
        eq(schema.capacityPools.isDefault, true),
        isNotNull(schema.capacityPools.ownerUserId),
        cursor ? gt(schema.capacityPools.ownerUserId, cursor) : undefined
      )
    )
    .orderBy(asc(schema.capacityPools.ownerUserId))
    .limit(limit);
  const sourceRows = await db
    .select({ userId: schema.capacitySources.ownerUserId })
    .from(schema.capacitySources)
    .where(
      and(
        eq(schema.capacitySources.scope, 'user'),
        isNotNull(schema.capacitySources.ownerUserId),
        cursor ? gt(schema.capacitySources.ownerUserId, cursor) : undefined
      )
    )
    .orderBy(asc(schema.capacitySources.ownerUserId))
    .limit(limit);

  return [
    ...new Set(
      [...legacyRows, ...ccRows, ...poolRows, ...sourceRows]
        .flatMap((row) => (row.userId ? [row.userId] : []))
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    ),
  ].slice(0, limit);
}

export async function listCredentialProjectIdsForBackfill(
  db: Db,
  limit: number
): Promise<string[]> {
  const cursor = await readBackfillCursor(db, BACKFILL_PROJECT_CURSOR_KEY);
  let ids = await listCredentialProjectIdsPage(db, cursor, limit);
  if (ids.length === 0 && cursor) {
    await writeBackfillCursor(db, BACKFILL_PROJECT_CURSOR_KEY, null);
    ids = await listCredentialProjectIdsPage(db, null, limit);
  }
  return ids;
}

async function listCredentialProjectIdsPage(
  db: Db,
  cursor: string | null,
  limit: number
): Promise<string[]> {
  const legacyRows = await db
    .select({ projectId: schema.credentials.projectId })
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.credentialType, CREDENTIAL_TYPE_CLOUD_PROVIDER),
        isNotNull(schema.credentials.projectId),
        cursor ? gt(schema.credentials.projectId, cursor) : undefined
      )
    )
    .orderBy(asc(schema.credentials.projectId))
    .limit(limit);
  const ccRows = await db
    .select({ projectId: schema.ccAttachments.projectId })
    .from(schema.ccAttachments)
    .where(
      and(
        eq(schema.ccAttachments.consumerKind, 'compute'),
        isNotNull(schema.ccAttachments.projectId),
        cursor ? gt(schema.ccAttachments.projectId, cursor) : undefined
      )
    )
    .orderBy(asc(schema.ccAttachments.projectId))
    .limit(limit);
  const poolRows = await db
    .select({ projectId: schema.capacityPools.ownerProjectId })
    .from(schema.capacityPools)
    .where(
      and(
        eq(schema.capacityPools.scope, 'project'),
        eq(schema.capacityPools.isDefault, true),
        isNotNull(schema.capacityPools.ownerProjectId),
        cursor ? gt(schema.capacityPools.ownerProjectId, cursor) : undefined
      )
    )
    .orderBy(asc(schema.capacityPools.ownerProjectId))
    .limit(limit);
  const sourceRows = await db
    .select({ projectId: schema.capacitySources.ownerProjectId })
    .from(schema.capacitySources)
    .where(
      and(
        eq(schema.capacitySources.scope, 'project'),
        isNotNull(schema.capacitySources.ownerProjectId),
        cursor ? gt(schema.capacitySources.ownerProjectId, cursor) : undefined
      )
    )
    .orderBy(asc(schema.capacitySources.ownerProjectId))
    .limit(limit);

  return [
    ...new Set(
      [...legacyRows, ...ccRows, ...poolRows, ...sourceRows]
        .flatMap((row) => (row.projectId ? [row.projectId] : []))
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    ),
  ].slice(0, limit);
}

async function readBackfillCursor(db: Db, key: string): Promise<string | null> {
  const [row] = await db
    .select({ value: schema.platformSettings.value })
    .from(schema.platformSettings)
    .where(eq(schema.platformSettings.key, key))
    .limit(1);
  return row?.value || null;
}

export async function writeBackfillCursor(
  db: Db,
  key: string,
  cursor: string | null
): Promise<void> {
  const now = nextCapacityPoolTimestamp();
  if (cursor === null) {
    await db.delete(schema.platformSettings).where(eq(schema.platformSettings.key, key));
    return;
  }
  await db
    .insert(schema.platformSettings)
    .values({ key, value: cursor, updatedAt: now, updatedBy: null })
    .onConflictDoUpdate({
      target: schema.platformSettings.key,
      set: {
        value: cursor,
        updatedAt: now,
        updatedBy: sql`NULL`,
      },
    });
}

export async function readCapacityPoolScopeGeneration(
  db: Db,
  scope: ScopeIdentity
): Promise<number> {
  const [row] = await db
    .select({ value: schema.platformSettings.value })
    .from(schema.platformSettings)
    .where(eq(schema.platformSettings.key, sourceGenerationSettingKey(scope)))
    .limit(1);
  return parseGeneration(row?.value);
}

export async function nextCapacityPoolScopeGeneration(
  db: Db,
  scope: ScopeIdentity
): Promise<number> {
  const key = sourceGenerationSettingKey(scope);
  const now = nextCapacityPoolTimestamp();
  await db
    .insert(schema.platformSettings)
    .values({ key, value: '0', updatedAt: now, updatedBy: null })
    .onConflictDoNothing();
  const [row] = await db
    .update(schema.platformSettings)
    .set({
      value: sql`CAST(${schema.platformSettings.value} AS INTEGER) + 1`,
      updatedAt: now,
      updatedBy: sql`NULL`,
    })
    .where(eq(schema.platformSettings.key, key))
    .returning({ value: schema.platformSettings.value });
  return parseGeneration(row?.value);
}

function sourceGenerationSettingKey(scope: ScopeIdentity): string {
  switch (scope.scope) {
    case 'installation':
      return `${SOURCE_GENERATION_SETTING_KEY_PREFIX}:installation`;
    case 'user':
      return `${SOURCE_GENERATION_SETTING_KEY_PREFIX}:user:${scope.ownerUserId ?? ''}`;
    case 'project':
      return `${SOURCE_GENERATION_SETTING_KEY_PREFIX}:project:${scope.ownerProjectId ?? ''}`;
  }
}

function parseGeneration(value: string | number | null | undefined): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export function poolScopePredicates(scope: ScopeIdentity) {
  return [
    eq(schema.capacityPools.scope, scope.scope),
    scope.ownerUserId
      ? eq(schema.capacityPools.ownerUserId, scope.ownerUserId)
      : isNull(schema.capacityPools.ownerUserId),
    scope.ownerProjectId
      ? eq(schema.capacityPools.ownerProjectId, scope.ownerProjectId)
      : isNull(schema.capacityPools.ownerProjectId),
  ];
}

export function sourceScopePredicates(scope: ScopeIdentity) {
  return [
    eq(schema.capacitySources.scope, scope.scope),
    scope.ownerUserId
      ? eq(schema.capacitySources.ownerUserId, scope.ownerUserId)
      : isNull(schema.capacitySources.ownerUserId),
    scope.ownerProjectId
      ? eq(schema.capacitySources.ownerProjectId, scope.ownerProjectId)
      : isNull(schema.capacitySources.ownerProjectId),
  ];
}

/**
 * Durable publication progress, reusing the existing platform_settings key/value store so a
 * partially published catalog resumes on the next tick instead of restarting from scratch.
 */
export function platformSettingsCursorStore(db: Db): CapacityCandidatePublicationCursorStore {
  return {
    read: (key) => readBackfillCursor(db, key),
    write: (key, value) => writeBackfillCursor(db, key, value),
  };
}

export function resolveBackfillScopeBatchSize(
  options: DefaultCapacityPoolsBackfillOptions
): number {
  const configured =
    options.scopeBatchSize ??
    numberFromString(options.env?.CAPACITY_POOL_BACKFILL_SCOPE_BATCH_SIZE);
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
    return Math.min(Math.max(1, Math.floor(configured)), MAX_BACKFILL_SCOPE_BATCH_SIZE);
  }
  return DEFAULT_BACKFILL_SCOPE_BATCH_SIZE;
}

export function numberFromString(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
