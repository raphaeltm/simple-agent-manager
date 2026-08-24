import { useAuth } from '../components/AuthProvider';

/**
 * The authenticated identity that scopes every cache entry.
 *
 * Authenticated query keys are `['auth', queryScope, domain, operation, …]` — see the
 * invariant documented in `lib/query-options/index.ts`. This hook is the single
 * definition of what `queryScope` is, so the derivation cannot drift between the
 * ~20 call sites that need it.
 *
 * Returns `''` when signed out, which every query option pairs with
 * `enabled: Boolean(queryScope)` so no request is issued and no entry is written
 * under an empty scope.
 */
export function useQueryScope(): string {
  const { user } = useAuth();
  return user?.id ?? '';
}
