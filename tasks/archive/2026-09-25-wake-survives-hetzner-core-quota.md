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

- [x] Split `node-provisioning-step.ts`. Extract the provider-failure handling and the
      crash-recovery adoption into sibling modules, bringing the step under 500 lines.
- [x] Split `session-recovery.ts`. Extract recovery placement resolution and recovery-task
      creation into sibling modules, bringing it under 500 lines.

### Provider classification (packages/providers)

- [x] `classifyHetznerError`:
  - `resource_limit_exceeded` → `quota_exceeded`.
  - Add a 403 limit-message fallback before `auth_error`.
  - Document each arm's recovery action.
- [x] `classifyHetznerAccountLimit(err)` → `{ resource: 'servers' | 'cores' | 'other',
    coreClass }` or null, plus `hetznerServerTypeCoreClass(type)`.
- [x] Assign the category at construction on `HetznerProvider.createVM`, after the abort
      rethrow. `mapHetznerProviderError` must preserve an already-assigned category and the
      error context.
- [x] Export the new helpers from `packages/providers/src/index.ts`.

### Control plane (apps/api)

- [x] `classifyVmProviderCapacityError` delegates to `classifyHetznerAccountLimit` (every
      Hetzner account limit → account capacity). Remove dead `isProviderAccountCapacityError`.
- [x] Core-quota descent in the provisioning attempt loop:
  - A core-limit failure excludes every remaining attempt of the same core class that needs
    at least as many vCPUs, and records why.
  - The chain continues to the next eligible attempt without recording an account cooldown.
  - With no eligible attempt left, take the account-capacity wait (cooldown + park), or fail
    fast with a legible message when admission is unavailable.
- [x] Explicitly discard the provider-rejected node row on the core-descent path, as the
      account-capacity path already does.
- [x] User-legible messages:
  - Diagnostics reason while waiting.
  - Terminal message when the wait expires.
  - Fail-fast message without admission.
  - Name the limit, what to do, and the provider's own text.
- [x] Wake region affinity:
  - `resolveTaskStartPlacement` accepts `preferredVmLocation`, which ranks without filtering
    and is ignored when invalid for the provider.
  - Recovery placement pins `vmLocation` only when the recovery chain's root task explicitly
    requested it.
  - Otherwise the sleeping workspace's location is only a preference.
  - Applies to human wakes, durable wakes and eviction recovery. Replace
    `sourceTaskExplicitLocationRequirement`.
- [x] Chain-root lookup is one bounded, project-scoped recursive query. The depth bound is
      configurable (`SESSION_RECOVERY_LINEAGE_MAX_DEPTH`, with a default constant).

### Docs

- [x] Update the compute-pools/placement docs with wake region behaviour and the core-quota
      descent, citing code.
- [x] Update the env reference for the new variable.

## Tests (rules 62, 67, 72, 28)

- [x] Provider:
  - `classifyHetznerError` / `classifyHetznerAccountLimit` arms, including an auth-403
    control and a non-Hetzner control.
  - `createVM` against a stubbed fetch that mints a fresh Response per call. Assert
    `providerCode`, message and category, exactly one POST (no same-SKU retry), and the
    auth-403 control.
- [x] `provisionNode`: the production-shaped quota 403 (built by the real HetznerProvider)
      deletes the failed row; an auth 403 keeps the `error` row.
- [x] Action layer (real `handleNodeProvisioning`):
  - cx53 → 403 core → cx43 → 403 core → cx33 succeeds, with no cooldown.
  - Size-major order skips the same-size other-region offering.
  - The smallest offering fails → account wait (real classifier, cooldown written).
  - Server limit → wait with no descent.
  - Auth 403 → fails fast.
  - Wait expiry and no-admission → legible messages.
- [x] Wake:
  - Root not explicit → relaxed plus preferred location.
  - Old-code recovery source with `explicit = 1` but a non-explicit root → relaxed (real SQL).
  - Explicit root → pinned.
  - Unknown root → relaxed.
  - Eviction follows the same rule.
- [x] Wake vertical slice: real placement resolution plus real reusable-node selection. An
      other-region host with capacity is reused; the old explicit pin is the control that
      rejects it.
- [x] Surgical reverts: each guard reverted once, and the intended tests go red.

## Implementation notes (2026-09-25)

