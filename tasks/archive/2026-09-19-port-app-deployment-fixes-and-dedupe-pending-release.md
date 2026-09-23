# Port five app-deployment fixes from DefangLabs PR #45, plus source-level `pendingReleaseSeq` dedup

**Status:** implemented, CI green, PARTIALLY staging-verified — blocked from merge
**Origin:** DefangLabs/simple-agent-manager PR #45 (branch `sam/use-sam-mcp-tools-wkkamr`, opened
2026-09-05, still open and never staging-verified). All five defects it fixes are confirmed present
on upstream production; a sixth (the *cause* of the duplicate it only mitigates) is added here.

## Problem

Six independent defects in the app-deployment path, all verified against production
(`sam-prod` D1, 2026-09-19):

1. **DNS create race wedges a deployment** — `upsertAppRouteDNSRecord`
   (`apps/api/src/services/dns.ts`) is check-then-act across an `await`. It is fanned out via
   `Promise.all` in `deploy-release-callback.ts`, and overlapping release fetches run that whole
   handler concurrently. Both callers see "no record", both `POST`, Cloudflare rejects the loser
   with `81058 An identical record already exists.` `if (!response.ok) throw` turns a
   self-correcting condition into a 500 on `GET /api/nodes/:id/deploy-release`, so the node never
   receives its release payload. The visible symptom (missing TLS cert) is three layers downstream.

2. **The sibling create in the same module has the same race, with a worse failure mode** —
   `createNodeBackendDNSRecord` is a blind `POST`. Two paths create that record (node provisioning
   `services/node-provisioning.ts:568`, heartbeat backfill `routes/node-lifecycle.ts:451`) and the
   loser throws. The heartbeat catch only stamps `nodes.error_message` and leaves
   `backend_dns_record_id` NULL, so every later heartbeat retries the same losing `POST` forever,
   and node deletion (which deletes by that id) orphans the real record in the zone.

3. **Every heartbeat spawns another apply goroutine** — `health.go` spawns
   `runDetachedDeploymentApply` per pending release with no in-flight guard.
   `observed.AppliedSeq` only advances after a *fully successful* apply, so any release slower than
   one heartbeat interval accumulates another concurrent apply per tick, each re-running the whole
   control-plane fetch (re-decrypting secrets, re-minting a registry credential, regenerating
   presigned URLs, re-signing the payload, and racing on app-route DNS).

4. **The apply idle watchdog kills slow image pulls** — the 15-minute
   `DefaultDeployApplyIdleTimeout` is reset only by `ApplyProgressEvent`s, i.e. the events that
   become `deployment_release_events` rows. `docker compose up` emits exactly one
   (`compose_up_started`) and then nothing until it returns, so a legitimately slow pull is
   indistinguishable from a hung apply and gets SIGKILLed. The diagnosis is then destroyed: the
   accurate `"deployment apply stalled"` error is overwritten by the child's `signal: killed`,
   which is a *consequence* of our own cancel.

5. **`deployment_volumes.status` is frozen at the provider's transient snapshot** —
   `attachEnvironmentVolumes` persists `attached.status` straight from `provider.attachVolume()`.
   Hetzner's attach is an async action, so `getVolume()` immediately afterwards still reports
   `creating` or `available`. Nothing ever re-polls the row (the only other writer is the detach
   path), so an attached, mounted, working volume reads `creating` forever — the single most
   obvious "here is your stuck deployment" signal, and a false one.

6. **The control plane sends the same pending release twice** (NOT in the fork PR) —
   `node-lifecycle.ts:769-776` puts a lone pending release in BOTH `deployment.pendingReleases[]`
   and the legacy `response.pendingReleaseSeq`. `health.go:316-323` re-appends the legacy copy
   whenever `ENVIRONMENT_ID` is set, which cloud-init (`packages/cloud-init/src/template.ts:196`)
   always does — so the agent spawns two apply goroutines from a single heartbeat tick. This is the
   "still unexplained" duplicate the fork PR could not account for. Worse than duplication: the
   agent attributes the legacy seq to `s.config.EnvironmentID` (the node's cloud-init primary
   environment), so on a node hosting more than one environment a pending release for environment B
   is *also* applied against environment A's engine, with B's seq. `claimJob` cannot dedupe that —
   the job ids differ.

