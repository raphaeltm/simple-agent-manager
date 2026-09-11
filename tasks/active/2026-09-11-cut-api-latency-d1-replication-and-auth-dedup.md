# Cut SAM API latency: D1 read replication + one auth pass per request

**Status**: active (implementation complete; validation + review in progress)
**Created**: 2026-09-11
**SAM task**: `01M27M163YMDKDDT2CZKVET8SY`
**Idea**: `01M27KAF3Z9YEM6VADJKE1ZXC6`

## Problem

Core UI routes take 2.3–3.1 s wall with 25–50 ms CPU. ~98 % is I/O wait against D1.

Two independent causes:

1. **D1 lives in Dallas; Workers and Durable Objects run in Europe.** Every D1 round
   trip from the Worker costs ~140 ms, and the hot routes issue 3–19 *sequential*
   round trips.
2. **The auth stack runs twice on every project sub-route.** `projectsRoutes` registers
   `use('/*', requireAuth(), requireApproved())` at `/api/projects/*`, which also matches
   the separately mounted `/api/projects/:projectId/{tasks,sessions,…}` routers — and
   those register auth again.

## Re-verified evidence (2026-09-11, this branch)

### D1 placement — confirmed

| Database | uuid | region | `read_replication` |
|---|---|---|---|
| `sam-staging` | `1cfaf5d4-…` | WNAM (DFW) | `disabled` |
| `sam-observability-staging` | `8c2fa46c-…` | WNAM | `disabled` |
| `sam-prod` | `a8923a52-…` | WNAM | `disabled` |
| `sam-observability-prod` | `68b1c534-…` | ENAM | `disabled` |

`SELECT 1` on staging returns `served_by_colo: "DFW"`, `served_by_primary: true`,
`sql_duration_ms: 0.14`. The database is fast; the distance is the cost.

### Staging baseline (warm, keep-alive, 7 samples, first discarded)

Captured with `.tmp/measure-latency.sh` at 2026-09-11T07:09Z:

| Route | p50 (ms) | min | max |
|---|---|---|---|
| `/health` (no D1 — network floor) | 18 | 17 | 20 |
| `/api/auth/me` | 296 | 283 | 305 |
| `/api/projects` | 707 | 688 | 712 |
| `/api/projects/:id/tasks` | 2618 | 2478 | 4120 |
| `/api/projects/:id/sessions` | 2417 | 2396 | 2553 |
| `/api/projects/:id/sessions/:sid` | 2793 | 2702 | 5060 |

Derived: with an 18 ms network floor, `/api/auth/me` (one `getSession`, no approval
check) costs 278 ms and `/api/projects` (getSession + approval + list + workspace
counts) costs 689 ms. Both are consistent with **`getSession` = 2 sequential D1 queries
and a per-query round trip of ≈ 138 ms**.

### Hono double-execution — confirmed by probe, not by docs

A throwaway probe mirroring the production mounting
(`app.route('/api/projects', projectsRoutes)` where `projectsRoutes.use('/*', …)`, plus
`app.route('/api/projects/:projectId/tasks', tasksRoutes)` where the handler registers
its own middleware) recorded, for `GET /api/projects/p1/tasks`:

```
['projectsRoutes:/*', 'tasks:/']
```

Both layers run. **Change B is justified.** This probe becomes a permanent test.

### D1 Sessions API — confirmed available and semantics verified

* `withSession` / `getBookmark` / `batch` all work in workerd + Miniflare
  (`vitest-pool-workers`); a probe returned bookmark
  `00000000-000000ae-00000000-00000000000000000000000000000000` and proved
  read-after-write inside one session.
* Cloudflare docs: without the Sessions API **all queries continue to go to the
  primary**, even with replication enabled; and the Sessions API works against a
  database with replication *disabled*. **The code change and the config change are
  therefore independent and can land in either order.**
* `withSession("first-primary")` = first query to primary, every later query in the
  session constrained to at least that bookmark.
* Bookmark ordering is **not documented as comparable** — do not build a
  "keep the newer bookmark" rule on lexicographic comparison.

### Traps found during research (each needs a checklist item)

1. **`resolvePlatformConfig` caches per isolate keyed on D1 *binding object identity*
   (`cached.database === database`, `platform-config-core.ts:492`).** A fresh
   per-request session facade would miss that cache on *every* request and pay its
   documented **14 D1 round trips**, i.e. +1.9 s per request — strictly worse than
   today. The cache key must resolve through the facade to the underlying binding.
   It is the only binding-identity-keyed cache in `apps/api/src` (the other four
   module-scope caches key on strings or nothing).
