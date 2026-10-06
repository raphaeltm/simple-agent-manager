import {
  DEFAULT_MODEL_CATALOG_RESPONSE_CACHE_MAX_AGE_SECONDS,
  DEFAULT_MODEL_CATALOG_RESPONSE_CACHE_SWR_SECONDS,
  DEFAULT_PROJECT_REFERENCE_CACHE_MAX_AGE_SECONDS,
  DEFAULT_PROJECT_REFERENCE_CACHE_SWR_SECONDS,
  DEFAULT_PUBLIC_CONFIG_CACHE_MAX_AGE_SECONDS,
  DEFAULT_PUBLIC_CONFIG_CACHE_SWR_SECONDS,
} from '@simple-agent-manager/shared';
import type { Context } from 'hono';

/**
 * Conservative `Cache-Control` for stable / semi-stable API GETs.
 *
 * ## Where these headers actually take effect (read this first)
 *
 * **Only in the requesting browser's own cache.** They do nothing at the
 * Cloudflare edge today: this Worker builds every response itself (`c.json(...)`)
 * with no origin `fetch()` subrequest and no Cache API write, and Cloudflare's CDN
 * cache is only consulted for responses that came from a subrequest. JSON is not
 * a default-cacheable type either, `apps/api/wrangler.toml` has no `[cache]`
 * block, and `infra/` defines no Cache Rules. So do not read this module as
 * reducing Worker invocations, D1 load, or origin traffic — it reduces repeat
 * *browser* fetches on reload and back-navigation, nothing more.
 *
 * The `private` discipline below is nonetheless written to stay correct if
 * Workers Cache (`[cache] enabled = true`) or a Cache Rule is turned on later, at
 * which point these responses WOULD become edge-cacheable.
 *
 * ## Two different threats, two different mechanisms
 *
 * These are easy to conflate; they are not interchangeable, so do not drop one
 * believing the other covers it:
 *
 *  - **A shared cache serving user A's body to user B** is prevented by
 *    **`private`**, on its own and unconditionally — Cloudflare documents that it
 *    will not cache a response marked `private`/`no-store`/`no-cache`/`max-age=0`,
 *    and that is true regardless of `Vary`. (Cloudflare's classic cache ignores
 *    `Vary` for anything but `Accept-Encoding` unless a Cache Rules Vary setting
 *    is configured, so `Vary: Cookie` must NOT be relied on for this threat.)
 *  - **A second login in the SAME browser profile reading the first login's
 *    entry** is prevented by **`Vary: Cookie`**. The browser's private cache is
 *    keyed per profile, not per session, so without it user B could be served
 *    user A's entry for the same URL after an account switch. Varying on the
 *    session cookie gives each login its own entry.
 *
 * The split is enforced by the type rather than by reviewer discipline: `public`
 * is only reachable through {@link PUBLIC_CACHE_POLICIES}, whose members are
 * unauthenticated endpoints whose body is byte-identical for every caller.
 *
 * Note that `Vary: Origin` is already present on every response — Hono's `cors()`
 * appends it whenever `origin` is a function, which `index.ts` configures. Our
 * `Vary: Cookie` composes with it (`Cookie, Origin`) rather than replacing it;
 * `cache-headers.test.ts` pins that.
 *
 * Endpoints returning real-time data (chat messages, task status, session state,
 * workspace status) are intentionally absent. This module is opt-in per handler
 * precisely so nothing acquires caching by accident.
 */
export type CachePolicyName =
  /** Unauthenticated, deploy-scoped config (`/api/config/*`). */
  | 'public-config'
  /** Authenticated but globally identical: the agent model catalog. */
  | 'model-catalog'
  /** Authenticated and per-user: project agent profiles, project skills. */
  | 'project-reference';

/** Policies allowed to emit `public`. Everything else is `private` + `Vary: Cookie`. */
const PUBLIC_CACHE_POLICIES: ReadonlySet<CachePolicyName> = new Set<CachePolicyName>([
  'public-config',
]);

/**
 * Env subset this module reads. Narrowed via a structural type rather than the
 * full `Env` so the resolver stays unit-testable without a Worker binding
 * (matches the `ModelCatalogEnv` pattern in `services/model-catalog.ts`).
 */