- **Splits (rule 18).** Three files were split as pure code motion, verified token-identical by
  script: `node-provisioning-step.ts` (779→439), `session-recovery.ts` (799→462) and
  `placement-resolver.ts` (719→487).
  - The session-recovery split had to keep the `createRecoveryTask` tasks-INSERT writer in a
    module that itself calls `resolveTaskStartPlacement*` and
    `startTaskRunnerDO`/`ensureTaskRunnerStarted`. The node-pool boundary inventory checks that
    evidence per module on the AST.
  - The request-building module is named `session-recovery-request.ts`, not `*-placement.ts`. The
    boundary gate scopes modules by file-name token, and a `placement` token would have
    reclassified the persisted-label transport read as placement authority.
- **Eviction recovery** keeps normal placement per policy 95c3329a: no region preference, and
  the same root-intent pin rule as wakes. A test encodes this deliberately.
- **Core-quota descent** only applies within the exhaustion plan's attempts, so only under
  `fallback-chain`. Under `fail`/`queue` a core quota waits on `provider_account_capacity`
  directly.
- **Surgical reverts.** Each guard was reverted alone (exports kept, clean build) and reddened
  exactly the intended tests; details are in the PR.
  - R3 no descent: 5 action-layer tests.
  - R4 no same-class skip: only the skip test.
  - R5 wake pins region: the incident vertical slice, plus the wake/eviction preference tests.
  - R6 no region ordering: only "still prefers the slept-in region".
  - R7 immediate source instead of root: the incident chain test, among others.
  - R8 and R8b, no project predicate: only the respective cross-project tests; owner controls
    stay green.
  - R1 no quota classification: 10 provider tests and 10 API tests; the auth controls stay
    green.
  - R2 no category at construction: the production-shaped `provisionNode` row-delete test.
- **Rule 18, providers.** `hetzner.ts` hit 809 lines (`quality:file-sizes` fails above 800).
  Volume operations moved to `hetzner-volumes.ts`, and `createVM`'s capacity-retry loop and
  placement fallback to `hetzner-server-create.ts`, both verbatim (script-verified). `hetzner.ts`
  is now 384 lines.
- **Phase 5 review fixes (all eight reviewers PASS, no CRITICAL/HIGH):**
  - Discard crash window (cloudflare-specialist MEDIUM, security-auditor LOW):
    `discardProviderRejectedNode` now forgets the node in DO storage _before_ the D1 writes.
    The DELETE (now scoped to `user_id`) and the task unlink (now scoped to this node) run as one
    `batch`. A crash between the two used to restart claiming a deleted node, which fails the wake
    as "disappeared". R9 (storage put moved back after the batch) reddened only the new
    crash-restart test.
  - Message fallback masking a credential failure (security-auditor MEDIUM): a 403 that mentions
    a limit but talks about the token, permissions or credentials stays `auth_error`. R10 (veto
    removed) reddened exactly the three new veto tests.
  - Coverage (test-engineer): an offering with no known vCPU count waits instead of guessing
    what fits; a core quota under `fail` waits on the account.
  - Docs: the new env var added to the `env-reference` skill (plus its undocumented sibling
    `SESSION_SNAPSHOT_RECOVERY_ATTEMPT_DECAY_MS`); `packages/providers/AGENTS.md` key files; rule
    58's stale `loadRecoveryContext` path; rule 72's narrative now points at
    `node-provisioning-failure.ts`; cross-reference comments tie the session-recovery split to
    the node-pool boundary gate.
  - Accepted as-is: `coreQuotaRejections` is in-memory, so a DO restart mid-descent re-asks for
    the largest offering once (efficiency only). The platform-credential message names SAM's
    shared account (intended). No deploy wiring for the new var (matches its siblings).
  - Follow-up idea (architecture MEDIUM): read Hetzner's structured `details.limits[].name` and
    the server type's `cpu_type` instead of message/prefix heuristics.
- **Out of scope, tracked on the idea.** The three incident node rows (`01M3BB7W…`,
  `01M3BB8M…`, `01M3BB9D…`) stay `destroying`. They have no `provider_instance_id` and no
  `runtime_termination_confirmed_at`, so strict deletion cannot prove absence, and cleanup
  retries them hourly.
  - They don't count toward pool or user node limits (those count only
    running/creating/recovery).
  - New quota rejections no longer create such rows.

## Acceptance criteria

- [x] A Hetzner core-quota 403 on an offering descends to a permitted offering with fewer
      cores. It never fails the wake permanently while a smaller offering remains.
- [x] When no permitted offering fits under the quota, the task waits on
      `provider_account_capacity` instead of failing. A genuine auth 403 still fails fast.
- [x] A wake reuses a healthy other-region host with capacity. The original region only
      ranks candidates, unless the root run explicitly asked for that location.