### Production evidence (`sam-prod` D1, queried 2026-09-19)

| Claim | Evidence |
|---|---|
| Duplicate fetch per apply | `deployment_release_events`: `deployment.apply.fetch_started` = 24 vs `deployment.apply.started` = 12 — an exact 2:1 ratio, all-time, across all environments |
| Both fetches come from one tick | The 2026-09-17 pair is **4 ms** apart (`02:39:21.335Z` / `02:39:21.339Z`), not one heartbeat interval apart — i.e. two goroutines from the same response, which is exactly defect 6 |
| Frozen volume status | `deployment_volumes` `01KXAR1S83QNZN32M8SKHPPB6G`: `status='creating'` with `attached_server_id=150100869` and `linux_device=/dev/disk/by-id/scsi-0HC_Volume_106327663`, `updated_at` 2026-07-12T08:45:41Z and never written again |
| …and the `available` variant | `01M1015EV0J4911YVGG8GSY0RB`, `01M1G9D723DCTMGF9XB3Z9TH46`: `status='available'` while attached to `163715232` |
| Legacy field is still emitted | `node-lifecycle.ts:775` sets `response.pendingReleaseSeq`; `apps/api/tests/workers/deployment-control-plane-release.test.ts:136` asserts it |

## Research findings

### Merge-conflict surface (fork base `339b01325` → upstream `main`)

Only three of the eighteen files the fork touches have diverged upstream:

| File | Upstream divergence | Resolution |
|---|---|---|
| `apps/api/src/services/dns.ts` | `signal?: AbortSignal` on `deleteDNSRecord` / `findDNSRecordByName` / `createNodeBackendDNSRecord`, plus `requireUnique` and `recoverExisting`, plus `completeAbortableResponse` | Merge by hand; thread `signal` through every new read |
| `packages/vm-agent/internal/server/health.go` | +95 lines, all in the metrics / eviction-callback region | Fork hunks in `runDetachedDeploymentApply` / `…RouteApply` apply cleanly |
| `packages/vm-agent/internal/server/server.go` | +128 lines of new struct fields | Add the two `inFlightJobs*` fields and the two `make()` / `ApplyLiveness` lines |
| `apps/api/tests/unit/routes/deploy-release-callback.test.ts` | `waitUntilMock` + execution context on `requestDeployRelease()`, release `status` in the db stub | Fork's added test uses the existing helpers, so it ports as-is |
| `.claude/rules/53-…` | Root copy is now a **stub**; full text moved to `apps/api/.claude/rules/53-…` | Apply the fork's new §5c to the scoped full copy, not the root stub |
| `.claude/rules/68-external-api-check-then-act.md` | 68 is taken (`68-event-scoped-filter-predicates.md`); highest number in the repo is 74 | Renumber to **75** |
| `apps/api/tests/unit/services/project-data-snapshot-recovery-wake.test.ts` | Already fixed upstream in `70862f521` (identical `vi.useFakeTimers()` approach) | **Drop** the fork change |
| `apps/api/tests/workers/project-data-tool-payload-archive.test.ts` | Upstream rewrote it (+2902 lines) | **Drop** the fork change |

`compose.go`, `engine.go`, `engine_config.go`, `vm_jobs.go`, `deployment-volumes.ts`,
`deployment-volumes.test.ts` and `dns-app-routes.test.ts` are byte-identical upstream vs the fork
base — those hunks apply without conflict.

### Deliberate divergences from the fork PR

1. **`createNodeBackendDNSRecord` conflict recovery must respect `recoverExisting`.** Upstream's
   durable-provisioning path (`recoverExisting = true`) refuses a pre-existing record whose
   identity differs from the allocation being recovered. The fork's recovery `PATCH`es the content
   unconditionally, which would silently delete that refusal for a conflict that lands *after* the
   pre-check (rules 63 / 71: relaxing one branch deletes the check that used it). Extract the
   identity predicate once and apply it on both paths; converge the IP only on the ordinary path.
2. **`findDNSRecordByName(..., requireUnique = true)` for the conflict lookup.** Cloudflare allows
   several A records for one name (round-robin). Adopting "the first" would persist one id and
   orphan the rest. An ambiguous zone must surface the original conflict, not be silently resolved.
