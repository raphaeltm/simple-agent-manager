import { type SQL, sql } from 'drizzle-orm';

import * as schema from '../db/schema';
import { CAPACITY_POOL_CANDIDATE_PUBLICATION_CURSOR_PREFIX } from './default-capacity-pool-candidates-common';
import { SOURCE_KIND_CLOUD_PROVIDER } from './default-capacity-pool-storage';

/**
 * A rollback may overwrite live rows while leaving the newer build's completed work
 * and publication marker intact. Enumerate scoped sources, then use the setting PK;
 * neither cursor presence nor migration_state alone proves that a legacy writer stopped.
 * Keep this independent of migration_state: an operator edit can reconcile that mirror.
 */
export function unfinishedLegacyPublicationSql(): SQL {
  return sql`EXISTS (
    SELECT 1 FROM capacity_sources legacy_source
    JOIN platform_settings legacy_cursor
      ON legacy_cursor.key = ${CAPACITY_POOL_CANDIDATE_PUBLICATION_CURSOR_PREFIX}
        || ${schema.capacityPools.id} || ':' || legacy_source.id
    WHERE legacy_source.scope = ${schema.capacityPools.scope}
      AND legacy_source.owner_user_id IS ${schema.capacityPools.ownerUserId}
      AND legacy_source.owner_project_id IS ${schema.capacityPools.ownerProjectId}
      AND legacy_source.source_kind = ${SOURCE_KIND_CLOUD_PROVIDER}
      AND legacy_source.status = 'active'
      AND CASE WHEN json_valid(legacy_cursor.value) THEN
        json_type(legacy_cursor.value, '$.digest') = 'text'
        AND length(json_extract(legacy_cursor.value, '$.digest')) > 0
        AND json_type(legacy_cursor.value, '$.published') IN ('integer', 'real')
        AND json_extract(legacy_cursor.value, '$.published') BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
        AND json_extract(legacy_cursor.value, '$.published') = CAST(json_extract(legacy_cursor.value, '$.published') AS INTEGER)
        AND (json_type(legacy_cursor.value, '$.complete') IS NULL
          OR json_type(legacy_cursor.value, '$.complete') IN ('true', 'false'))
        AND json_type(legacy_cursor.value, '$.complete') IS NOT 'true'
        AND json_type(legacy_cursor.value, '$.atomic') IS NOT 'true'
      ELSE 0 END
  )`;
}

/** Indexed pending discovery, or one write-authorized placement's exact pool lookup. */
export function legacyPublicationAdoptionSql(now: number, limit: number, poolId?: string): SQL {
  // Idle mirror-complete legacy work stays quarantined until point demand or daily discovery.
  // Bounded background discovery is tracked in Idea 01M7FN82782X6K04SEHF6JBY2E; no minute full scan.
  return sql`INSERT INTO capacity_pool_refreshes
    (pool_id, scope, owner_user_id, owner_project_id, state, generation, attempts, started_at, deadline_at, next_attempt_at)
    SELECT id, scope, owner_user_id, owner_project_id, 'pending', 0, 0, 0, 0, ${now}
    FROM capacity_pools
    WHERE is_default = 1 AND status = 'active'
      AND ${poolId ? sql`id = ${poolId}` : sql`migration_state = 'pending'`}
      AND (
        (migration_state = 'pending' AND NOT EXISTS (
          SELECT 1 FROM capacity_pool_refreshes WHERE pool_id = capacity_pools.id))
        OR (${unfinishedLegacyPublicationSql()} AND NOT EXISTS (
          SELECT 1 FROM capacity_pool_refreshes
          WHERE pool_id = capacity_pools.id AND state != 'complete')))
    ORDER BY id LIMIT ${limit}
    ON CONFLICT(pool_id) DO UPDATE SET
      state = 'pending', attempts = 0, started_at = 0, deadline_at = 0,
      next_attempt_at = excluded.next_attempt_at, last_error = NULL
    WHERE capacity_pool_refreshes.state = 'complete'`;
}
