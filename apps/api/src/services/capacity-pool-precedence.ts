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

export type CapacityPoolPrecedenceBind = string | number | null;

export interface CapacityPoolPrecedenceSql {
  sql: string;
  binds: CapacityPoolPrecedenceBind[];
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

export interface DefaultCapacityPoolScopeSqlOptions {
  /**
   * SQL expression already equal to the placing user's id (for example the node
   * alias's `user_id` column). Supplying it removes a duplicate bound parameter
   * from the composed final-admission statement, which runs against D1's
   * 100-bind ceiling.
   */
  userIdSql?: string;
  /** Same idea for the project id, when an outer column already equals it. */
  projectIdSql?: string;
}

/**
 * `EXISTS`-style membership test for "a default pool row exists at one of these
 * scopes". Status is deliberately NOT filtered: `findDefaultPool` does not filter
 * it either, so a disabled or otherwise unusable default pool still shadows every
 * lower scope. Returns null when the scope list is empty.
 */
export function buildDefaultCapacityPoolScopeMatchSql(
  alias: string,
  scopes: readonly EffectiveDefaultCapacityPoolScope[],
  options: DefaultCapacityPoolScopeSqlOptions = {}
): CapacityPoolPrecedenceSql | null {
  const safeAlias = assertSafeSqlAlias(alias);
  if (scopes.length === 0) return null;

  const fragments: string[] = [];
  const binds: CapacityPoolPrecedenceBind[] = [];
  for (const entry of scopes) {
    switch (entry.scope) {
      case 'project': {
        if (!entry.ownerProjectId) continue;
        const projectSql = options.projectIdSql ?? '?';
        if (!options.projectIdSql) binds.push(entry.ownerProjectId);
        fragments.push(
          `(${safeAlias}.scope = 'project'
            AND ${safeAlias}.owner_project_id = ${projectSql}
            AND ${safeAlias}.owner_user_id IS NULL)`
        );
        continue;
      }
      case 'user': {
        if (!entry.ownerUserId) continue;
        const userSql = options.userIdSql ?? '?';
        if (!options.userIdSql) binds.push(entry.ownerUserId);
        fragments.push(
          `(${safeAlias}.scope = 'user'
            AND ${safeAlias}.owner_user_id = ${userSql}
            AND ${safeAlias}.owner_project_id IS NULL)`
        );
        continue;
      }
      default: {
        fragments.push(
          `(${safeAlias}.scope = 'installation'
            AND ${safeAlias}.owner_user_id IS NULL
            AND ${safeAlias}.owner_project_id IS NULL)`
        );
      }
    }
  }

  if (fragments.length === 0) return null;
  return {
    sql: `${safeAlias}.is_default = 1
      AND (${fragments.join('\n        OR ')})`,
    binds,
  };
}

/**
 * `NOT EXISTS (a default pool at a higher-precedence scope)` for a placement that
 * claims a pool at `scope`. Returns null when nothing outranks `scope`.
 */
export function buildHigherPrecedenceDefaultCapacityPoolExclusionSql(
  scope: CapacityPoolScope,
  input: EffectiveDefaultCapacityPoolScopeInput,
  options: DefaultCapacityPoolScopeSqlOptions & { alias?: string } = {}
): CapacityPoolPrecedenceSql | null {
  const alias = options.alias ?? 'higher_precedence_default_pool';
  const match = buildDefaultCapacityPoolScopeMatchSql(
    alias,
    higherPrecedenceDefaultCapacityPoolScopes(scope, input),
    options
  );
  if (!match) return null;
  return {
    sql: `NOT EXISTS (
      SELECT 1
      FROM capacity_pools ${assertSafeSqlAlias(alias)}
      WHERE ${match.sql}
    )`,
    binds: match.binds,
  };
}

/**
 * `NOT EXISTS (any default pool this caller would be governed by)`. Used for
 * legacy unpooled nodes: once any default pool exists for the caller, an unpooled
 * node is no longer covered by current placement authority.
 */
export function buildAnyDefaultCapacityPoolExclusionSql(
  input: EffectiveDefaultCapacityPoolScopeInput,
  options: DefaultCapacityPoolScopeSqlOptions & { alias?: string } = {}
): CapacityPoolPrecedenceSql | null {
  const alias = options.alias ?? 'legacy_blocking_pool';
  const match = buildDefaultCapacityPoolScopeMatchSql(
    alias,
    effectiveDefaultCapacityPoolScopeChain(input),
    options
  );
  if (!match) return null;
  return {
    sql: `NOT EXISTS (
      SELECT 1
      FROM capacity_pools ${assertSafeSqlAlias(alias)}
      WHERE ${match.sql}
    )`,
    binds: match.binds,
  };
}

function assertSafeSqlAlias(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Unsafe SQL alias: ${value}`);
  }
  return value;
}