3. **Defect 6 is fixed on both sides.** API: stop emitting the duplicate. Agent: treat
   `pendingReleaseSeq` as a *fallback*, honoured only when `deployment.pendingReleases` is empty —
   which is the field's actual semantic and, unlike a dedupe by `(env, seq)`, also closes the
   mis-attribution case.

### Compatibility check for removing `pendingReleaseSeq` (rule 54 §5, §12)

`deployment.pendingReleases` was added to the VM agent **and** to the control plane in the *same*
commit `703b8b56f` (2026-06-21). Every agent that can parse a deployment heartbeat block since then
understands the structured list. The two live production deployment nodes were created 2026-07-12
(`01KXAR1T3XCQKKPBEJEERQ2PSZ`) and 2026-08-26 (`01M1015FQ9D772EF6HHB5AGZ0Z`) — both after that
commit. The agent-side fallback is kept anyway so a self-hosted older control plane still works.

### Other checks

- `deployment_volumes.status` is plain `TEXT` with no `CHECK` constraint (`schema.ts:4357`);
  `'attached'` is already a member of the provider `VolumeStatus` union
  (`packages/providers/src/types.ts:145`), and `mapHetznerVolumeStatus` already maps Hetzner's
  `in-use` onto it. No migration, no constraint widening.
- The heartbeat volume-readiness gate (`node-lifecycle.ts:94-127`) keys on `attached_server_id`,
  **not** `status`, so the status change cannot affect release admission. The detach path already
  writes a hardcoded `status: 'available'`, so writing a hardcoded `'attached'` on attach is
  symmetric with the existing pattern.
- `DeploymentVolumesPanel.tsx:324` renders `volume.status` through `StatusBadge` with an explicit
  `label`, and neither `available` nor `attached` is in `statusConfig`, so both already render with
  the neutral/unknown palette. `creating` → `attached` shifts one badge from the info palette to
  that same neutral palette. Pre-existing cosmetic gap; not widened here, and no `apps/web/` or
  `packages/ui/` file is touched, so rule 17's visual audit does not apply.
- `runCompose` is byte-identical upstream, and `livenessWriter` exposes `String()`, so the two
  existing `stderr.String()` call sites keep working unchanged.

## Implementation checklist

### Phase A — API: DNS duplicate tolerance (defects 1, 2)

- [x] Widen `cloudflareErrorSchema` to carry a permissive `code: v.optional(v.unknown())` and add
      `readCloudflareErrorDetail`, with `readCloudflareError` delegating so no other call site changes
- [x] Add `CF_DNS_DUPLICATE_RECORD_CODES` (`81057`, `81058`) and `isDuplicateRecordConflict`,
      with a comment naming why `81053` is excluded
- [x] Rework `upsertAppRouteDNSRecord` as a bounded (`DNS_UPSERT_RACE_MAX_RETRIES = 1`) loop that
      retries only on the create path (`!existing`)
- [x] Extract the node-backend identity predicate now inlined in the `recoverExisting` branch and
      reuse it for the conflict path
- [x] Add conflict recovery to `createNodeBackendDNSRecord`: resolve the winner with
      `requireUnique`, thread `signal`, honour `recoverExisting`, converge the IP otherwise

### Phase B — API: settled volume status (defect 5)

- [x] Persist and return `'attached'` instead of the provider's snapshot in
      `attachEnvironmentVolumes`

### Phase C — API: stop sending the duplicate pending release (defect 6, source side)

- [x] Remove the `response.pendingReleaseSeq` emission from `node-lifecycle.ts`
- [x] Update the comment at `deploy-release-callback.ts:136` that names the field

### Phase D — VM agent: duplicate-apply guard (defect 3)

- [x] Add `inFlightJobsMu` / `inFlightJobs` to `Server` and initialise in `New`
- [x] Add `claimJob` to `vm_jobs.go` (atomic claim, idempotent release)
- [x] Claim in both `runDetachedDeploymentApply` and `runDetachedDeploymentRouteApply`

### Phase E — VM agent: compose liveness + honest stall error (defect 4)

