import type { CapacityPoolStatus } from '@simple-agent-manager/shared';
import type { drizzle } from 'drizzle-orm/d1';

import type * as schema from '../db/schema';

export type Db = ReturnType<typeof drizzle>;

export const DEFAULT_RUNTIME = 'vm';

export const DEFAULT_MACHINE_CLASS = 'shared-vm';

export const ACTIVE_STATUS = 'active' satisfies CapacityPoolStatus;

export const DISABLED_STATUS = 'disabled' satisfies CapacityPoolStatus;

export const DELETED_STATUS = 'deleted' satisfies CapacityPoolStatus;

/**
 * Fixed binds in the missing-candidate UPDATE before the `id IN (...)` list:
 * 4 in SET (availability, unavailable_at, catalog_generation, updated_at) and 2 in WHERE
 * (pool_id, capacity_source_id). The unguarded variant binds fewer (catalog_generation is a
 * column reference), so this is a safe upper bound for both.
 */
export const MISSING_CANDIDATE_UPDATE_FIXED_BIND_COUNT = 8;

/** Extra binds contributed by the generation fence: catalog_generation, id, source_generation, status. */
export const MISSING_CANDIDATE_SOURCE_GENERATION_GUARD_BIND_COUNT = 4;

/** Default candidate ROWS published per invocation before the cursor defers the rest. */
export const DEFAULT_CAPACITY_POOL_CANDIDATE_PUBLISH_BATCH_SIZE = 200;

/**
 * Durable progress store for bounded, resumable catalog publication. Backed by
 * `platform_settings` in production so a partially published huge catalog resumes on the
 * next tick instead of restarting (or being abandoned) after a process restart.
 */
export interface CapacityCandidatePublicationCursorStore {
  read(key: string): Promise<string | null>;
  write(key: string, value: string | null): Promise<void>;
}

export interface EnsureCandidatesForSourceOptions {
  sourceGeneration?: number;
  sourceAuthorityGeneration?: number;
  catalogComplete?: boolean;
  /** Max candidate rows written per invocation. Defaults to the module constant. */
  publishBatchSize?: number;
  cursorStore?: CapacityCandidatePublicationCursorStore;
}

export interface EnsureCandidatesForSourceResult {
  /** Total candidate rows this catalog resolves to (offerings x materialized roles). */
  totalCandidates: number;
  /** Rows written by this invocation. */
  publishedCandidates: number;
  /** True only when every row for this catalog has been published (across all resumed ticks). */
  publicationComplete: boolean;
  /** True when missing-offering cleanup ran. Requires both complete catalog and complete publication. */
  markedMissing: boolean;
}

export type ExistingCandidateRecord = Pick<
  schema.CapacityPoolCandidate,
  | 'id'
  | 'status'
  | 'providerInstanceCatalogSource'
  | 'catalogAvailability'
  | 'providerInstanceBootDiskSizeGb'
  | 'providerInstanceImage'
  | 'providerInstanceArchitecture'
>;

export interface PublicationCursor {
  /** Digest of semantic source authority and the ordered candidate content. */
  digest: string;
  /** Number of rows already published for that exact catalog. */
  published: number;
  /** This exact semantic catalog has completed at least one fenced publication. */
  complete?: boolean;
}
