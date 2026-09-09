# Hetzner 412 placement errors are misclassified as non-capacity, blocking the fallback chain

**Status**: active
**Created**: 2026-09-09
**Priority**: URGENT (production hotfix)

## Problem

A user wake of chat session `516141ed-c425-4d1a-b5ad-e0f29c6ff0e1` failed three times in
production. The user's compute pool had `exhaustionPolicy = fallback-chain` and four eligible
offerings, but SAM only ever tried the first one.

Production evidence (prod D1 `sam-prod`, read-only):

| Task | Error | Node |
| --- | --- | --- |
| `01M232PGCM4Q25TRJPNB3NX01A` | `hetzner API error (412): error during placement` | `01M232PSJRVRY89J443X76MHWE` |
| `01M232Q6H5GTYAFGPZYK1DYRV3` | `hetzner API error (412): error during placement` | `01M232QFBM30FY3KDNKBJPCKTA` |
| `01M232QYT0S7WZGSH0KEH95ZPF` | `hetzner API error (412): error during placement` | `01M232R7Q4JW0MAT5DGMQN772F` |

`tasks.placement_explanation_json` on all three records the chain that was built and never walked:

```
attempts: [
  { order: 1, providerInstanceType: "cx53", outcome: "failed", reason: "Provider allocation failed" },
  { order: 2, providerInstanceType: "cx43", outcome: "not-attempted" },
  { order: 3, providerInstanceType: "cx33", outcome: "not-attempted" },
  { order: 4, providerInstanceType: "cx23", outcome: "not-attempted" }
]
```

`session_snapshots.recovery_attempts` for that session is now `3`
(`DEFAULT_SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS`), so the session's entire wake budget was spent
on three identical single-attempt runs. The "tried three times" the user saw was the wake budget,
not the fallback chain.

`platform_errors` confirms `statusCode: 412` on every one.

## Root cause

`classifyHetznerError` (`packages/providers/src/hetzner-metadata.ts`) maps Hetzner's
`placement_error` to `invalid_config`. Nothing about the request is invalid — a Hetzner 412
"error during placement" means Hetzner cannot currently place that server type in that location,
which is precisely transient capacity scarcity.

`node-provisioning-step.ts` then takes its explicit fail-fast branch:

```ts
const isCapacityFailure = err instanceof ProviderError && isTransientCapacityError(err);
// Any non-capacity provider failure fails fast — never descend on
// invalid_config / quota_exceeded / auth_error / rate_limited / unknown.
if (!isCapacityFailure) { ...; throw Object.assign(new Error(message), { permanent: true }); }
```

So attempt 1 terminalized the task and attempts 2-4 were never made.

### The second half of the bug (why fixing the classifier alone is not enough)

`providerFetch` constructs its `ProviderError` with `{ providerCode }` and **no `category`**, so
`ProviderError.category` defaults to `'unknown'` on every HTTP error from the create path.
`isTransientCapacityError` only consults the classifier as a fallback when
`err.statusCode === 422 && err.category === 'unknown'`:

```ts
export function isTransientCapacityError(err: ProviderError): boolean {
  if (err.category === 'transient_capacity') return true;
  if (err.statusCode === 422 && err.category === 'unknown') {
    return classifyHetznerError(...) === 'transient_capacity';
  }
  return false;
}
```

A 412 never reaches the classifier. Changing `classifyHetznerError` alone would make a unit test
go green while production stayed broken — exactly the `.claude/rules/62` trap. Both functions must
change, and the regression test must drive the real `providerFetch`-shaped error
(`category: 'unknown'`), not a hand-built error with `category` pre-set.

## Shared-predicate caller inventory (`.claude/rules/67`)

`isTransientCapacityError` has five production callers. Impact of 412 becoming capacity:

| # | Call site | Effect | Verdict |
| --- | --- | --- | --- |
| 1 | `hetzner.ts:188` `retryAfterCapacityError` | Would newly retry the same SKU for up to `DEFAULT_CAPACITY_RETRY_BUDGET_MS` (300 s) before returning | **Not wanted** — explicitly excluded, see below |
| 2 | `node-provisioning.ts:443` `providerAllocationRejected` | None — already `(statusCode === 412 \|\| isTransientCapacityError(err))` | No change |
| 3 | `node-provisioning.ts:661` | Failed node row is DELETED instead of left `status='error'` | **Desired.** Safe because #2 already proves Hetzner rejected the allocation, so no paid resource is orphaned. Fixes the stray `error` rows seen in prod (`01M2332BQAT29TV0VWT5NSG25A`) |
| 4 | `node-provisioning-step.ts:592` | Diagnostic outcome becomes `capacity-exhausted` instead of `failed` | **Desired** — accurate operator diagnostics |
| 5 | `node-provisioning-step.ts:665` | Descends the fallback chain instead of terminalizing | **This is the fix** |

Deliberately NOT affected: `classifyVmProviderCapacityError`
(`services/vm-admission-provider-capacity.ts`) is scoped to Hetzner **403 `server_limit_exceeded`**
only, so a 412 cannot trip the account-wide provider cooldown or park the task on the admission
queue. Verified by reading the predicate.

### A sixth consumer, reached through `mapHetznerProviderError`