- [x] Add `ApplyLivenessFunc` to `engine_config.go` and wire `ApplyLiveness` in `server.go`
- [x] Add `activeSeq` / `setActiveApplySeq` / `signalLiveness` to the engine, set from `Apply`
- [x] Add `livenessWriter` (tail-retaining, amortised compaction) and use it for compose stderr
- [x] Add `signalApplyLiveness` to `vm_jobs.go`
- [x] Keep the stall error as the primary cause with the child result as context

### Phase F — VM agent: legacy field is a fallback only (defect 6, agent side)

- [x] Honour `hbResp.PendingReleaseSeq` only when `hbResp.Deployment.PendingReleases` is empty

### Phase G — Tests

- [x] `apps/api/tests/unit/services/dns-app-routes.test.ts`: race per tolerated code, update-path
      control, `81053` control, unrelated-failure control, `code: null` / stringified-code
      regressions, boundedness, same-hostname convergence against a shared fake store, `Promise.all`
      fan-out, and the `createNodeBackendDNSRecord` sibling set including a `recoverExisting`
      mismatch control and an ambiguous-zone control
- [x] `apps/api/tests/unit/routes/deploy-release-callback.test.ts`: route-level regression that the
      endpoint returns 200 when one route loses the race
- [x] `apps/api/tests/unit/services/deployment-volumes.test.ts`: transient provider status is not
      persisted
- [x] `apps/api/tests/workers/deployment-control-plane-release.test.ts`: the structured list is
      present and `pendingReleaseSeq` is absent
- [x] `packages/vm-agent/internal/server/deploy_apply_dedup_test.go`: duplicate skipped, distinct
      seq allowed, claim released, route path guarded, exclusivity under `-race`, idempotent
      release, nil map
- [x] `packages/vm-agent/internal/deploy/compose_liveness_test.go`: liveness from child output,
      silent-command control, outside-apply control, stderr preserved in the error, signals past the
      cap, tail-not-head, chatty end-to-end, `setActiveApplySeq` restore, `-race` access
- [x] `packages/vm-agent/internal/server/heartbeat_pending_release_test.go`: legacy field ignored
      when the structured list is present, honoured when it is empty
- [x] Prove each new guard discriminating by reverting it once and recording which tests redden

### Phase H — Rules and docs

- [x] Add `.claude/rules/75-external-api-check-then-act.md` (the fork's rule 68, renumbered, with
      references corrected to the real paths)
