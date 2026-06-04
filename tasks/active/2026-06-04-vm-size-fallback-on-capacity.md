# VM Size Fallback on Transient Capacity Exhaustion

## Problem

When a task auto-provisions a brand-new node and the provider has no capacity for
the requested VM size, provisioning fails and the task dies — even when the task
had **no explicit size requirement** and would have been perfectly happy on a
smaller machine.

We want: when auto-provisioning fails due to **transient capacity exhaustion**,
drop to the next-smaller VM size and retry, descending to the smallest size —
**but only when the size was not explicitly requested.**

## Non-Negotiable Behavioral Spec

Size-fallback is gated entirely on whether the size requirement is explicit:

- **Explicit size** (user's agent profile / trigger / task body specified a size):
  the task runs ONLY on that size. If capacity is exhausted, it fails with a
  clear message like *"There were no large machines available"*. **Never silently
  downgrade an explicit size.**
- **Default-derived size** (the size came from the project default or platform
  default — i.e. nobody asked for a specific size): there is no size requirement,
  so descend the chain from the resolved default down to the smallest, trying each
  in turn.

The gating signal already exists: `TaskRunConfig.vmSizeSource`
(`apps/api/src/durable-objects/task-runner/types.ts:92`). It is one of
`'task' | 'trigger' | 'agent-profile' | 'project' | 'platform' | 'explicit'`.

> **Fallback allowed iff `vmSizeSource ∈ {'project', 'platform'}`.**
> Everything else (`'task'`, `'trigger'`, `'agent-profile'`, `'explicit'`) is an
> explicit requirement → no downgrade.

## Confirmed Design Decisions (from user)

1. **Failed-attempt node records: DELETE them.** Do not leave `status:'error'`
   rows behind for each failed size. Delete the node record before trying the
   next size.
2. **Ordering: retry in place per size, THEN drop a size.** `createVM` already
   burns its full in-place capacity-retry budget (~5 min, exponential backoff)
   for a given size/location before returning `transient_capacity`. Size-fallback
   is the *next* lever after that budget is exhausted.
3. **Existing/warm node selection is NOT affected.** This descent logic ONLY runs
   when we have to provision a brand-new node. If `node-selector.ts` finds an
   existing node that fits the scheduling parameters and is the right size, that
   path is untouched.
4. **Surface the downgrade to the user.** When a smaller-than-requested node is
   provisioned, show an annotation in the provisioning panel at the top of project
   chat (`ProvisioningIndicator.tsx`) so the user knows e.g. a *small* node was
   provisioned instead of the default *medium*.

## Prerequisite Work — ALREADY SHIPPED (PR #1209, commit 36dcaa9e)

The provider-capacity-error-normalization task is merged and archived
(`tasks/archive/2026-06-04-provider-capacity-error-normalization.md`). These
primitives now exist and this feature builds directly on them:

- `ProviderError.category: ProviderErrorCategory` and `ProviderError.providerCode`
  (`packages/providers/src/types.ts`).
- `ProviderErrorCategory = 'transient_capacity' | 'quota_exceeded' |
  'invalid_config' | 'rate_limited' | 'auth_error' | 'unknown'`.
- Exported `classifyHetznerError`, `classifyScalewayError`, `classifyGcpError`,
  `isTransientCapacityError(err)` from `packages/providers/src/index.ts`.
- Time-bounded in-place capacity retry inside `createVM` (budget 300_000ms, max
  10 attempts, 15s→120s exponential backoff). `createVM` **re-throws the original
  `ProviderError` (with `category`)** after exhausting that budget.

## Architecture Decision

The descent loop belongs in the **TaskRunner DO scheduling layer**
(`apps/api/src/durable-objects/task-runner/node-steps.ts`), NOT inside
`HetznerProvider.createVM()` (provider interfaces stay clean and the loop is
cross-provider) and NOT swallowed inside `provisionNode`.

### Key prerequisite refactor in this PR

`apps/api/src/services/nodes.ts:provisionNode()` currently **swallows** the
provider error — its catch block (~line 234) sets `status:'error'` +
`errorMessage` and returns, losing `category` to the caller (it has `err` locally
at line ~240 but never surfaces the category up). This must change:

- `provisionNode` must **re-throw a typed error carrying `category` and
  `providerCode`** so the DO descent loop can branch:
  `transient_capacity` → descend; any other category → fail fast.
- On a capacity failure, `provisionNode` (or the DO loop) must **delete** the
  failed node record (decision #1) rather than leaving an `error` row.

## Implementation Checklist

### 1. Shared helper — fallback chain
- [ ] Add `vmSizeFallbackChain(start: VMSize): VMSize[]` to
  `packages/shared/src/constants/vm-sizes.ts`. Returns the descending slice of
  `['large', 'medium', 'small']` starting at `start` down to `small`
  (e.g. `'medium'` → `['medium', 'small']`; `'small'` → `['small']`;
  `'large'` → `['large','medium','small']`).
- [ ] Unit test the helper for all three starting sizes.

### 2. provisionNode re-throws typed capacity error
- [ ] In `apps/api/src/services/nodes.ts`, change `provisionNode`'s catch so that
  when the failure is a `ProviderError`, it re-throws an error that preserves
  `category` and `providerCode` (re-throw the `ProviderError` itself, or wrap in a
  small typed error the DO can read).
- [ ] On a `transient_capacity` failure, delete the failed node record before
  throwing (decision #1) — no orphaned `error` rows.
- [ ] Preserve current behavior for non-capacity failures except that the error is
  now propagated to the caller (the DO) instead of silently returning a
  `status:'error'` node. Confirm no other caller of `provisionNode` regresses
  (grep callers).

### 3. Descent loop in the DO
- [ ] In `apps/api/src/durable-objects/task-runner/node-steps.ts`
  `handleNodeProvisioning` (~L206), compute:
  ```ts
  const fallbackAllowed =
    (state.config.vmSizeSource === 'project' || state.config.vmSizeSource === 'platform')
    && CAPACITY_SIZE_FALLBACK_ENABLED;
  const chain = fallbackAllowed
    ? vmSizeFallbackChain(state.config.vmSize)
    : [state.config.vmSize];
  ```
- [ ] Loop over `chain`: for each `size`, `createNodeRecord({ vmSize: size, ... })`
  then `provisionNode(...)`.
  - On success: update `state.config.vmSize` to the size that succeeded, record
    which size was provisioned (for surfacing), advance to the next step.
  - On `transient_capacity` AND not the last size: log a `size_fallback` activity
    event, continue to the next (smaller) size. (Failed record already deleted in
    step 2.)
  - On `transient_capacity` AND last size: terminal error. Message:
    - explicit path (chain length 1): *"There were no `<size>` machines available."*
    - default path (chain exhausted): *"No capacity for any available VM size
      (tried `<sizes>`)."*
  - On ANY other category (`invalid_config`, `quota_exceeded`, `auth_error`,
    `rate_limited`, `unknown`): **fail fast** — do not descend.

### 4. Config knob (Constitution Principle XI)
- [ ] Add `CAPACITY_SIZE_FALLBACK_ENABLED` env knob (default **true**). Wire through
  the DO config the same way other knobs are. Document in env-reference.

### 5. Surface the downgrade in the UI (decision #4)
- [ ] Persist the provisioned size when it differs from the requested/default size.
  The polled task status object (`apps/web/src/lib/api/sessions.ts`, the task
  shape with `executionStep` / `errorMessage` / `outputBranch`) should gain a
  field such as `provisionedVmSize` (and/or `requestedVmSize`) returned by the
  task status endpoint.
- [ ] Thread it into `ProvisioningState`
  (`apps/web/src/pages/project-chat/types.ts`) and populate it in
  `useProjectChatState.ts` where the other task fields are mapped (~L406, ~L447).
- [ ] In `ProvisioningIndicator.tsx`, render an annotation when
  `provisionedVmSize` is smaller than the requested/default size, e.g.
  *"No medium machines were available — provisioned a small node instead."*
  Style consistent with the existing caption rows; works at 375px and 1280px.

## Acceptance Criteria

- [ ] Default-derived size (`vmSizeSource` = `project`/`platform`): a
  `transient_capacity` failure at the default size auto-provisions the next-smaller
  size; descends to `small`; only fails if every size is capacity-exhausted.
- [ ] Explicit size (`vmSizeSource` = `task`/`trigger`/`agent-profile`/`explicit`):
  capacity exhaustion fails immediately with *"There were no `<size>` machines
  available"* — NO downgrade attempted.
- [ ] Non-capacity provider errors (`invalid_config`, `quota_exceeded`,
  `auth_error`, etc.) fail fast with no descent, regardless of `vmSizeSource`.
- [ ] Failed-size node records are deleted, not left as `status:'error'`.
- [ ] `createVM`'s in-place retry budget per size/location is exhausted before any
  size drop (composition, not replacement).
- [ ] Existing/warm node selection (`node-selector.ts`) is unchanged — this logic
  only runs when provisioning a brand-new node.
- [ ] When a smaller node is provisioned, the provisioning panel at the top of
  project chat shows a clear annotation of the actual size provisioned.
- [ ] `CAPACITY_SIZE_FALLBACK_ENABLED=false` restores single-attempt behavior.

## Tests (vertical-slice per rule 35; capability per rule 10)

- [ ] `vmSizeFallbackChain` unit tests (all three starting sizes).
- [ ] DO slice: project-default `medium`, `createVM` throws `transient_capacity`
  for medium then succeeds for small → node provisioned at `small`,
  `state.config.vmSize` updated, `size_fallback` event recorded, provisionedVmSize
  surfaced.
- [ ] DO slice: explicit `agent-profile` `large`, `transient_capacity` → task fails
  with the explicit message, no second `createVM` call, no smaller record created.
- [ ] DO slice: `invalid_config` at the default size → fail fast, no descent.
- [ ] DO slice: `quota_exceeded` → fail fast, no descent.
- [ ] DO slice: project-default `large`, all of `large/medium/small` throw
  `transient_capacity` → terminal "exhausted all sizes" error; assert each failed
  record was deleted.
- [ ] `provisionNode` re-throw: capacity failure propagates `category` to caller
  and deletes the failed node row; non-capacity failure still propagates.
- [ ] Surfacing: task status response includes the provisioned size when downgraded;
  `ProvisioningIndicator` renders the annotation (behavioral render test, mobile +
  desktop overflow assertion per rule 17).

## References

- `tasks/archive/2026-06-04-provider-capacity-error-normalization.md` — shipped
  primitives this builds on.
- `apps/api/src/durable-objects/task-runner/node-steps.ts` — `handleNodeProvisioning`.
- `apps/api/src/durable-objects/task-runner/types.ts:92` — `vmSizeSource` gate.
- `apps/api/src/services/nodes.ts` — `provisionNode` (re-throw refactor).
- `apps/api/src/services/node-selector.ts` — NOT touched (existing/warm selection).
- `packages/shared/src/constants/vm-sizes.ts` — `canSatisfyVmSize`,
  `DEFAULT_VM_SIZE_VCPUS`, new `vmSizeFallbackChain`.
- `apps/web/src/pages/project-chat/ProvisioningIndicator.tsx` — surfacing target.
- `.claude/rules/03-constitution.md` — Principle XI (no hardcoded values).
- `.claude/rules/10-e2e-verification.md`, `.claude/rules/35-vertical-slice-testing.md`.
