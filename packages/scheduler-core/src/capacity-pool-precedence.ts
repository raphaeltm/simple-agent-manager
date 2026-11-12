import type { CapacityPoolScope } from '@simple-agent-manager/shared';

/**
 * The single definition of "which default capacity pool governs a run".
 *
 * v1 considers exactly one effective pool per run and never falls back between
 * pools: the highest-precedence scope that has a default pool row wins, even when
 * that pool is configured-empty, source-disabled, catalog-unavailable or disabled.
 * Both the read-side resolver (`resolveEffectiveDefaultCapacityPoolSummary`) and
 * the final admission SQL (`buildPlacementAuthoritySqlPredicate`) derive their
 * decision from this ordering so the two can never disagree.
 */
export const EFFECTIVE_DEFAULT_CAPACITY_POOL_SCOPE_PRECEDENCE = [
  'project',
  'user',
  'installation',
] as const satisfies readonly CapacityPoolScope[];

export interface EffectiveDefaultCapacityPoolScope {
  scope: CapacityPoolScope;
  ownerUserId: string | null;
  ownerProjectId: string | null;
}

export interface EffectiveDefaultCapacityPoolScopeInput {
  userId: string;
  projectId?: string | null;
  includeInstallation?: boolean;
}

/**
 * Ordered scopes considered for one run, highest precedence first. A scope is
 * omitted only when it cannot exist for this caller (no project context) or when
 * the caller explicitly excludes installation fallback.
 */
export function effectiveDefaultCapacityPoolScopeChain(
  input: EffectiveDefaultCapacityPoolScopeInput
): EffectiveDefaultCapacityPoolScope[] {
  const chain: EffectiveDefaultCapacityPoolScope[] = [];
  for (const scope of EFFECTIVE_DEFAULT_CAPACITY_POOL_SCOPE_PRECEDENCE) {
    if (scope === 'project') {
      if (!input.projectId) continue;
      chain.push({ scope, ownerUserId: null, ownerProjectId: input.projectId });
      continue;
    }
    if (scope === 'user') {
      chain.push({ scope, ownerUserId: input.userId, ownerProjectId: null });
      continue;
    }
    if (input.includeInstallation === false) continue;
    chain.push({ scope, ownerUserId: null, ownerProjectId: null });
  }
  return chain;
}

/**
 * Scopes that outrank `scope` for this caller. A default pool at any of these
 * scopes is authoritative, so a lower-scope pool can never be the effective pool
 * while one exists — this is the "no cross-pool fallback" rule expressed as data.
 */
export function higherPrecedenceDefaultCapacityPoolScopes(
  scope: CapacityPoolScope,
  input: EffectiveDefaultCapacityPoolScopeInput
): EffectiveDefaultCapacityPoolScope[] {
  const rank = EFFECTIVE_DEFAULT_CAPACITY_POOL_SCOPE_PRECEDENCE.indexOf(scope);
  if (rank < 0) return [];
  return effectiveDefaultCapacityPoolScopeChain(input).filter(
    (entry) => EFFECTIVE_DEFAULT_CAPACITY_POOL_SCOPE_PRECEDENCE.indexOf(entry.scope) < rank
  );
}