2. **`D1DatabaseSession` has no `exec()` / `dump()`.** The facade must delegate those
   to the raw binding. (No `D1Database.exec()`/`.dump()` call sites exist in
   `apps/api/src` today, but the facade must still satisfy the `D1Database` type.)
3. **Removing the redundant `requireAuth()` registrations is a security risk.** A route
   that loses its *only* auth registration is a hole. Memoising inside the middleware
   achieves "exactly one session resolution per request" while leaving the set of
   authenticated routes byte-identical — including the rule-34 ordering that lets
   VM-agent callback routes match *before* `projectsRoutes` and keep callback-JWT auth.
4. **Pulumi `readReplication` may be a replace-forcing field.** `infra/resources/database.ts`
   currently sets `ignoreChanges: ["readReplication"]`. Provider `@pulumi/cloudflare@6.15.0`
   accepts `readReplication` in `D1DatabaseArgs`, but a replacement diff on a live
   production D1 is catastrophic and irreversible (rule 31). Use the deploy-script path.
5. **`vi.mock` does not reach the `SELF` worker's module graph** under
   `vitest-pool-workers` (probed: mock counter stayed at 0 while the request returned
   200 through the real app). Counting assertions must run against a locally-mounted
   real-router app; `SELF.fetch` carries the behavioural/security assertions.
6. **Worker `env` shallow-clone is safe** in workerd — probed `{...env}` preserving D1,
   KV and Durable Object namespace bindings, with identical `Object.keys`. No code in
   `apps/api/src` iterates Worker-env keys.

## Design decisions

### A1 — enable `read_replication.mode = "auto"` via a deploy script, not Pulumi

Chosen: **(b) an idempotent deploy step that PUTs the setting via the Cloudflare API.**

* `PUT /accounts/{account}/d1/database/{id}` with `{"read_replication":{"mode":"auto"}}`
  is the only documented mutator, `read_replication` is its *only* body field (so it
  cannot clobber `name`/`jurisdiction`), and it needs `D1:Edit` — which the deploy token
  already holds because Pulumi creates the databases with it. **No new self-hoster
  permission.**
* Idempotent by construction: read the current mode first, skip when already `auto`.
  Identical behaviour on a clean install and an upgrade (policy `7d24e435`).
* `ignoreChanges: ["readReplication"]` **stays** in Pulumi, now for a second reason:
  it stops `pulumi refresh`/`up` from fighting the script. Comment updated to record
  the split ownership.

Rejected: (a) removing `ignoreChanges` and setting `readReplication` in Pulumi — the
downside of a replace-forcing diff on `sam-prod` is total, irreversible data loss, and
it cannot be disproven from the TypeScript SDK types alone.

### A2 — request-scoped D1 session anchored `first-primary`, at one integration point

`export default { fetch }` in `apps/api/src/index.ts` builds a per-request `env` whose
`DATABASE` / `OBSERVABILITY_DATABASE` are session-backed facades. All 503
`drizzle(env.DATABASE, …)` call sites inherit it with no call-site churn (drizzle's D1
driver only uses `prepare`/`batch`, both of which `D1DatabaseSession` provides).

**`first-primary`, not a bookmark.** With `first-primary` the first query goes to the
primary and every later query in the request is constrained to at least that bookmark,
so a request observes a snapshot **at least as fresh as its own start**. That is:

* strictly no staleness relative to today for cross-user/agent writes, so **no product
  decision is required**;
* and strictly safe for reapers, resumers and terminal verdicts (rules 58/66) — which in
  any case run in `scheduled()` and Durable Objects, both of which keep the **raw** env.

Bookmark-anchored reads (which would also remove the one remaining primary round trip)
are deliberately **out of scope**: they let a read be served by a replica that has not
yet seen another actor's write, and in SAM almost every write a user is waiting on is
made by an *agent*, not by that user's own browser. That is a user-visible bounded
staleness window, i.e. exactly the product decision the task says to stop and ask about.
Recorded as a follow-up with measurements rather than guessed at.

Kill switch: `D1_SESSION_MODE` ∈ {`first-primary`, `disabled`}, default `first-primary`,
so an operator can turn sessions off without a code change.

### A3 — the membership pair: concurrent, not batched

`requireActiveProjectMembership` issues a project `select` then a membership `select` with
no data dependency, so batching them into one `db.batch()` looked like a free round trip.
It was implemented and then reverted, because **A2 subsumes most of its value and it turned
out not to be "cheap and safe"**:

* With `first-primary` sessions only the request's FIRST query crosses to the primary, and
  that is the auth preamble — not this. The second of these selects is served by a nearby
  replica, so batching now saves roughly 10 ms, not the ~140 ms it would have saved before
  A2 landed.
