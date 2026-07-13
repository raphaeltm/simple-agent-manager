# Fix production VM provisioning failures: Hetzner 422 capacity misclassification + immediate fail

**Status:** active
**Branch:** `fix/hetzner-422-capacity-classification-and-retry`
**Authorized:** Raphaël — go straight to prod, SKIP staging verification (staging must stay stable, hard to test there). Strong LOCAL verification instead.

## Problem

Production VM provisioning fails **immediately** with
`hetzner API error (422): unsupported location for server type`. Confirmed via
live prod `wrangler tail` (task `01KXDXD97JG7198RN1EPNA63SV`, large@nbg1, 2026-07-13 14:17)
and prod observability DB (`platform_errors`): 6+ failures in ~25 min across
medium & large, nbg1 & fsn1, all `statusCode: 422`.

This 422 is **real transient capacity** (nbg1/fsn1 are valid Hetzner locations that
normally provision fine; it resolves after a few minutes). Hetzner just overloads
the "unsupported location for server type" message for a server-type stock-out.

### Root cause (evidence-backed)

1. **Misclassification.** `classifyHetznerError()` (`packages/providers/src/hetzner.ts:114`)
   checks the `providerCode` switch (line 120) **before** the 422 transient-capacity
   message-pattern fallback (line 143). Hetzner returns this 422 with an `error.code`
   (extracted at `provider-fetch.ts:55`) that maps to `invalid_config` (almost certainly
   `invalid_input`), so it short-circuits and returns `invalid_config`. The
   `/unsupported location for server type/i` pattern added in PR #1209 (`hetzner.ts:94`)
   is **dead code** — it never runs for the real error.
   - Behavioral proof from the tail: `node_provisioning` logged `chainLength=3` but
     stopped at `attempt=1` (no size descent), NO `hetzner transient capacity error;
     retrying createVM` line (provider capacity loop never engaged), `step_error`
     `retryCount:0`, then immediate `task_failed`. All three prove
     `isTransientCapacityError()` returned false.

2. **`providerCode` is not logged anywhere on the failure path** (`node_provisioning.failed`
   at `nodes.ts:337` and DO `step_error` carry `statusCode`/`message` only), so the exact
   Hetzner `error.code` can't be read from logs — the misclassification was diagnosed
   purely behaviorally.

3. **Immediate fail, no minute-scale retry.** Even for correctly-classified
   `transient_capacity`, terminal capacity exhaustion throws `{ permanent: true }`
   (`node-steps.ts:354`), which `isTransientError()` (`helpers.ts:35`) treats as
   non-retryable, so the DO backoff loop (`index.ts:225`) is skipped. There is no
   minute-scale "wait and retry" — which is the behavior Raphaël expects (capacity
   usually recovers in a few minutes).

### Incidental bugs found in the same prod trace

