import type { CapacityPoolStatus } from '@simple-agent-manager/shared';
import type { drizzle } from 'drizzle-orm/d1';

import type * as schema from '../db/schema';
import type { PoolPublicationGuard } from './default-capacity-pool-types';

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

/** Candidate ROWS written per D1 batch. A pass writes successive batches until its budget ends. */
export const DEFAULT_CAPACITY_POOL_CANDIDATE_PUBLISH_BATCH_SIZE = 200;

/**
 * Wall-clock budget for publishing one changed catalog in a single pass
 * (`operations.capacityPoolPublishBudgetMs`). A pool is unplaceable until its catalog is
 * complete, and refreshes are rare (daily, or a user editing the pool), so publication must
 * finish within one pass rather than one batch per pass. At 200 rows per batch the default
 * covers the default GCP catalog (~1,000 rows, 5 batches) with wide margin; past it, the
 * cursor persists and the next pass resumes. 0 keeps one batch per pass.
 */
export const DEFAULT_CAPACITY_POOL_CANDIDATE_PUBLISH_BUDGET_MS = 20_000;

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
  /** Pool state owned by the enclosing refresh; never adopt a concurrent editor's revision. */
  poolPublicationGuard?: PoolPublicationGuard;
  sourceGeneration?: number;
  sourceAuthorityGeneration?: number;
  /** Whether returned metadata is trusted for placement, independent of exhaustive enumeration. */
  catalogValidated?: boolean;
  catalogComplete?: boolean;
  /** Max candidate rows written per D1 batch. Defaults to the module constant. */
  publishBatchSize?: number;
  /**
   * Epoch ms until which an INCOMPLETE catalog keeps publishing further batches in this pass.
   * Omitted (or already past): exactly one batch per pass. A complete, unchanged catalog always
   * writes one batch per pass because it is already placeable.
   */
  publishDeadlineAt?: number;
  /** Clock for the deadline check; injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
  cursorStore?: CapacityCandidatePublicationCursorStore;
}

export interface EnsureCandidatesForSourceResult {
  /** Own atomic promotion's resulting pool state; absent when its CAS did not commit. */
  poolPublicationGuard?: PoolPublicationGuard;
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
  | 'workloadRole'
  | 'location'
  | 'providerInstanceType'
  | 'providerInstanceSku'
>;

export interface PublicationCursor {
  /** Digest of semantic source authority and the ordered candidate content. */
  digest: string;
  /** Number of rows already published for that exact catalog. */
  published: number;
  /** This exact semantic catalog has completed at least one fenced publication. */
  complete?: boolean;
}