* It broke 76 tests across 7 files whose drizzle/D1 doubles have no `batch`. Six of those
  could be fixed cheaply, but `tests/unit/routes/mcp.test.ts` (241 tests) mocks at the D1
  binding level with a single shared statement object across every `prepare()`, so it
  cannot distinguish batched statements at all without rewriting its double.

Rewriting a 241-test authorization suite to buy ~10 ms is a bad trade.

**But the concurrency was still worth taking.** The performance review pointed out that
`Promise.all` gets the same overlap without `db.batch()` — the request waits for the slower of
the two reads instead of their sum — and costs nothing in test churn, because every one of
those doubles already resolves `.limit()` to a promise. That is what shipped. All 14 test files
that the `db.batch()` attempt broke pass unchanged (348 tests). The decision and the arithmetic
live in a comment on the function so the next reader does not re-derive them.

The same one-line treatment was applied to the worst route's other obviously-independent pair:
`computeBlockedSet` and `resolveTaskAgentProfileHints` in `routes/tasks/crud.ts` read different
tables and neither consumes the other's result.

The real-SQL-engine tests added for these predicates are kept — they are worth having either
way, and they now cover predicates whose reads are replica-served.

### B — one auth pass per request, by memoisation

`requireAuth()` reuses `c.get('auth')` when present; `requireApproved()` memoises the
signup-approval read on the request context. Both auth-context writers already sit
behind `assertUserNotSuspended`, so reuse cannot widen access. `disableCookieCache: true`
is **not** touched — see below.

### `disableCookieCache: true` — evaluated, deliberately unchanged

`apps/api/src/auth.ts:348-367` already documents why: `requireAuth` and `requireApproved`
read `status`/`role` straight out of the session payload, and no write path re-checks
account status independently, so serving from the signed cookie cache would let a
suspended or de-approved account keep full access for up to `maxAge`. That is exactly
the "Unconditional Account-Denial Gates" prohibition in `.claude/rules/02`. Re-enabling
it requires a separate `user.updatedAt` revalidation design. **Left alone; reasoning
recorded.** Note that Change B already halves this cost by removing the duplicate pass.

## Read/write routing table (rule 44 — enumerate every path)

| Execution context | `env.DATABASE` | Rationale |
|---|---|---|
| Hono `fetch` — browser GET/POST, MCP, CLI | session, `first-primary` | Snapshot ≥ request start; writes in a session always hit primary and are visible to later reads in the same session. |
| Hono `fetch` — VM-agent callback routes (`/ready`, heartbeat, ACP activity, task callback, deploy-release…) | session, `first-primary` | Same guarantee; these routes are mounted *before* `projectsRoutes` and keep callback-JWT auth (rule 34) — mounting is untouched. |
| `scheduled()` cron sweeps | **raw binding** | Terminal-verdict and reaper paths (rules 47/53/58/66) keep today's exact read semantics. |
| Durable Objects (`ProjectData`, `TaskRunner`, `NodeLifecycle`, …) | **raw binding** | Constructed by the runtime with the real env; untouched. |
| `queue()` / alarms | **raw binding** | Not reached by the `fetch` wrapper. |

Writes are never routed away from the primary: D1 routes every write in a session to the
primary and advances the session bookmark.

## Implementation checklist

### Change A — replication + sessions
- [x] `apps/api/src/lib/d1-session.ts`: `D1_SESSION_MODES`, `DEFAULT_D1_SESSION_MODE`,
      `resolveD1SessionMode(env)`, `createRequestScopedD1(binding, mode)` (lazy session,
      `exec`/`dump`/`withSession` delegated to the raw binding),
      `resolveD1BindingIdentity(database)`, `withRequestScopedD1Bindings(env)`.
- [x] `apps/api/src/index.ts`: default `fetch` builds the per-request env. `scheduled`
      unchanged.
- [x] `apps/api/src/env.ts`: add `D1_SESSION_MODE?: string`.
- [x] `apps/api/src/services/platform-config-core.ts`: derive the cache key with
      `resolveD1BindingIdentity` (trap 1).
- [x] ~~`apps/api/src/middleware/project-auth.ts`: batch the project + membership selects.~~ Considered, implemented, reverted — see "A3" above. Replaced by a comment recording the decision.
- [x] `apps/api/wrangler.toml`: document `D1_SESSION_MODE` in `[vars]`.
- [x] `scripts/deploy/configure-d1-read-replication.sh` (idempotent, fails loudly).
- [x] `.github/workflows/deploy-reusable.yml`: new step after "Configure AI Gateway".
- [x] `infra/resources/database.ts`: keep `ignoreChanges`, rewrite the comment to record
      split ownership.