- **A — task_title 400 (DESCOPED to backlog):** `task_title.all_retries_exhausted` —
  Workers AI Gateway returns HTTP 400 on model `@cf/zai-org/glm-5.2`
  (`DEFAULT_TASK_TITLE_MODEL`, `packages/shared/src/constants/ai-services.ts:6`). The
  model **exists** in the Workers AI catalog (verified via CF API), so the 400 is a
  **request-parameter** incompatibility (likely `chat_template_kwargs`/`reasoning_effort`),
  not a bad model id. Fixing it safely requires live AI-Gateway iteration, which we can't
  do without staging/prod experimentation. Per rule 30 (don't ship unverifiable guesses),
  this is tracked in `tasks/backlog/2026-07-13-task-title-glm-5.2-http-400.md` instead of
  blind-fixed here. Feature degrades gracefully (falls back to truncation).
- **B — DO observability write to nonexistent table:** `task_runner_do.observability_write_failed`
  `no such table: errors`. `state-machine.ts:247` does a raw `INSERT INTO errors (...)`
  but the observability table is `platform_errors`. It also binds an ISO-string `now`
  into the INTEGER `timestamp` column. Every DO-level failed-task observability write is
  silently lost. There is already a correct, fail-silent `persistError()` service
  (`apps/api/src/services/observability.ts:79`) that writes `platform_errors` via drizzle.

## Implementation checklist

### Part 1 — classification fix + diagnostics (critical unblocker)
- [ ] `classifyHetznerError()`: run the 422 transient-capacity message-pattern check
      BEFORE returning a non-capacity category from the `providerCode` switch, so a 422
      whose message matches `TRANSIENT_CAPACITY_PATTERNS` is classified `transient_capacity`
      even when `providerCode` maps to `invalid_config`. Keep genuinely-permanent codes
      (auth/quota/true invalid_config without a capacity message) unchanged.
- [ ] `isTransientCapacityError()`: ensure it also returns true for a 422 whose message
      matches the capacity patterns regardless of a non-`unknown` non-capacity category
      (defense-in-depth; the fallback currently only runs when `category === 'unknown'`).
- [ ] Add `providerCode` to the `node_provisioning.failed` log (`nodes.ts:337`) and to the
      DO `task_runner_do.step_error` context (`index.ts:217`) — capture it from
      `ProviderError.providerCode` when available.
- [ ] Discriminating test: 422 + `providerCode:'invalid_input'` + message
      "hetzner API error (422): unsupported location for server type" ⇒ `transient_capacity`.
      MUST fail on current code.

### Part 2 — bounded minute-scale capacity backoff-retry (behavior Raphaël wants)
- [ ] Add `DEFAULT_PROVISION_CAPACITY_MAX_RETRIES`, `DEFAULT_PROVISION_CAPACITY_RETRY_BASE_DELAY_MS`,
      `DEFAULT_PROVISION_CAPACITY_RETRY_MAX_DELAY_MS` (+ `PROVISION_CAPACITY_*` env overrides)
      in `packages/shared/src/constants/task-execution.ts`. Bounded per rule 47.
- [ ] Add `capacityRetryCount: number` to `TaskRunnerState` (default 0; normalized in `getState`).
- [ ] In `handleNodeProvisioning`, when capacity is exhausted at the last size in the chain
      (`node-steps.ts:349-354`): instead of throwing `{ permanent: true }`, if
      `capacityRetryCount < max` AND within the overall provisioning wall-clock budget
      (`getProvisionTimeoutMs()` from `provisioningStartedAt`), increment `capacityRetryCount`,
      persist state, `setAlarm(now + computeBackoffMs(capacityRetryCount, base, max))`, and
      RETURN (re-enters provisioning after the delay, rebuilds the size chain). When retries
      or budget are exhausted ⇒ throw `{ permanent: true }` with the terminal capacity message
      (escape path per rule 47).
- [ ] Keep non-capacity provider failures failing fast (unchanged `node-steps.ts:331`).
- [ ] Tests (rule 47): (a) permanent-capacity candidate is retried a bounded number of times
      then fails terminally; (b) capacity that clears on attempt N succeeds; (c) the alarm
      backoff is scheduled (not a tight await loop); (d) non-capacity error still fails fast;
      (e) a two-pass test proving retries are bounded (no infinite re-selection).

### Incidental B — DO observability write
- [ ] Replace the raw `INSERT INTO errors (...)` in `state-machine.ts:246-263` with a call to
      the existing `persistError()` service against `rc.env.OBSERVABILITY_DATABASE` (correct
      `platform_errors` table, integer timestamp, fail-silent). Remove the now-dead raw SQL +
      `ulid` import if unused.
- [ ] Test: failed-task path invokes `persistError` with the expected shape (taskId, step,
      userId, nodeId, workspaceId in context); a stubbed OBSERVABILITY_DATABASE receives a
      `platform_errors` insert, not `errors`.

### Incidental A — descoped
- [ ] Create `tasks/backlog/2026-07-13-task-title-glm-5.2-http-400.md` with the finding and
      the constraint that it needs live AI-Gateway verification.

## Acceptance criteria
- [ ] `classifyHetznerError(422, 'invalid_input', '...unsupported location for server type')` ⇒ `transient_capacity` (test, fails on old code).
- [ ] `isTransientCapacityError` returns true for that error object.
- [ ] `providerCode` appears in `node_provisioning.failed` + DO `step_error` logs.
- [ ] Capacity exhaustion triggers a bounded, minute-scale, alarm-driven DO retry; exhausting the budget fails terminally with a clear message.
- [ ] Non-capacity provider errors (auth/quota/genuine invalid_config) still fail fast.
- [ ] DO failed-task observability writes land in `platform_errors` (no `no such table: errors`).
- [ ] `pnpm lint && pnpm typecheck && pnpm test` green for `providers`, `api`, `shared`.

## Verification (LOCAL — staging skipped per Raphaël)
- Unit tests for classification (providers).
- Vertical-slice / behavioral tests for the DO capacity-retry state machine and the
  observability write (api), per rules 35 & 47.
- No staging deploy. Post-merge: monitor prod deploy; re-check prod `platform_errors` /
  a fresh provision attempt for the corrected behavior.

## References
- `.claude/rules/47-control-loop-io-budget.md` (bounded retry, escape path)
- `.claude/rules/35-vertical-slice-testing.md`, `.claude/rules/28-*` (behavioral tests)
- `.claude/rules/30-never-ship-broken-features.md` (incidental A descope rationale)
- PRs #1209 (error normalization + dead pattern), #1210 (size fallback + permanent throw)