export interface CacheHeaderEnv {
  PUBLIC_CONFIG_CACHE_MAX_AGE_SECONDS?: string;
  PUBLIC_CONFIG_CACHE_SWR_SECONDS?: string;
  MODEL_CATALOG_CACHE_MAX_AGE_SECONDS?: string;
  MODEL_CATALOG_CACHE_SWR_SECONDS?: string;
  PROJECT_REFERENCE_CACHE_MAX_AGE_SECONDS?: string;
  PROJECT_REFERENCE_CACHE_SWR_SECONDS?: string;
}

interface CachePolicyDefaults {
  maxAgeEnvKey: keyof CacheHeaderEnv;
  swrEnvKey: keyof CacheHeaderEnv;
  defaultMaxAgeSeconds: number;
  defaultSwrSeconds: number;
}

const CACHE_POLICY_DEFAULTS: Record<CachePolicyName, CachePolicyDefaults> = {
  'public-config': {
    maxAgeEnvKey: 'PUBLIC_CONFIG_CACHE_MAX_AGE_SECONDS',
    swrEnvKey: 'PUBLIC_CONFIG_CACHE_SWR_SECONDS',
    defaultMaxAgeSeconds: DEFAULT_PUBLIC_CONFIG_CACHE_MAX_AGE_SECONDS,
    defaultSwrSeconds: DEFAULT_PUBLIC_CONFIG_CACHE_SWR_SECONDS,
  },
  'model-catalog': {
    maxAgeEnvKey: 'MODEL_CATALOG_CACHE_MAX_AGE_SECONDS',
    swrEnvKey: 'MODEL_CATALOG_CACHE_SWR_SECONDS',
    defaultMaxAgeSeconds: DEFAULT_MODEL_CATALOG_RESPONSE_CACHE_MAX_AGE_SECONDS,
    defaultSwrSeconds: DEFAULT_MODEL_CATALOG_RESPONSE_CACHE_SWR_SECONDS,
  },
  'project-reference': {
    maxAgeEnvKey: 'PROJECT_REFERENCE_CACHE_MAX_AGE_SECONDS',
    swrEnvKey: 'PROJECT_REFERENCE_CACHE_SWR_SECONDS',
    defaultMaxAgeSeconds: DEFAULT_PROJECT_REFERENCE_CACHE_MAX_AGE_SECONDS,
    defaultSwrSeconds: DEFAULT_PROJECT_REFERENCE_CACHE_SWR_SECONDS,
  },
};

/** Upper bound on any configured cache window (24h) — a fat-fingered env value
 * must not pin a stale body in browsers for weeks. */
const MAX_CACHE_SECONDS = 24 * 60 * 60;

/**
 * Parse a non-negative integer seconds value, clamped to `[0, MAX_CACHE_SECONDS]`.
 * Anything unparseable, negative, or fractional falls back to the default — an
 * operator typo degrades to the shipped policy rather than to "cache forever".
 */
function resolveCacheSeconds(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, MAX_CACHE_SECONDS);
}

export interface ResolvedCachePolicy {
  cacheControl: string;
  /** `Cookie` for authenticated policies, `undefined` for public ones. */
  vary?: string;
}

/**
 * Resolve a policy name to the exact header values, applying env overrides.
 * Exported so tests can assert the resolution independently of Hono.
 */
export function resolveCachePolicy(
  policy: CachePolicyName,
  env: CacheHeaderEnv | undefined
): ResolvedCachePolicy {
  const config = CACHE_POLICY_DEFAULTS[policy];
  const maxAge = resolveCacheSeconds(env?.[config.maxAgeEnvKey], config.defaultMaxAgeSeconds);
  const swr = resolveCacheSeconds(env?.[config.swrEnvKey], config.defaultSwrSeconds);

  const isPublic = PUBLIC_CACHE_POLICIES.has(policy);
  const cacheControl = `${isPublic ? 'public' : 'private'}, max-age=${maxAge}, stale-while-revalidate=${swr}`;

  return isPublic ? { cacheControl } : { cacheControl, vary: 'Cookie' };
}

/**
 * Apply a cache policy to the response being built.
 *
 * MUST be called before the terminal `c.json(...)` / `c.body(...)`, because Hono
 * finalizes headers when the response is created.
 */
export function applyCacheHeaders<E extends { Bindings: CacheHeaderEnv }>(
  c: Context<E>,
  policy: CachePolicyName
): void {
  const resolved = resolveCachePolicy(policy, c.env);
  c.header('Cache-Control', resolved.cacheControl);
  if (resolved.vary) c.header('Vary', resolved.vary);
}