- [x] Docs: self-hosting guide + `apps/www` architecture/overview note on replica reads.

### Change B — one auth pass
- [x] `apps/api/src/middleware/auth.ts`: `requireAuth()` reuses an existing auth context;
      `requireApproved()` memoises the signup-approval read per request.

### Tests
- [x] Mounting-shape test: the production mounting really does enter both middleware
      layers (pins the premise; would go red if Hono ever changed).
- [x] Dedup test: real `requireAuth`/`requireApproved` registered twice ⇒ exactly one
      `getSession` and one signup-approval read. Proven discriminating.
- [x] `SELF.fetch` real-trigger control pair: unauthenticated ⇒ 401, authenticated owner
      ⇒ 200 with correct body, on the real app with a real better-auth session cookie
      (`createSessionCookieForUser`).
- [x] `platform-config-core` cache-identity test: two different session facades over one
      raw binding ⇒ second call is a cache hit. Must fail without `resolveD1BindingIdentity`.
- [x] Workers (real workerd + real D1) read-after-write test through the session facade,
      including a write followed immediately by a read (`.claude/rules/69` — a
      `better-sqlite3` harness has no `withSession`, so this must run on workerd).
- [x] Facade unit tests: laziness, one session per request, `exec`/`dump` delegation,
      `disabled` mode returns the raw binding, missing `withSession` degrades gracefully.
- [x] Membership-batch behavioural tests against a real SQL engine, including the
      inactive-membership and cross-project refusals with owner-path controls (rule 28).

### Verification
- [ ] Re-measure staging with `.tmp/measure-latency.sh` after deploy; both numbers in the PR.
- [ ] Verify the **deployed** `read_replication` value from the Cloudflare API (rule 70)
      and check for GitHub Environment variable overrides of any changed `wrangler.toml` var.
- [ ] Playwright staging pass (dismiss the first-run "Account setup" dialog after each
      navigation).

## Implementation notes

- `withRequestScopedD1Bindings` is applied in the Worker default export only, so
  `scheduled()` and every Durable Object keep the raw bindings by construction rather than
  by convention.
- The `platform-config-core` identity trap was real: with the naive key, the two added
  cache tests fail (verified by temporarily reverting `resolveD1BindingIdentity`), which
  would have meant 14 extra D1 round trips on *every* authenticated request.
- `tests/helpers/sqlite-d1.ts` `batch()` previously discarded SELECT rows. Batching the
  membership lookups surfaced that: left unfixed, every batched ownership guard would have
  rejected for the wrong reason. It now returns rows for row-returning statements, and the
  counting adapter in `platform-config-cache.test.ts` routes `withSession` through its own
  counter so a session-wrapped binding cannot silently report zero queries.
- Change B is implemented by memoisation inside the middleware rather than by deleting the
  duplicate registrations. Same observable outcome (one session resolution per request),
  but the set of authenticated routes and the rule-34 callback-route mounting order are
  untouched, so no route can lose its only auth registration.
- `D1_READ_REPLICATION_MODE` reaches the deploy script through `env:`, never through a
  `run:` interpolation (`.claude/rules/02` workflow input trust boundaries), and the step
  runs before `Deploy API Worker` (pinned by a workflow-ordering test).

## Review round (Phase 5)

Nine local reviewers. No CRITICAL, one HIGH (security-auditor: staging verification not yet
done — that is Phase 6, not a code defect). Everything actionable was fixed on the branch:

| Reviewer | Fixed |
|---|---|
| constitution-validator | An unrecognised `D1_SESSION_MODE` was discarded silently — an operator typing `Disabled` would have got sessions ENABLED with no trail. Now warns once per isolate, with two tests. |
| doc-sync-validator + env-validator | `reference/configuration.md` has its own copies of both variable tables and was missed; a stale "13 D1 queries" (actually 14); a permission callout that did not match the document's own `Account → X → Edit` convention; no CLAUDE.md Recent Changes entry. |
| architecture-reviewer | `env.ts` gave a reader of `drizzle(c.env.DATABASE)` no way to discover the session facade; `PlatformConfigCacheEntry`'s comment predated per-request facades; the env-clone cost was unquantified; the deploy-var-vs-KV-switch trade-off was implicit; a test name left over from the reverted batch attempt. |
| performance-reviewer | The "3-19 sequential round trips" figure does not reconcile with measurement for `/tasks` and `/sessions/:sid` (traced 10-12 and 16-17 against ~19 and ~20 implied) — the docstring now states which counts ARE reconciled and calls the other two a lower bound. Also: `Promise.all` instead of `db.batch()` (see A3), and `computeBlockedSet`/`resolveTaskAgentProfileHints` concurrently. |
| security-auditor | "strictly no staleness" overstated the guarantee: `first-primary` does not promise that a write landing *during* a request is visible to that request's later queries. Reworded in the code and both docs. Also: guard each `pulumi stack output` individually, and cross-reference the session-facade counterpart from `project-auth.test.ts`. |
| task-completion-validator | The bookmark deferral now has a real backlog file (`tasks/backlog/2026-09-11-bookmark-anchored-d1-reads.md`) rather than only prose. |

