import { capacityPoolRefreshSettings } from './capacity-pool-refresh-settings';
import { beginCapacityPoolRefresh, finishCapacityPoolRefresh } from './capacity-pool-refresh-work';
import { readDefaultPoolSummary } from './default-capacity-pool-summaries';
import type {
  CapacityPoolSummary,
  Db,
  DefaultCapacityPoolsBackfillOptions,
  ScopeIdentity,
} from './default-capacity-pool-types';

export async function withCapacityPoolRefresh(
  db: Db,
  scope: ScopeIdentity,
  options: DefaultCapacityPoolsBackfillOptions,
  noActiveSeeds: boolean,
  operation: (
    boundedOptions: DefaultCapacityPoolsBackfillOptions
  ) => Promise<CapacityPoolSummary | null>
): Promise<CapacityPoolSummary | null> {
  const settings = options.refreshSettings ?? (await capacityPoolRefreshSettings(options.env));
  const boundedOptions = {
    ...options,
    reconciliationDeadlineAt:
      options.reconciliationDeadlineAt ?? Date.now() + settings.passBudgetMs,
  };
  const work = await beginCapacityPoolRefresh(
    db,
    scope,
    settings,
    options.refreshContinuation,
    options.refreshClaim
  );
  if (!work) return readDefaultPoolSummary(db, scope, { includeDisabled: true });
  if (
    (options.refreshContinuation && Date.now() >= work.deadlineAt) ||
    Date.now() >= boundedOptions.reconciliationDeadlineAt
  ) {
    await finishCapacityPoolRefresh(db, work, settings, false);
    return readDefaultPoolSummary(db, scope, { includeDisabled: true });
  }
  boundedOptions.reconciliationDeadlineAt = Math.min(
    boundedOptions.reconciliationDeadlineAt,
    work.deadlineAt
  );
  try {
    const result = await operation(boundedOptions);
    await finishCapacityPoolRefresh(
      db,
      work,
      settings,
      noActiveSeeds ||
        (result !== null && result.pool.status !== 'active') ||
        result?.pool.migrationState === 'complete'
    );
    return result;
  } catch (error) {
    // Store an actionable category, never raw provider errors/credential payloads.
    await finishCapacityPoolRefresh(
      db,
      work,
      settings,
      false,
      'Compute catalog refresh failed. SAM will retry automatically within its recovery budget.'
    );
    throw error;
  }
}
