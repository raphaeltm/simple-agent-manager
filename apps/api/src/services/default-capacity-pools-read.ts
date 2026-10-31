import type { SafeEffectiveCapacityPoolSummary } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { log, serializeError } from '../lib/logger';
import { effectiveDefaultCapacityPoolScopeChain } from './capacity-pool-precedence';
import {
  ACTIVE_STATUS,
  BACKFILL_PROJECT_CURSOR_KEY,
  BACKFILL_USER_CURSOR_KEY,
  listCredentialProjectIdsForBackfill,
  listCredentialUserIdsForBackfill,
  resolveBackfillScopeBatchSize,
  writeBackfillCursor,
} from './default-capacity-pool-storage';
import {
  findDefaultPool,
  readDefaultPoolSummary,
  toSafeEffectiveCapacityPoolSummary,
} from './default-capacity-pool-summaries';
import {
  type CapacityPoolSummary,
  type CapacityPoolSummaryWorkloadRoles,
  type Db,
  type DefaultCapacityPoolOfferingResolver,
  type DefaultCapacityPoolsBackfillOptions,
  type DefaultCapacityPoolsEnsureResult,
} from './default-capacity-pool-types';
import {
  ensureInstallationDefaultPool,
  ensureProjectDefaultPool,
  ensureUserDefaultPool,
} from './default-capacity-pools-ensure';
import { scrubCapacitySourceCredentialSecrets } from './default-capacity-source-credentials';

export async function ensureDefaultCapacityPoolsForExistingCredentials(
  db: Db,
  options: DefaultCapacityPoolsBackfillOptions = {}
): Promise<DefaultCapacityPoolsEnsureResult> {
  const installation =
    options.includeInstallation === false ? null : await ensureInstallationDefaultPool(db, options);
  const user = options.userId ? await ensureUserDefaultPool(db, options.userId, options) : null;
  const project = options.projectId
    ? await ensureProjectDefaultPool(db, options.projectId, options)
    : null;
  return { installation, user, project };
}

export async function backfillDefaultCapacityPoolsForExistingCredentials(
  db: Db,
  options: DefaultCapacityPoolsBackfillOptions = {}
): Promise<{
  installation: CapacityPoolSummary | null;
  usersEnsured: number;
  projectsEnsured: number;
  credentialAnchorsScrubbed: number;
  credentialAnchorsPending: boolean;
}> {
  const installation =
    options.includeInstallation === false ? null : await ensureInstallationDefaultPool(db, options);

  const scopeBatchSize = resolveBackfillScopeBatchSize(options);
  const userIds = options.userId
    ? [options.userId]
    : await listCredentialUserIdsForBackfill(db, scopeBatchSize);
  const projectIds = options.projectId
    ? [options.projectId]
    : await listCredentialProjectIdsForBackfill(db, scopeBatchSize);

  let usersEnsured = 0;
  for (const userId of userIds) {
    await ensureUserDefaultPool(db, userId, options);
    usersEnsured += 1;
    if (!options.userId) await writeBackfillCursor(db, BACKFILL_USER_CURSOR_KEY, userId);
  }

  let projectsEnsured = 0;
  for (const projectId of projectIds) {
    await ensureProjectDefaultPool(db, projectId, options);
    projectsEnsured += 1;
    if (!options.projectId) await writeBackfillCursor(db, BACKFILL_PROJECT_CURSOR_KEY, projectId);
  }

  const anchors = await scrubCapacitySourceCredentialSecrets(db, {
    batchSize: options.credentialAnchorScrubBatchSize,
  }).catch((error: unknown) => {
    // Best-effort cleanup of SAM-generated anchors; it must never block pool reconciliation.
    // The next pass retries because the rows are still present.
    log.warn('default_capacity_pools.credential_anchor_scrub_failed', serializeError(error));
    return { scrubbedAnchors: 0, deletedUnreferencedAnchors: 0, hasMore: true };
  });

  return {
    installation,
    usersEnsured,
    projectsEnsured,
    credentialAnchorsScrubbed: anchors.scrubbedAnchors,
    credentialAnchorsPending: anchors.hasMore,
  };
}

export async function requestDefaultCapacityPoolBackfillRetry(
  db: Db,
  input: { users?: boolean; projects?: boolean } = {}
): Promise<void> {
  if (input.users !== false) {
    await writeBackfillCursor(db, BACKFILL_USER_CURSOR_KEY, null);
  }
  if (input.projects !== false) {
    await writeBackfillCursor(db, BACKFILL_PROJECT_CURSOR_KEY, null);
  }
}