- [x] Exhausted capacity surfaces a user-legible message, not the raw provider string alone.
- [x] Staging (rule 22): a real VM-backed sleeping conversation wakes and answers with its files
      intact. Without an explicit root region pin, it can reuse a healthy authorized host in another
      region. Fresh source/target VM provisioning and heartbeat are verified separately; all test
      nodes/workspaces are deleted.

## References

- Rules: `apps/api/.claude/rules/72`, `67`, `69`; `.claude/rules/62`, `22`, `74`, `18`, `28`
- Prior incident: `tasks/archive/2026-09-09-hetzner-412-placement-blocks-fallback-chain.md`
- Idea `01M236QPGGC6B150FG4QHT17MW` (items 2 and the 2026-09-25 recurrence; items 1, 3–8
  remain open)

## PR #2145 completion continuation (2026-09-25)

Both inspected follow-up tasks ended at the session/model limit at 16:12Z, not a technical rejection.
This prerequisite branch combines capacity/region work with the restore blockers so one final staging
pass can verify the entire preserved-conversation wake before either change ships.

- Restored the pushed VM job-context change from `7526dbe3c`.
- Removed premature snapshot failure from the retryable agent step; terminal `failTask` remains the authority.
- MCP token ownership transfers only after the caller persists it successfully. Bootstrap failures
  revoke unowned tokens; TaskRunner retries retain owned tokens and terminal failure revokes them.
- The recovery/token slice now has 8 real-SQLite tests, including rejected-handoff state rollback.
  Covers user/durable wakes and terminal/no-owner/rejected-owner controls; guard removals fail.
  The final timeout audit below expands the real TaskRunner/bootstrap slice to 17 tests.
- Local review gaps are addressed: provider rejection proof precedes deletion; detached restore
  owns teardown/shutdown and contains panics. The corrections below record the discriminating tests.
- [x] Complete review findings and discriminating tests (including the bounded restore-retry audit below).
- [x] Combined staging: failed task snapshot, fresh VM-backed recovery, preserved file and agent answer; cleanup.
- [x] Local specialist reviews completed and implementation findings addressed.
- Rollout gates remain tracked in `.do-state.md` and the PR: required CI/CodeRabbit, prerequisite
  merge and production monitoring, then preservation rebase/merge and production monitoring.

### Continuation review corrections

- Provider rejection proof is persisted at the first real `provisionNode` deletion boundary.
  TaskRunner finishes scoped D1 cleanup before clearing the proof, and replays it before claimed-node
  checks after a restart. An unexplained missing node still fails closed. A failed proof write cannot
  delete the node. Real Hetzner HTTP → provisioning → SQLite deletion/interruption/restart coverage
  proves the guard; removing the callback in an isolated transform fails only the incident case.
- Restore jobs own the workspace lifecycle lock and reject changed/stopped runtimes before effects.
  Server shutdown closes admission, cancels and joins restores before closing hosts/persistence.
  Panics are contained with an opaque cached error. Five Go-overlay mutations (panic guard, identity,
  shutdown join, lifecycle lock, admission) each fail their intended regression, without source edits.
- Rejected MCP token handoff rolls back mutable TaskRunner state before bootstrap revokes the token.
  Otherwise an alarm retry could persist/reuse that revoked token. The real step handoff-failure/retry
  regression fails when rollback is removed in an isolated transform.
- Targeted final regressions: recovery/token 8; rejected-node crash/controls 5; quota actions 13;
  terminal-writer inventory 8. Go restore/lifecycle suite passes with `-race`.

### Final timeout audit and staging checkpoint

