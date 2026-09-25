# Sleeping-session wakes survive Hetzner capacity pressure

SAM task `01M3BQTNR5Q176DV1V5DDNF8EA` · idea `01M236QPGGC6B150FG4QHT17MW` · branch
`sam/sleeping-session-wakes-survive-dnf8ea`

## Problem

On 2026-09-25 03:55–03:56Z three human wakes of the same sleeping conversation (chat
`c0eda1ee`) failed permanently with `hetzner API error (403): shared core limit exceeded`.
The tasks were `01M3BB7KNY7N0480AM6YN0ZSJD`, `01M3BB8BXAHWBYZD94Q5NJD8WN` and
`01M3BB94YSJ9X843M0PJVH3B77`. Two independent defects combined:

1. **The core-quota 403 is unclassified.** Each wake made one attempt (cx53, 16 vCPU) and
   failed fast. cx43, cx33 and cx23 were never tried, and there was no account-capacity wait.
2. **The wake hard-pins the region.** The original run did not ask for a location. The wake
   added `explicitVmLocation=true` (fsn1), which dropped every hel1/nbg1 offering from the
   chain. It also made a healthy hel1 cx53 host (same pool, revision 8, same source, current
   agent version, 17.2% projected utilisation) ineligible, with "Host is outside the current
   pool allocation authority".

## Research findings (re-verified read-only in prod D1 on 2026-09-25, rule 39)

- **Evidence confirmed.** All three tasks carry `error_message = "hetzner API error (403):
  shared core limit exceeded"`. Their node rows (`01M3BB7W…`, `01M3BB8M…`, `01M3BB9D…`) are
  cx53/fsn1, `provider_instance_id` NULL, and still `destroying` at 07:39Z. Node
  `01M3BB7WG1…` has `explicitVmLocation: true`, requested 400m/820 MB, hosts cx43 hel1
  (rejected: agent version) and cx53 hel1 (rejected: authority), and attempts cx53 then
  cx43/cx33/cx23 `not-attempted`.
- **The user pool has 12 active workspace offerings.** These are cx23/33/43/53 in each of
  fsn1, hel1 and nbg1, under `exhaustion_policy = fallback-chain` and strategy `pack`. The pin
  removed 8 of them.
- **The pin is created by the wake, not by the user.**
  - Root task `01M35GKK…` (triggered_by `user`) has `explicitVmLocation = 0`.
  - Both of its recovery tasks (`01M35QAS…`, `01M38Y0Q…`) have `explicitVmLocation = 1`.
  - Over 14 days: 0 root tasks with `explicit = 1`, and 40 recovery tasks with `explicit = 1`.
  - The web UI never sends `vmLocation`. Only API/MCP callers (`tasks/submit`, `tasks/run`,
    `dispatch_task`) can.
- **Chain problem.** `loadRecoveryContext` picks the most recently updated task on the
  session or workspace. After one wake, that is a recovery task whose explanation says
  `explicit = 1` because of the old wake pin. So reusing the eviction path's
  `sourceTaskExplicitLocationRequirement(sourceTask)` would keep the pin alive on every
  existing chain. Intent must be read from the chain root.