export async function resolveEffectiveDefaultCapacityPoolSummary(
  db: Db,
  input: {
    userId: string;
    projectId?: string | null;
    ensure?: boolean;
    /** Placement reads existing authority without synchronously refreshing catalogs. */
    initializeOnly?: boolean;
    includeInstallation?: boolean;
    env?: Env;
    offeringResolver?: DefaultCapacityPoolOfferingResolver;
    /** Placement callers pass 'all' to see the coupled non-primary workload-role rows. */
    workloadRoles?: CapacityPoolSummaryWorkloadRoles;
  }
): Promise<CapacityPoolSummary | null> {
  if (input.ensure === true && !input.initializeOnly) {
    await ensureDefaultCapacityPoolsForExistingCredentials(db, {
      userId: input.userId,
      projectId: input.projectId ?? null,
      includeInstallation: input.includeInstallation,
      env: input.env,
      offeringResolver: input.offeringResolver,
    });
  }

  // One ordering, shared with the final-admission SQL predicate. The first scope
  // that HAS a default pool row wins outright: an existing but unusable pool
  // (configured-empty, source-disabled, disabled) is still authoritative and must
  // never fall through to a lower scope.
  const scopes = effectiveDefaultCapacityPoolScopeChain({
    userId: input.userId,
    projectId: input.projectId ?? null,
    includeInstallation: input.includeInstallation,
  });
  for (const scope of scopes) {
    if (await findDefaultPool(db, scope)) {
      const summary = await readDefaultPoolSummary(db, scope, {
        includeDisabled: true,
        workloadRoles: input.workloadRoles,
      });
      // Upgraded installations can still contain only abstract VM-size rows.
      // Materialize native offerings once; do not refresh migrated catalogs or
      // override deliberate empty/disabled pool membership on every submission.
      const needsNativeInitialization =
        summary?.pool.status === ACTIVE_STATUS &&
        summary.candidates.some(
          (candidate) =>
            candidate.runtime === 'vm' &&
            candidate.status === ACTIVE_STATUS &&
            candidate.providerInstanceType === null &&
            summary.sources.some(
              (source) =>
                source.id === candidate.capacitySourceId && source.status === ACTIVE_STATUS
            )
        ) &&
        !summary.candidates.some(
          (candidate) => candidate.runtime === 'vm' && candidate.providerInstanceType !== null
        );
      if (input.ensure === true && input.initializeOnly && needsNativeInitialization) break;
      return summary;
    }
  }

  // Existing pools are authoritative snapshots. Catalog reconciliation belongs
  // to credential lifecycle hooks and the scheduled reconciler, not every submit.
  // Preserve lazy initialization for installations with no materialized pool yet.
  if (input.ensure === true && input.initializeOnly) {
    await ensureDefaultCapacityPoolsForExistingCredentials(db, {
      userId: input.userId,
      projectId: input.projectId ?? null,
      includeInstallation: input.includeInstallation,
      env: input.env,
      offeringResolver: input.offeringResolver,
    });
    return resolveEffectiveDefaultCapacityPoolSummary(db, { ...input, ensure: false });
  }

  return null;
}

export async function resolveSafeEffectiveDefaultCapacityPoolSummary(
  db: Db,
  input: {
    userId: string;
    projectId?: string | null;
    ensure?: boolean;
    includeInstallation?: boolean;
    env?: Env;
    offeringResolver?: DefaultCapacityPoolOfferingResolver;
  }
): Promise<SafeEffectiveCapacityPoolSummary> {
  return toSafeEffectiveCapacityPoolSummary(
    await resolveEffectiveDefaultCapacityPoolSummary(db, input)
  );
}

export async function readDefaultCapacityPoolSummaries(
  db: Db,
  options: DefaultCapacityPoolsBackfillOptions & {
    ensure?: boolean;
    includeDisabled?: boolean;
  } = {}
): Promise<DefaultCapacityPoolsEnsureResult> {
  if (options.ensure) {
    await ensureDefaultCapacityPoolsForExistingCredentials(db, options);
  }

  const [installation, user, project] = await Promise.all([
    options.includeInstallation === false
      ? null
      : readDefaultPoolSummary(
          db,
          {
            scope: 'installation',
            ownerUserId: null,
            ownerProjectId: null,
          },
          options
        ),
    options.userId
      ? readDefaultPoolSummary(
          db,
          {
            scope: 'user',
            ownerUserId: options.userId,
            ownerProjectId: null,
          },
          options
        )
      : null,
    options.projectId
      ? readDefaultPoolSummary(
          db,
          {
            scope: 'project',
            ownerUserId: null,
            ownerProjectId: options.projectId,
          },
          options
        )
      : null,
  ]);

  return { installation, user, project };
}