A correction the performance review supplied, worth carrying into the PR narrative:
**`GET /api/projects` was never double-mounted.** `crudRoutes` is composed into `projectsRoutes`
via `projectsRoutes.route('/', crudRoutes)`, so auth already ran once there. Change B benefits
the separately-mounted sub-routers (`/tasks`, `/sessions`, `/library`, …), not `/api/projects`.

## Follow-ups raised by review (not in this PR)

- **`GET /api/projects/:id/sessions/:sid` is a fully sequential six-step chain** and remains
  ~2x over rule 60's read-GET budget even after this change. `getMessages`, the task-embed
  lookup and `resolveChatAgentState`'s first hop are independent once `session` resolves.
  Highest-latency route measured (2793 ms p50 / 5060 ms max).
- **`enrichSessionsWithCreators` re-fetches the caller's own profile** from D1 when they authored
  the session, although `c.get('auth').user` already holds it.
- Bookmark-anchored reads — `tasks/backlog/2026-09-11-bookmark-anchored-d1-reads.md`.

## Discrimination proofs (rule 62)

| Reverted | Tests that went red | Controls that stayed green |
|---|---|---|
| `requireAuth` / `requireApproved` memoisation | 4 in `auth-single-pass.test.ts` (both once-per-request cases, cross-request reset, approval re-read) | PREMISE, single-registration, 401 unauthenticated, 403 suspended |
| `resolveD1BindingIdentity` in `platform-config-core` | 2 in `platform-config-cache.test.ts` (facade cache hit, facade/raw shared entry) | the other 20, incl. cold-isolate 14-query budget |

The warn-once log for an unrecognised `D1_SESSION_MODE` is covered by two tests in
`d1-session.test.ts` with a liveness assertion beside the absence case (the "does not warn"
test ends by forcing a warn, so a mis-wired spy cannot make it pass).

## Acceptance criteria

1. `read_replication.mode` is `auto` on `sam-staging`, `sam-observability-staging`,
   `sam-prod`, `sam-observability-prod`, applied by the deploy pipeline, idempotently,
   on clean install and upgrade.
2. Every request served by the Worker `fetch` handler uses exactly one D1 session per
   database, anchored `first-primary`; `scheduled()` and Durable Objects are unchanged.
3. A request that writes and then reads sees its own write (proved on workerd).
4. `resolvePlatformConfig` still serves its per-isolate cache across requests when the
   binding is session-wrapped (proved, and proved to fail without the fix).
5. `requireAuth()` + `requireApproved()` perform exactly one session resolution and one
   signup-approval read per request, on a route with two registrations.
6. Unauthenticated requests to project sub-routes are still rejected; authenticated
   owners still succeed (proved through the real app).
7. Measured staging p50 improves materially on `/api/projects/:id/tasks`,
   `/api/projects/:id/sessions`, `/api/projects/:id/sessions/:sid`, `/api/projects` and
   `/api/auth/me`, with before/after captured by the same method.

## Follow-up (not in this PR)

Bookmark-anchored reads would remove the last primary round trip (~140 ms) from every
request, at the cost of a bounded cross-actor staleness window on read-only endpoints.
That is a product decision; raise it with the measured after-numbers.

## References

- `.claude/rules/02` (quality gates, account-denial gates), `.claude/rules/13` (staging),
  `.claude/rules/28` (owner-path controls, real SQL engine), `.claude/rules/31`
  (migration/data safety), `.claude/rules/34` (callback-route auth ordering),
  `.claude/rules/44` (enumerate every path), `.claude/rules/58`/`66` (reapers/resumers),
  `.claude/rules/59`/`60` (understand before adding; I/O budgets), `.claude/rules/62`
  (real trigger), `.claude/rules/69` (harness-ceiling divergence), `.claude/rules/70`
  (verify the deployed value).
- Cloudflare: D1 read replication + Sessions API.
