import type {
  CapacityCredentialSource,
  CapacityPool as CapacityPoolDto,
  CapacityPoolCandidate as CapacityPoolCandidateDto,
  CapacitySourceIdentity,
  CredentialProvider,
  DefaultCapacityPoolSummary,
  ProviderInstanceOffering,
} from '@simple-agent-manager/shared';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { type DefaultPoolScopeIdentity } from './default-capacity-pool-helpers';

export type Db = ReturnType<typeof drizzle>;

export type ScopeIdentity = DefaultPoolScopeIdentity;

/**
 * Which materialized workload roles a summary should carry.
 *
 * `editor-visible` (default) returns only the primary role, so the pool editor and the safe
 * effective DTO show one row per offering. `all` additionally returns the placement-only
 * coupled rows, which is what a deployment placement needs to find an eligible candidate.
 * Counts are ALWAYS computed over editor-visible rows so a caller asking for `all` can never
 * double the user-visible candidate counts.
 */
export type CapacityPoolSummaryWorkloadRoles = 'editor-visible' | 'all';

export interface ReadDefaultPoolSummaryOptions {
  workloadRoles?: CapacityPoolSummaryWorkloadRoles;
  /**
   * Default placement reads must remain active-only. UI/editor reads opt into
   * disabled default pools so users can add back offerings after removing the
   * last active candidate.
   */
  includeDisabled?: boolean;
}

export interface PoolPublicationGuard {
  revision: number;
  updatedAt: string;
  status: string;
}

export interface CapacitySourcePublication {
  source: schema.CapacitySource;
  generation: number;
  published: boolean;
}

export interface CredentialCapacitySeed extends ScopeIdentity {
  id: string;
  provider: CredentialProvider;
  active: boolean;
  credentialSource: CapacityCredentialSource;
  credentialReference: string;
  credentialVersion: number | null;
  /** Legacy credentials FK. Null for CC-backed and platform-backed sources. */
  credentialId: string | null;
  /** Browser-safe catalog credential id. May be a CC credential id. */
  catalogCredentialId: string | null;
  platformCredentialId: string | null;
  externalSourceRef: string | null;
  encryptedToken: string;
  iv: string;
  createdBy: string | null;
  stateFingerprint: string;
}

export interface DefaultCapacityPoolOfferingResolution {
  offerings: ProviderInstanceOffering[];
  refreshSucceeded: boolean;
  catalogComplete?: boolean;
}

export type DefaultCapacityPoolOfferingResolver = (
  seed: CredentialCapacitySeed
) => Promise<ProviderInstanceOffering[] | DefaultCapacityPoolOfferingResolution>;

export type CapacityPoolSummary = DefaultCapacityPoolSummary & {
  pool: CapacityPoolDto;
  sources: CapacitySourceIdentity[];
  candidates: CapacityPoolCandidateDto[];
  activeCandidateCount: number;
};

export interface DefaultCapacityPoolsEnsureResult {
  installation: CapacityPoolSummary | null;
  user: CapacityPoolSummary | null;
  project: CapacityPoolSummary | null;
}

export interface DefaultCapacityPoolsBackfillOptions {
  /**
   * Limit user-pool reconciliation to one user. Omit with care: unscoped calls scan
   * existing credential rows and are intended for manual/scheduled backfills only.
   */
  userId?: string | null;
  /**
   * Limit project-pool reconciliation to one project. Project pools are seeded only
   * from real project-scoped credential rows.
   */
  projectId?: string | null;
  includeInstallation?: boolean;
  env?: Env;
  offeringResolver?: DefaultCapacityPoolOfferingResolver;
  scopeBatchSize?: number;
  /** Candidate ROWS published per source per pass before the durable cursor defers the rest. */
  candidatePublishBatchSize?: number;
  /** Secret-free credential anchors scrubbed/pruned per backfill pass. */
  credentialAnchorScrubBatchSize?: number;
  beforeSourcePublication?: (input: {
    seed: CredentialCapacitySeed;
    existingSource: schema.CapacitySource | null;
  }) => Promise<void>;
  beforeCredentialSeedSelection?: (input: {
    scope: DefaultPoolScopeIdentity;
    seedSnapshotGeneration: number;
  }) => Promise<void>;
  afterCredentialSeedSelection?: (input: {
    scope: DefaultPoolScopeIdentity;
    seedSnapshotGeneration: number;
    seedCount: number;
  }) => Promise<void>;
}