- **`explicitVmLocation` has only been recorded since 2026-09-20 (#2108).** Every
  capacity-pool task explanation before that lacks the key. Long-lived conversations can
  therefore have an unknown root intent. With 0 explicit roots observed, "unknown" must mean
  "preference", not "pin".
- **Hetzner docs** (OpenAPI spec `https://docs.hetzner.cloud/cloud.spec.json`, fetched
  2026-09-25):
  - Account quota: `403 resource_limit_exceeded` — "Error when exceeding the maximum
    quantity of a resource for an account." The example body carries
    `details.limits[].name`.
  - `server_limit_exceeded` is **not** a documented code.
  - Production has only ever recorded two 403 limit texts: `server limit reached` (server
    count, 26 node rows / 66 tasks) and `shared core limit exceeded` (3).
- **Recovery actions differ by what the quota counts** (rule 72):
  - Server count: every server needs one, so no offering escapes it → account-capacity wait
    (existing path).
  - vCPU cores: an offering with fewer cores **of the same class** can still fit → descend,
    and wait only when none remains. Hetzner keeps separate shared and dedicated core
    limits. CCX = dedicated vCPU; CX/CPX/CAX = shared.
  - `capacity_pool_candidates.machine_class` is `shared-vm` even for `ccx*`, so the core
    class must come from Hetzner's type naming.
- **Why the 403 was never classified.** `classifyVmProviderCapacityError` matches only
  `server_limit_exceeded` or "server limit". `isTransientCapacityError` consults
  `classifyHetznerError` only for 422/412. `classifyHetznerError` sends an unknown 403 code
  to `auth_error`: a quota classified as an auth failure, which is the rule-72 class.
- **Category is never assigned at construction on Hetzner `createVM`.** `providerFetch`
  leaves `category = 'unknown'`. So in `node-provisioning.ts`,
  `isProviderCreateRejectedBeforeVmIdentity`'s `err.category === 'quota_exceeded'` arm is
  dead in production. That is why the three failed rows were marked `error` and then stuck
  in `destroying`, instead of being deleted as provider-rejected.
  - The existing test "deletes the failed node row on a Hetzner account-limit rejection"
    hand-feeds `category: 'quota_exceeded'`, a shape production never builds (rule 62).
- **Mapping at construction is safe.** Enumerating every createVM-error category consumer
  (rule 67):
  - `isTransientCapacityError`: same answers for 422/412; no change for quota.
  - `isProviderCreateRejectedBeforeVmIdentity`: now fires for quota → row deleted. This is
    intended.
  - `recordVmProviderCapacityFailure`: records a real category.
  - Hetzner's inner same-SKU retry loop runs before the outer mapping, so it is unchanged.
  - Nothing branches on `auth_error` or `rate_limited`.
- **The quota must not become `transient_capacity`.** That would enter Hetzner `createVM`'s
  300 s same-SKU retry loop (`retryAfterCapacityError`), which cannot succeed against a quota.
- **Consumers of the account-capacity classifier.** Only `recordVmProviderCapacityFailure`,
  called from `node-provisioning-step.ts`. `isProviderAccountCapacityError` has no callers.
  It is dead and gets removed.
- **Admission** is `enforce` by default and production doesn't override it. The
  `provider_account_capacity` path is live: `vm_provider_capacity_state` records 12 failures,
  the last on 2026-09-20. The 09-25 core-limit failures were never recorded.
- **Restore is region-independent.**
  - Snapshot artifacts live in R2 (`env.R2`), keyed by session and generation with no
    location (`session-snapshot-artifacts.ts`).
  - The only location-aware snapshot module is the legacy upload relay, which the idea
    showed current agents never reach.
  - Production has never restored across regions, because the pin prevented it. So staging
    must prove it.
- **Where the user sees a failed wake.** `failTask` writes `tasks.error_message`, task status
  events, trigger executions, project-event terminal hooks and
  `session_snapshots.recovery_error`. So legible text belongs in the terminal messages the
  provisioning step throws.
- **Rule 18.** `node-provisioning-step.ts` is 779 lines and `session-recovery.ts` is 799.
  Both must be split, as pure code motion, before adding behaviour.

## Implementation checklist

### Split (pure code motion, separate commits)
- [ ] Split `node-provisioning-step.ts`. Extract the provider-failure handling and the
      crash-recovery adoption into sibling modules, bringing the step under 500 lines.
- [ ] Split `session-recovery.ts`. Extract recovery placement resolution and recovery-task
      creation into sibling modules, bringing it under 500 lines.

### Provider classification (packages/providers)
- [ ] `classifyHetznerError`:
  - `resource_limit_exceeded` → `quota_exceeded`.
  - Add a 403 limit-message fallback before `auth_error`.
  - Document each arm's recovery action.
- [ ] `classifyHetznerAccountLimit(err)` → `{ resource: 'servers' | 'cores' | 'other',
      coreClass }` or null, plus `hetznerServerTypeCoreClass(type)`.
- [ ] Assign the category at construction on `HetznerProvider.createVM`, after the abort
      rethrow. `mapHetznerProviderError` must preserve an already-assigned category and the
      error context.
- [ ] Export the new helpers from `packages/providers/src/index.ts`.

### Control plane (apps/api)
- [ ] `classifyVmProviderCapacityError` delegates to `classifyHetznerAccountLimit` (every
      Hetzner account limit → account capacity). Remove dead `isProviderAccountCapacityError`.
- [ ] Core-quota descent in the provisioning attempt loop:
  - A core-limit failure excludes every remaining attempt of the same core class that needs
    at least as many vCPUs, and records why.
  - The chain continues to the next eligible attempt without recording an account cooldown.
  - With no eligible attempt left, take the account-capacity wait (cooldown + park), or fail
    fast with a legible message when admission is unavailable.
- [ ] Explicitly discard the provider-rejected node row on the core-descent path, as the
      account-capacity path already does.
- [ ] User-legible messages:
  - Diagnostics reason while waiting.
  - Terminal message when the wait expires.
  - Fail-fast message without admission.
  - Name the limit, what to do, and the provider's own text.
- [ ] Wake region affinity:
  - `resolveTaskStartPlacement` accepts `preferredVmLocation`, which ranks without filtering
    and is ignored when invalid for the provider.
  - Recovery placement pins `vmLocation` only when the recovery chain's root task explicitly
    requested it.
  - Otherwise the sleeping workspace's location is only a preference.
  - Applies to human wakes, durable wakes and eviction recovery. Replace
    `sourceTaskExplicitLocationRequirement`.
- [ ] Chain-root lookup is one bounded, project-scoped recursive query. The depth bound is
      configurable (`SESSION_RECOVERY_LINEAGE_MAX_DEPTH`, with a default constant).

### Docs
- [ ] Update the compute-pools/placement docs with wake region behaviour and the core-quota
      descent, citing code.
- [ ] Update the env reference for the new variable.

## Tests (rules 62, 67, 72, 28)
- [ ] Provider:
  - `classifyHetznerError` / `classifyHetznerAccountLimit` arms, including an auth-403
    control and a non-Hetzner control.
  - `createVM` against a stubbed fetch that mints a fresh Response per call. Assert
    `providerCode`, message and category, exactly one POST (no same-SKU retry), and the
    auth-403 control.
- [ ] `provisionNode`: the production-shaped quota 403 (built by the real HetznerProvider)
      deletes the failed row; an auth 403 keeps the `error` row.
- [ ] Action layer (real `handleNodeProvisioning`):
  - cx53 → 403 core → cx43 → 403 core → cx33 succeeds, with no cooldown.
  - Size-major order skips the same-size other-region offering.
  - The smallest offering fails → account wait (real classifier, cooldown written).
  - Server limit → wait with no descent.
  - Auth 403 → fails fast.
  - Wait expiry and no-admission → legible messages.
- [ ] Wake:
  - Root not explicit → relaxed plus preferred location.
  - Old-code recovery source with `explicit = 1` but a non-explicit root → relaxed (real SQL).
  - Explicit root → pinned.
  - Unknown root → relaxed.
  - Eviction follows the same rule.
- [ ] Wake vertical slice: real placement resolution plus real reusable-node selection. An
      other-region host with capacity is reused; the old explicit pin is the control that
      rejects it.
- [ ] Surgical reverts: each guard reverted once, and the intended tests go red.

## Acceptance criteria
- [ ] A Hetzner core-quota 403 on an offering descends to a permitted offering with fewer
      cores. It never fails the wake permanently while a smaller offering remains.
- [ ] When no permitted offering fits under the quota, the task waits on
      `provider_account_capacity` instead of failing. A genuine auth 403 still fails fast.
- [ ] A wake reuses a healthy other-region host with capacity. The original region only
      ranks candidates, unless the root run explicitly asked for that location.
- [ ] Exhausted capacity surfaces a user-legible message, not the raw provider string alone.
- [ ] Staging (rule 22): a real wake that provisions a VM completes. A sleeping session wakes
      onto a host in a different region with its files intact. All created
      nodes/workspaces are deleted.

## References
- Rules: `apps/api/.claude/rules/72`, `67`, `69`; `.claude/rules/62`, `22`, `74`, `18`, `28`
- Prior incident: `tasks/archive/2026-09-09-hetzner-412-placement-blocks-fallback-chain.md`
- Idea `01M236QPGGC6B150FG4QHT17MW` (items 2 and the 2026-09-25 recurrence; items 1, 3–8
  remain open)