The combined candidate passed staging run
[36176727375](https://github.com/raphaeltm/simple-agent-manager/actions/runs/36176727375).
Source task `01M3D0XSKXDSC5Q2Y367EAHRV9` created an uncommitted random proof in a fresh `fsn1`
VM. Its real failure queued snapshot sleep; HOME and WIP were captured without degradation,
and the source VM was deleted. A separate helper provisioned fresh `hel1` capacity. Recovery
`01M3D236GQ1R0D1YM4RDRCPYBX` reused that host, committed at 19:55:16.376Z, and the resumed agent
read the existing file and answered `WAKE_OK` with the identical SHA-256 at 19:55:40.748Z.
All three test workspaces and both VMs were deleted with termination confirmed; D1 showed zero
active staging nodes. This proves cross-region reuse, not provisioning initiated by the wake.

A final review found a further deadline mismatch: repeated 100-second proxy failures could exhaust
ordinary retries before the detached 15-minute restore ended, revoking its token mid-operation.
The small `snapshot-restore-retry.ts` authority now persists one retry-admission deadline before
the first restore RPC: configured operation time plus one request window to retrieve its result.
Retries, restarts, and configuration changes cannot renew it. Late alarms cannot start another RPC;
an already-admitted request remains bounded by the existing request timeout. Ordinary steps,
pre-restore bootstrap errors, permanent failures, and source revocation keep their existing rules.
Go-duration parsing includes the signed-int64 overflow bound rather than JavaScript's larger range.

Local validation: 41/41 focused tests (17 real TaskRunner/bootstrap/SQLite and 24 configuration/
predicate controls), API typecheck, ESLint, formatting, and context budget passed. Four isolated
mutations failed as expected: restoring count-only retries, removing the deadline, renewing it on
retry, and allowing a late RPC. Independent Go/security and Cloudflare/constitution/env reviews
approved the final code; the public configuration reference is synchronized.

The user assigned the final serialized staging window. Combined candidate `3e507371c`, including
prerequisite `1667a131b`, passed deployment36184076940. Final live wake and cleanup evidence follows
once complete; the initial pass above is not evidence for this later guard.

### Final candidate verification (2026-09-25)

The user assigned a final serialized staging window after the retry-deadline audit. Combined
candidate `3e507371c`, including prerequisite `1667a131b`, passed
[Deploy Staging 36184076940](https://github.com/raphaeltm/simple-agent-manager/actions/runs/36184076940).
No active deployment or staging node existed before dispatch. This pass verifies the final code;
the earlier pass separately proved source-VM removal and cross-region recovery.

- A fresh `cx23/fsn1` node `01M3D459F4B2092EKSDD8NNS9E` (provider `167462630`) booted
  about 20:30:57.760Z. Heartbeat arrived at 20:32:28.574Z (about 91 seconds), and agent
  `3584eb57e` was ready at 20:34:30.317Z. Source workspace `01M3D4FFYK387NFDXRG0290YG4`
  was accessible and executed agent tools.
- UI-created task `01M3D452DDMC3G09VCXGJ24ZQ5`, conversation
  `1887e4f8-1ff7-4aa1-9e5c-27766a8bc899`, wrote an uncommitted random proof file. Its
  SHA-256 was `645753f9bc986e1ad01630b5e9a8a4fff1ce1581cc4cbf7479d0b4566643bb03`.
  The random bytes were never printed or supplied in the wake prompt.
- Real task failure returned HTTP 200 and queued preservation. Snapshot
  `01M3D4J9XMEJ2QN643QPG2N5R5` captured HOME and WIP, `available` with degradation `none`.
  The public Sleep action returned 200, sleeping at 20:45:41.489Z with seven-day retention;
  ProjectData also reported `sleeping`. This pass used explicit Sleep after the failure queued
  preservation; the earlier pass proved automatic sleep.
- UI wake returned 202 (delivery `01M3D536D0AA4DY7T4FK123983`). It retried through the
  existing five-minute workspace deletion fence. Natural deletion was confirmed at
  20:50:45.572Z; no guard or allocation authority was bypassed.
- Recovery task `01M3D5D37VB3VJ3SSDZS3BM5P5` created replacement workspace
  `01M3D5D9X3G12R8EDQQ0J9TEWT` on the same healthy VM. Restore committed at
  20:53:19.200Z. The source task stayed failed; recovery reached in-progress without error.
  At 20:54:54.635Z the restored agent answered `WAKE_OK` with the identical hash, after a real
  `sha256sum` tool call on the existing file, still `?? pr2145-preservation-proof.txt`.
- Desktop and 375×667 mobile screenshots were inspected: the restored answer and composer were
  visible with no layout issue. Dashboard/projects/settings were checked in the first pass.
- Both source/recovery workspace DELETEs returned 200 with confirmed deletion; node DELETE
  returned 200 after runtime termination. D1 verified zero active staging nodes and no created
  workspace/node/snapshot rows. Existing TestProject1/profile/shared pool were retained.
  The staging window was explicitly released to node-health and the coordinator at 20:56Z.

The final live restore completed without deliberately inducing a proxy timeout or provider quota.
Request-cancellation, retry-deadline/exhaustion, quota descent, and guard controls are proven by
local integration/race tests and discriminating mutations; do not describe these injected faults
as occurring during this live pass. Required CI, CodeRabbit, merges, and production monitoring
remain rollout gates in the PR and `.do-state.md`.
