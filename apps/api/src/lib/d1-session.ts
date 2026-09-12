/**
 * Request-scoped D1 Sessions API binding.
 *
 * SAM's D1 primaries live in North America (`sam-prod` WNAM/DFW) while its Workers and
 * Durable Objects run in Europe, so every D1 round trip from the Worker costs ~138 ms. Hot
 * routes issue those round trips *sequentially*, which is where 98% of their wall time went
 * (`GET /api/projects/:id/tasks` measured 2618 ms p50 against 44 ms CPU).
 *
 * The per-route counts that ARE reconciled with measurement: `GET /api/auth/me` traces to 2
 * queries and measured 296 ms against an 18 ms network floor (2 x 139 ms); `GET /api/projects`
 * traces to 5 and measured 707 ms (5 x 138 ms). `/tasks` and `/sessions/:sid` measure higher
 * than a static trace of their handlers accounts for (2618 ms and 2793 ms imply ~19 and ~20
 * hops against traced counts of 10-12 and 16-17), so treat those two counts as a lower bound,
 * not a measurement — the residual may be cold-isolate config reads or larger real pages.
 *
 * D1's Sessions API fixes the tail of that: the first query of a session goes to the
 * primary and every later query in the same session may be served by any replica that has
 * caught up to the bookmark that first query returned. One request therefore pays one
 * trans-Atlantic round trip instead of N.
 *
 * ## Why `first-primary` and not a bookmark
 *
 * `first-primary` anchors the session at the primary's state *at request start*: every query
 * in the request is served at or after the bookmark the first (primary) query returned. So a
 * request never sees data older than its own beginning, and no write that completed before
 * the request started can be missed — which is the property that makes this no weaker than
 * today for any writer.
 *
 * Be precise about what it does NOT promise: a write that lands on the primary *between*
 * query 1 and query N of the SAME request is not guaranteed visible to query N. That is the
 * ordinary two-non-atomic-reads race, it existed before this change, and its wall-clock window
 * is now SMALLER (the later reads are local instead of two trans-Atlantic hops) — but do not
 * build a security-sensitive check on an assumption of absolute intra-request consistency.
 *
 * Anchoring on a caller-supplied bookmark would also remove that first round trip, but it lets
 * a read be served by a replica that has not yet seen another actor's write. In SAM almost
 * every write a user is waiting on is made by an *agent*, not by that user's own browser, so
 * that is a user-visible bounded staleness window and a product decision, not an optimisation.
 *
 * ## What is deliberately NOT session-scoped
 *
 * Only the Worker `fetch` handler builds these bindings. `scheduled()` cron sweeps and
 * every Durable Object keep the raw binding, so reapers, resumers and terminal-verdict
 * paths (`.claude/rules/47`, `/53`, `/58`, `/66`) read exactly what they read today.
 *
 * One case worth naming rather than leaving implicit: `ctx.waitUntil()` work started by a
 * request continues to hold THAT request's facade after the response is sent, so it reads at
 * or after that request's bookmark, not at the raw binding. That is deliberate and safe — a
 * bookmark is a lower bound, the deferred work belongs to the request that started it, and a
 * D1 session is a bookmark holder rather than a connection with a lifetime. It is not a
 * separate routing tier, but do not read the list above as "anything after the response uses
 * the raw binding".
 *
 * ## Binding identity
 *
 * `resolvePlatformConfig` keys its per-isolate cache on the D1 binding *object identity*.
 * A fresh facade per request would miss that cache every time and pay its documented 14
 * D1 round trips, which would be far worse than the problem being fixed. Callers that key
 * anything on binding identity MUST resolve through {@link resolveD1BindingIdentity}.
 */

import { log } from './logger';

/**
 * Operator kill switch. `first-primary` is the only session anchor SAM uses; `disabled`
 * hands back the raw binding so replica routing can be turned off without a code change.
 *
 * Deliberately a deploy-time var rather than a KV switch like `CRON_SWEEPS_ENABLED_KV_KEY`:
 * this gates how EVERY request talks to D1, so a KV read to decide it would sit at the very
 * top of the path this module exists to shorten. The fast mitigation for this switch is the
 * `wrangler rollback` that `.claude/rules/55` already documents as the second resort — it is
 * more general and needs no per-request read.
 */
export const D1_SESSION_MODES = ['first-primary', 'disabled'] as const;
export type D1SessionMode = (typeof D1_SESSION_MODES)[number];

export const DEFAULT_D1_SESSION_MODE: D1SessionMode = 'first-primary';

export interface D1SessionModeEnv {
  D1_SESSION_MODE?: string;
}

/**
 * Values already warned about in this isolate. `resolveD1SessionMode` runs on every request,
 * so an unrecognised value must not produce one log line per request.
 */
const warnedSessionModes = new Set<string>();

/**
 * Resolve the session anchor, falling back to {@link DEFAULT_D1_SESSION_MODE}.
 *
 * An unrecognised value falls back rather than throwing, unlike the deploy-time sibling
 * `scripts/deploy/configure-d1-read-replication.sh`, which exits non-zero on a bad
 * `D1_READ_REPLICATION_MODE`. The asymmetry is deliberate: that one runs once per deploy and
 * failing loudly costs a deploy, while this one runs on every request, so throwing on a typo
 * would take the whole API down. This is an availability brake, and availability brakes fail
 * open here — the same reasoning `.claude/rules/55` records for the cron/alarm kill switches.
 *
 * Falling back silently would still be wrong, though: an operator who types `Disabled` or
 * `off` would get sessions ENABLED, the opposite of their intent, with no trail. So the
 * rejected value is logged once per isolate.
 */
