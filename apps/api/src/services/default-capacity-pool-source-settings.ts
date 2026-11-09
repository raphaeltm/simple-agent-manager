/**
 * Per-pool account settings: the provider order and the accounts a person switched off.
 *
 * Both live on the pool row and neither bumps the pool revision. Node reuse authority requires a
 * node's recorded pool revision (placement-authority.ts), so bumping it for an order or on/off
 * change would make every running node non-reusable and start a wave of new VMs. Instead each
 * write is fenced on the exact stored value it read.
 */
import { MAX_CAPACITY_POOL_SOURCE_ORDER_LENGTH } from '@simple-agent-manager/shared';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { nextCapacityPoolTimestamp } from './capacity-pool-clock';
import { parseCapacityPoolExcludedSources, parseCapacityPoolSourceOrder } from './capacity-pools';
import type { DefaultPoolScopeIdentity } from './default-capacity-pool-helpers';
import { sourceScopePredicates } from './default-capacity-pool-update-candidates';

type Db = ReturnType<typeof drizzle>;

export interface SourceSettingsInput extends DefaultPoolScopeIdentity {
  /** Provider order to store; `null` or `[]` clears it. Absent leaves it unchanged. */
  sourceOrder?: string[] | null;
  /** Switched-off accounts to store; `null` or `[]` switches all on. Absent leaves them. */
  excludedSourceIds?: string[] | null;
}

export interface SourceSettingsUpdate {
  /** True when either stored value changes. */
  changed: boolean;
  /** Column values to write, only for the columns that change. */
  values: { sourceOrderJson?: string | null; excludedSourceIdsJson?: string | null };
  /** The stored values this edit read, for the compare-and-set fence. */
  guards: { sourceOrderJson?: string | null; excludedSourceIdsJson?: string | null };
  /** Requested ids that are not capacity sources serving this pool. */
  missingSourceIds: string[];
}

/**
 * Resolve an edit's provider order and switched-off accounts. `activatedSourceIds` are accounts
 * this same edit adds a machine to: adding a machine from a switched-off account switches it on,
 * so the picks a person just made are used.
 */
export async function resolveSourceSettingsUpdate(
  db: Db,
  pool: schema.CapacityPool,
  input: SourceSettingsInput,
  activatedSourceIds: readonly string[]
): Promise<SourceSettingsUpdate> {
  const update: SourceSettingsUpdate = {
    changed: false,
    values: {},
    guards: {},
    missingSourceIds: [],
  };
  const toValidate = new Set<string>();

  if (input.sourceOrder !== undefined) {
    assertWithinLimit('sourceOrder', input.sourceOrder);
    const requested = input.sourceOrder && input.sourceOrder.length > 0 ? input.sourceOrder : null;
    const current = parseCapacityPoolSourceOrder(pool.id, pool.sourceOrderJson);
    if (JSON.stringify(current) !== JSON.stringify(requested)) {
      update.values.sourceOrderJson = requested ? JSON.stringify(requested) : null;
      update.guards.sourceOrderJson = pool.sourceOrderJson ?? null;
      for (const id of requested ?? []) toValidate.add(id);
    }
  }

  const currentExcluded = parseCapacityPoolExcludedSources(pool.id, pool.excludedSourceIdsJson);
  if (input.excludedSourceIds !== undefined || activatedSourceIds.length > 0) {
    if (input.excludedSourceIds !== undefined) {
      assertWithinLimit('excludedSourceIds', input.excludedSourceIds);
    }
    const requested =
      input.excludedSourceIds === undefined ? currentExcluded : (input.excludedSourceIds ?? []);
    const activated = new Set(activatedSourceIds);
    const next = requested.filter((id) => !activated.has(id));
    // This edit's outcome depends on the stored value even when it does not change it: an edit
    // that adds a machine read its account as on. Fencing on the value read means a concurrent
    // switch-off (which bumps no revision) makes this edit conflict instead of committing an
    // active machine on an account that is now off.
    update.guards.excludedSourceIdsJson = pool.excludedSourceIdsJson ?? null;
    if (!sameIdSet(currentExcluded, next)) {
      update.values.excludedSourceIdsJson = next.length > 0 ? JSON.stringify(next) : null;
      // Switching an account off must name a real account; leaving stale ids is harmless.
      for (const id of next) if (!currentExcluded.includes(id)) toValidate.add(id);
    }
  }

  update.changed =
    update.values.sourceOrderJson !== undefined ||
    update.values.excludedSourceIdsJson !== undefined;
  if (toValidate.size > 0) {
    const serving = await readServingSourceIds(db, pool.id, [...toValidate], input);
    update.missingSourceIds = [...toValidate].filter((id) => !serving.has(id));
  }
  return update;
}

/** SQL fence: the stored account settings still equal what this edit read. */
export function sourceSettingsGuardSql(guards: SourceSettingsUpdate['guards']) {
  const parts = [
    guards.sourceOrderJson === undefined
      ? null
      : sql` AND source_order_json IS ${guards.sourceOrderJson}`,
    guards.excludedSourceIdsJson === undefined
      ? null
      : sql` AND excluded_source_ids_json IS ${guards.excludedSourceIdsJson}`,
  ].filter((part) => part !== null);
  return parts.length > 0 ? sql.join(parts, sql``) : sql``;
}

/**
 * Store account settings alone, without bumping the revision. The revision alone cannot fence
 * this write because these edits never advance it: two concurrent edits would both match it and
 * the later would silently replace the earlier. So the write also compares the stored values
 * with the ones this edit read, and a changed value is a conflict.
 */
export async function publishSourceSettingsOnly(
  db: Db,
  pool: schema.CapacityPool,
  update: SourceSettingsUpdate
): Promise<boolean> {
  const result = await db
    .update(schema.capacityPools)
    .set({ ...update.values, updatedAt: nextCapacityPoolTimestamp() })
    .where(
      and(
        eq(schema.capacityPools.id, pool.id),
        eq(schema.capacityPools.revision, pool.revision),
        sql`1 = 1${sourceSettingsGuardSql(update.guards)}`
      )
    )
    .run();
  return (result as unknown as D1Result<unknown>).meta.changes === 1;
}

function assertWithinLimit(field: string, ids: string[] | null): void {
  if (ids && ids.length > MAX_CAPACITY_POOL_SOURCE_ORDER_LENGTH) {
    // The route rejects this first; the membership read binds one parameter per id.
    throw new Error(
      `${field} may list at most ${MAX_CAPACITY_POOL_SOURCE_ORDER_LENGTH} capacity sources`
    );
  }
}

function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

/** Capacity sources in the pool's scope that still serve it (have a non-deleted candidate). */
async function readServingSourceIds(
  db: Db,
  poolId: string,
  ids: string[],
  scope: DefaultPoolScopeIdentity
): Promise<Set<string>> {
  const serving = await db
    .selectDistinct({ id: schema.capacityPoolCandidates.capacitySourceId })
    .from(schema.capacityPoolCandidates)
    .innerJoin(
      schema.capacitySources,
      eq(schema.capacitySources.id, schema.capacityPoolCandidates.capacitySourceId)
    )
    .where(
      and(
        eq(schema.capacityPoolCandidates.poolId, poolId),
        ne(schema.capacityPoolCandidates.status, 'deleted'),
        inArray(schema.capacityPoolCandidates.capacitySourceId, ids),
        ...sourceScopePredicates(scope)
      )
    );
  return new Set(serving.map((row) => row.id));
}