The table above covers `isTransientCapacityError`. `classifyHetznerError` has one further consumer
that the first pass of this inventory missed: `mapHetznerProviderError`
(`hetzner-metadata.ts`), called by `createVolume` (`hetzner.ts`) on any thrown `ProviderError`.
So a Hetzner 412 raised during VOLUME creation would now be categorised `transient_capacity` if its
code is `placement_error` or its message matches `/placement/i`.

Practical impact today is nil — `category === 'transient_capacity'` has no consumer on the volume
path, and nothing in `apps/api` calls `isTransientCapacityError` on a volume error. Recorded here
because rule 72 requires the enumeration to be complete rather than convenient, and because a
future volume-retry feature would inherit this silently. `attachVolume` / `detachVolume` /
`resizeVolume` do not call `mapHetznerProviderError` and are unaffected.

### Caller #1 must be narrowed, not widened

`retryAfterCapacityError` drives the provider's own 5-minute same-SKU backoff loop. A placement
error means *this exact server_type in this exact location cannot be placed*; the pool already
holds other offerings and the control plane owns that decision — the file's own comment says
"Cross-location fallback must be a new control-plane placement decision." Letting a placement error
into that loop would cost up to 300 s per rung of the chain.

Per `.claude/rules/67`, this is composed as a **new named predicate**
(`isHetznerPlacementCapacityError`) that narrows the trigger, rather than reusing the widened
classifier there. Today a 412 gets zero outer-loop wait, so this is strictly no worse than current
behaviour.

## Implementation checklist

- [x] `classifyHetznerError`: map `placement_error` to `transient_capacity` (move it out of the
      `invalid_config` group), and classify a 412 with an unrecognized/absent code by placement
      message pattern.
- [x] Add `PLACEMENT_CAPACITY_PATTERNS` alongside the existing pattern constants (unprefixed, matching `TRANSIENT_CAPACITY_PATTERNS` / `INVALID_INPUT_CAPACITY_PATTERNS` in the same file).
- [x] `isTransientCapacityError`: extend the category-`unknown` fallback to `412` as well as `422`,
      with a comment explaining that `providerFetch` never assigns a category. Keep the fallback
      narrowed to those two status codes for this hotfix.
- [x] Add exported `isHetznerPlacementCapacityError` and use it in `retryAfterCapacityError` to
      exclude placement errors from the provider's 300 s same-SKU backoff loop.
- [x] Update `packages/providers/tests/unit/error-classification.test.ts:45`, which currently
      pins the buggy `412 placement_error -> invalid_config` mapping.
- [x] Regression test at production fidelity: a `ProviderError` built the way `providerFetch`
      builds it (no `category`), asserted through `isTransientCapacityError`.
- [x] Regression test for the descent itself: attempt 1 returns the 412, assert attempt 2 is
      reached with the next offering.
- [x] Discriminating control: a genuinely non-capacity provider failure (e.g. `auth_error`) still
      fails fast and does NOT descend.
- [x] Control: `retryAfterCapacityError` still retries a real 422 capacity error, and does NOT
      retry a placement error.
- [x] Process fix: new `.claude/rules/72-error-categories-must-match-the-recovery-action.md`.

## Acceptance criteria

- [x] A Hetzner 412 placement error is classified `transient_capacity`.
- [x] `isTransientCapacityError` returns `true` for a production-shaped 412 whose `category` is
      `'unknown'`. This test must FAIL against pre-fix code.
- [x] The provisioning loop descends from cx53 to cx43 on a 412 instead of terminalizing.
- [x] A non-capacity error still fails fast (proven by a control test that stays green).
- [x] A placement error does not enter the provider's 300 s same-SKU capacity retry loop.
- [x] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` green.
- [ ] Staging deploy green; no regression in dashboard/projects/settings.
- [x] Process-fix rule added.

## Explicitly out of scope (follow-up PR, user's instruction)

Both are tracked in idea `01M236QPGGC6B150FG4QHT17MW`, together with two further findings raised
during review of this PR: GCP's `classifyGcpError` is dead code (so GCP has this exact
fallback-chain bug, unfixed), and `ProviderErrorCategory` should be assigned at construction so the
`{422, 412}` status allowlist in `isTransientCapacityError` can be removed entirely.

1. **Pool-revision node reuse.** `buildPlacementAuthoritySqlPredicate` requires
   `nodes.capacity_pool_revision = <current revision>`, so any pool edit bumps the revision and
   instantly makes every existing node non-reusable. The healthy cx23 node
   `01M22S8MMJYDTJ91J5VP0JYVD5` (rev 5) was rejected as "Host is outside the current pool
   allocation authority" against rev 6. User's stated intent: a node stays reusable unless it is
   fundamentally incompatible with the pool.
2. **Wake region pinning.** `session-recovery.ts` sets `explicit.vmLocation =
   context.workspace.vmLocation`, hard-pinning the chain to the sleeping workspace's old region, so
   8 of the user's 12 allowed offerings (hel1, nbg1) were never eligible. User's stated intent: pin
   the resources resolved at launch, never the region or machine type.

## References

- `.claude/rules/67-shared-predicates-that-trigger-actions.md` — caller inventory duty
- `.claude/rules/62-tests-must-observe-the-real-trigger.md` — build the error from its real producer
- `.claude/rules/02-quality-gates.md` — regression + post-mortem + process fix
- `.claude/rules/47-control-loop-io-budget.md` — every candidate needs an escape path