export function resolveD1SessionMode(env: D1SessionModeEnv | undefined): D1SessionMode {
  const configured = env?.D1_SESSION_MODE?.trim();
  if (!configured) {
    return DEFAULT_D1_SESSION_MODE;
  }
  if (D1_SESSION_MODES.includes(configured as D1SessionMode)) {
    return configured as D1SessionMode;
  }
  if (!warnedSessionModes.has(configured)) {
    warnedSessionModes.add(configured);
    log.warn('d1_session.unrecognized_mode', {
      configured,
      supported: [...D1_SESSION_MODES],
      fallback: DEFAULT_D1_SESSION_MODE,
    });
  }
  return DEFAULT_D1_SESSION_MODE;
}

/** Test seam: drop the per-isolate warn-once memo. */
export function __resetD1SessionModeWarningsForTest(): void {
  warnedSessionModes.clear();
}

/**
 * Facade -> underlying binding. A WeakMap rather than a property on the facade so the
 * mapping cannot be forged by an arbitrary object and does not widen the `D1Database`
 * shape that the 496 `drizzle(...DATABASE)` call sites in `apps/api/src` see.
 */
const sessionOrigins = new WeakMap<D1Database, D1Database>();

/**
 * Resolve a (possibly session-wrapped) binding to the stable per-isolate binding object.
 *
 * Use this for anything keyed on binding identity — per-isolate caches, maps, equality
 * checks. Returns the argument unchanged when it is already a raw binding.
 */
export function resolveD1BindingIdentity(database: D1Database): D1Database;
export function resolveD1BindingIdentity(database: D1Database | undefined): D1Database | undefined;
export function resolveD1BindingIdentity(database: D1Database | undefined): D1Database | undefined {
  if (!database) return database;
  return sessionOrigins.get(database) ?? database;
}

function supportsSessions(binding: D1Database | undefined): binding is D1Database {
  // `withSession` is absent on older runtimes and on the `better-sqlite3` boundary adapter
  // used by node-environment tests. Degrading to the raw binding keeps those callers
  // working rather than throwing at the first query.
  return typeof (binding as Partial<D1Database> | undefined)?.withSession === 'function';
}

/**
 * Wrap a D1 binding so every query issued through it during one request shares a single
 * D1 session.
 *
 * The session is created lazily, so a request that never touches D1 pays nothing. Writes
 * issued through the session still go to the primary and are visible to later reads in
 * the same session, which is what makes read-after-write hold inside a request.
 *
 * `exec()` and `dump()` have no session equivalent (`D1DatabaseSession` exposes only
 * `prepare` and `batch`), so they delegate to the raw binding. `withSession()` also
 * delegates, so a caller that wants its own explicitly anchored session still gets one.
 */
export function createRequestScopedD1(
  binding: D1Database,
  mode: D1SessionMode = DEFAULT_D1_SESSION_MODE
): D1Database {
  if (mode === 'disabled' || !supportsSessions(binding)) {
    return binding;
  }

  let session: D1DatabaseSession | null = null;
  const openSession = (): D1DatabaseSession => {
    session ??= binding.withSession(mode);
    return session;
  };

  const facade: D1Database = {
    prepare: (query: string) => openSession().prepare(query),
    batch: <T = unknown>(statements: D1PreparedStatement[]) => openSession().batch<T>(statements),
    exec: (query: string) => binding.exec(query),
    dump: () => binding.dump(),
    withSession: (constraintOrBookmark?: string) => binding.withSession(constraintOrBookmark),
  };

  sessionOrigins.set(facade, binding);
  return facade;
}

export interface D1SessionBindings {
  DATABASE: D1Database;
  OBSERVABILITY_DATABASE?: D1Database;
}

/**
 * Build the per-request environment handed to the Hono app.
 *
 * A shallow clone is safe: Worker `env` is a plain object of own enumerable binding
 * properties (verified against workerd — D1, KV and Durable Object namespaces all survive
 * `{...env}` with identical `Object.keys`), and nothing in `apps/api/src` iterates
 * Worker-env keys. The clone is what keeps the session per request instead of per isolate.
 *
 * Cost, since this runs on every request (`.claude/rules/60`): one spread of the ~300 own
 * keys production `env` carries (~288 `[vars]` plus ~20 bindings), copying references only.
 * Against a route measured at 44 ms CPU / 2618 ms wall, that is not a meaningful addition —
 * but it IS per request, so do not grow this function into anything that allocates per key.
 */
export function withRequestScopedD1Bindings<T extends D1SessionBindings & D1SessionModeEnv>(
  env: T
): T {
  const mode = resolveD1SessionMode(env);
  if (mode === 'disabled') {
    return env;
  }

  const scoped: Partial<D1SessionBindings> = {};
  if (supportsSessions(env.DATABASE)) {
    scoped.DATABASE = createRequestScopedD1(env.DATABASE, mode);
  }
  if (supportsSessions(env.OBSERVABILITY_DATABASE)) {
    scoped.OBSERVABILITY_DATABASE = createRequestScopedD1(env.OBSERVABILITY_DATABASE, mode);
  }

  // Nothing to scope — a runtime or test harness without `withSession`. Hand back the
  // original object so no needless clone reaches the request.
  if (Object.keys(scoped).length === 0) {
    return env;
  }

  return { ...env, ...scoped };
}