- [x] Add the watchdog-liveness lesson (fork's §5c) to
      `apps/api/.claude/rules/53-scheduled-handler-isolation-and-liveness-signals.md`
- [x] Run `pnpm quality:agent-context-budget` and report the instruction-surface delta

## Acceptance criteria

- [x] A concurrent app-route create conflict (`81057` / `81058`) converges instead of throwing, and
      `GET /api/nodes/:id/deploy-release` still returns 200 when one route loses the race
- [x] `81053`, auth/quota failures, and duplicate codes on the **update** path all still throw, with
      no retry
- [x] A concurrent node-backend create conflict returns the winner's record id so
      `backend_dns_record_id` gets persisted; `recoverExisting` still refuses a foreign allocation
- [x] Two apply goroutines for the same `(environmentId, seq)` result in exactly one
      control-plane fetch; distinct seqs both run; the claim is released on completion
- [x] A compose child that keeps writing to stderr keeps the apply watchdog alive; a silent child
      does not; retained output is the tail; the failing line survives in the error
- [x] A stalled apply reports the stall as the primary cause, not `signal: killed`
- [x] `attachEnvironmentVolumes` persists `attached` when the provider still reports `creating`
- [x] A heartbeat with one pending release emits it exactly once, and an agent that receives both
      fields spawns exactly one apply
- [x] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` green; `go test ./... -race` green
- [~] Staging deploy green (run 35431702939). Node-provisioning half verified live; the
      deployment-APPLY half is BLOCKED by a pre-existing bug — see "Staging verification" below

## References

- Fork PR: https://github.com/DefangLabs/simple-agent-manager/pull/45 (local ref `defang-pr45`)
- `.claude/rules/45-durable-object-concurrency-mutex.md` — the in-isolate analogue
- `.claude/rules/53-…` / `apps/api/.claude/rules/53-…` — a signal that cannot answer its question
- `.claude/rules/54-vm-agent-rollout-compatibility.md` §5, §12 — old agents stay protocol-compatible
- `.claude/rules/57-write-only-cross-boundary-state.md` — remote-owned state must be reconciled
- `.claude/rules/62-tests-must-observe-the-real-trigger.md` — prove every new guard discriminating
- `.claude/rules/63` / `.claude/rules/71` — relaxing one branch deletes the check that used it
- `.claude/rules/67-shared-predicates-that-trigger-actions.md` — keep the tolerated set narrow

## Evidence

### Discrimination matrix (each revert run once, then restored)

| Revert | Went red | Green controls |
|---|---|---|
| DNS duplicate tolerance disabled (empty code set) | 12 race tests across helper + route | 50 |
| `!existing &&` conjunct dropped | update-path control ONLY | 29 |
| `recoverExisting` identity discipline dropped | 2 durable-path refusal controls | 28 |
| `dns.app_route_ambiguous_records` warning removed | ambiguity test ONLY | 31 |
| `claimJob` guards removed | 2 duplicate-spawn Go tests | heartbeat set |
| `defer releaseClaim()` leaked on the route path | `…RouteApplyReleasesClaimOnCompletion` ("fetches = 1, want 2") | rest |
| legacy-field guard reverted alone | mis-attribution test (`[env-a@9 env-b@9]`) | rest |
| `claimJob` + legacy guard reverted (true pre-fix) | duplicate fetch reproduced as `[env-a@7 env-a@7]` | 2 controls |
| compose liveness wiring removed | liveness-from-child-output test | 3 controls |
| tail retention swapped for head | 2 tail-retention tests | rest |
| stall error overwritten by child | stall-must-lead assertion | rest |
| raced-success branch removed from `stalledApplyResult` | raced-success subtest | sibling subtest |
| volume provider snapshot persisted | 3 settled-status tests | 36 |
| legacy `pendingReleaseSeq` emission restored | 3 absent-field assertions | rest |

### Instruction-surface delta (`pnpm quality:agent-context-budget`)

Rule 75 is a root STUB plus a scoped full copy, so `claude-root-surface` grows 199,309 →
199,569 chars (**+260 chars / ~+75 tokens**). As a full root rule it would have been 209,489
(**+10,180 chars / ~+2,899 tokens**) on every session's startup context.
`apps-api-scoped-rules` 210,407 → 223,047 chars, loaded by path rather than at startup.

### Request I/O budget (rule 60)

`GET /api/nodes/:id/deploy-release` gains, per route that LOSES the create race, at most 2
extra Cloudflare fetches (one re-resolve + one PUT), bounded by
`DNS_UPSERT_RACE_MAX_RETRIES = 1`. Unraced routes add zero. `createNodeBackendDNSRecord` adds
at most 2 on conflict (one lookup + one conditional PATCH) and zero otherwise. These are
Cloudflare API calls, not D1 round-trips, and they occur only on the conflict path — which
previously 500'd the whole request.

### Known composition gap (accepted)

Acceptance criterion 3's *persistence* half — the returned winner id reaching
`nodes.backend_dns_record_id` — is proven by composition rather than one test:
`createNodeBackendDNSRecord`'s conflict recovery is tested directly, and the persistence line
(`node-lifecycle.ts:452`) is pre-existing code this change does not touch. Raised as LOW by
the task-completion-validator and accepted.

## Staging verification (partial — merge is blocked)

Staging deploy `35431702939` succeeded against `258b6ae42`. The deployed worker reports
`VM_AGENT_REQUIRED_VERSION=258b6ae423c8fee2090ccfa2b2e8d672135b71b7`, i.e. this branch's HEAD.

### Verified live on staging

| Fix | Evidence |
|---|---|
| 2 — node-backend DNS create, and the `dns.ts` → 4-module split | Two nodes provisioned under `agent_version=258b6ae423c8` (this HEAD) each got a real record: `01m2wcsxmb4ccr0awkjb2ggkq6.vm.sammy.party` → `49.12.106.28` and `01m2wch7ansdptm2kqe63y7q3j.vm.sammy.party` → `159.69.248.202`, both `type=A`, `proxied=true`, read back from the Cloudflare zone by record id. Both nodes `running`/`healthy` with heartbeats <60 s old. |
| VM agent boots from this branch (rule 27 / Phase 6b) | Same two VMs: real Hetzner instances running the binary built from this HEAD, heartbeating the control plane. |
| 6 — control plane stops emitting the duplicate | The **deployed** `sam-api-staging` bundle contains **0** occurrences of `pendingReleaseSeq` and 4 of `pendingReleases`. Discriminating: the deployment block is present; specifically the legacy field is gone. |
| 1 / 2 — tolerance is deployed | The deployed bundle contains `81057`, `81058`, `dns.app_route_upsert_race_retry`, `dns.node_backend_create_race_resolved`, `dns.app_route_ambiguous_records`, `dns.conflict_lookup_failed`. |

### NOT verified live — blocked

The deployment **apply** path could not be exercised. Every release submission fails ~2 s later
with a pre-existing defect:

```
Deployment node placement failed: D1_ERROR: Expression tree is too large (maximum depth 100): SQLITE_ERROR
```

Reproduced 3/3 (08:45:07Z, 08:49:19Z, 08:53:06Z), with and without a named volume. It is raised
inside `provisionDeploymentNode`, and this branch touches **no** provisioning, placement or
capacity file. Filed as
`tasks/backlog/2026-09-19-deployment-provisioning-expression-tree-too-large.md`.

That leaves these unverified in their live form: fix 1's `Promise.all` app-route upsert, fix 3's
`claimJob`, fix 4's compose liveness watchdog, fix 5's volume `attached` status, and fix 6's
agent-side fallback. All are covered by unit/integration tests proven discriminating, and fix 5
additionally by production D1 evidence — but none has run on a real deployment node.

Per `.claude/rules/30-never-ship-broken-features.md` and policy `86348737`, this PR must NOT be
merged on that basis. `needs-human-review` applied; awaiting a decision.

### Staging resource cleanup

All resources created by this verification were deleted: 4 throwaway environments, 3 stale
deployment node rows (none had a `provider_instance_id`, so no Hetzner VM was ever created for
them), and 1 provider volume. Confirmed zero `pw-deploy-%` environments, zero deployment-role
nodes and zero recent volumes remain. The 3 workspace nodes still on staging belong to another
agent and were left untouched.

## Sources consulted (all fetched and 200 before citing)

Context7 was unavailable in this environment, so official primary documentation was used
(`.claude/rules/05-preflight.md`). Recorded here as well as in the PR body so the evidence
survives the PR.

- Cloudflare DNS API, record create — <https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/create/>;
  DNS docs root <https://developers.cloudflare.com/dns/>. Basis for tolerating `81057`/`81058`
  ("this exact record already exists") while excluding `81053` (a different-type collision on
  the host, which retrying cannot fix), and for requiring a unique match on the node-backend
  conflict lookup — Cloudflare permits several A records per name for round-robin.
- Cloudflare API reference root — <https://developers.cloudflare.com/api/>. Confirms an error
  response carries a numeric `code` beside `message`, which is why `readCloudflareErrorDetail`
  reads both in one pass: a `Response` body can be consumed only once.
- Go `os/exec` — <https://pkg.go.dev/os/exec>, <https://pkg.go.dev/os/exec#Cmd.Wait>. A
  non-`*os.File` `Stderr` is written by a single copier goroutine that `Wait` blocks on, which
  is what makes `livenessWriter` safe without a lock and makes post-`Run` reads safe.
- Cloudflare D1 platform limits — <https://developers.cloudflare.com/d1/platform/limits/> — and
  SQLite implementation limits — <https://www.sqlite.org/limits.html> (`SQLITE_MAX_EXPR_DEPTH`).
  Consulted while diagnosing the staging blocker: the depth ceiling is a platform limit set far
  below stock SQLite's default, which is why `better-sqlite3` suites cannot observe it.
- Fork PR under port — <https://github.com/DefangLabs/simple-agent-manager/pull/45> — fetched as
  the local ref `defang-pr45` and diffed against its own base `339b013256a7`, so the deliberate
  divergences are differences from real code rather than from its description.
