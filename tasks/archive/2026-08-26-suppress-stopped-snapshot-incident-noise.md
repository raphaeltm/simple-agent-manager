# Suppress stopped-devcontainer snapshot incident noise (complete PR #1924)

- **Status**: complete
- **PR**: https://github.com/raphaeltm/simple-agent-manager/pull/1924
- **Branch**: `sam/sam-private-incident-triage-aa86rx`
- **Origin**: private feedback incident triage task `01M0Y5XQ7JDV0R6ZWHX7AA86RX`; picked up for completion by `01M0Y6ZDJEX69VTV10HPZ4KK2B`

> Task file lives on the feature branch rather than being pushed directly to `main` first:
> repository rules now reject direct pushes to `main` (`push declined due to repository rule
> violations`), so the `/do` Phase 1 direct-to-main exception is no longer available.

## Problem

The vm-agent reports every background session-snapshot failure to the control plane as a
platform **error** incident (`session_snapshot.background_capture`). The dominant failure is a
benign teardown race, so the private incident queue and `platform_errors` are flooded with a
signal that represents no user-visible problem — which buries the incidents that do matter and
burns the diagnosis budget (`.claude/rules/47`, "budget exhaustion is capacity, not disposition").

## Research findings

### The noise is real, and it is nearly all of the vm-agent error volume

Queried `sam-observability-prod` (D1 `68b1c534-bba4-44fc-9de5-ff1bed9f70e0`,
`CF_PRODUCTION_DEBUGGING_TOKEN`), all `source='vm-agent' AND level='error'` since 2026-08-20:

| count | message |
|------:|---------|
| 217 | `resolve snapshot devcontainer: workspace is not running/recovery (status: stopped)` |
| 7 | `snapshot control plane returned HTTP 409: … Snapshot capture generation is no longer current` |
| 6 | `resolve snapshot devcontainer: failed to resolve container: no running devcontainer found (label: …)` |
| 1 | `resolve snapshot devcontainer: workspace not found` |
| 1 | `failed to write auth file: create auth file parent dir: command failed: context canceled` |
| 1 | `ACP prompt force-stopped` |
| 1 | `ACP initialize failed: … Request cancelled` |

**224 of 234** vm-agent error incidents are the same teardown race in three spellings.

### It is noise, not work loss — verified, not assumed

`.claude/rules/39` (debug before redesign) and policies `a3780107` / `d08d64dc` mean a snapshot
failure must NOT be silenced if work is actually being lost. Cross-checked `session_snapshots` in
`sam-prod` (D1 `a8923a52-b1d4-4e0d-9bd9-aa5406face5e`) for four affected chat sessions:

| chat_session_id | sleep_status | sleep_attempts | home_r2_key | capture_error |
|---|---|---|---|---|
| `07f48097…` | sleeping | 1 | present | NULL |
| `1050255c…` | sleeping | 1 | present | NULL |
| `d44fa0f1…` | sleeping | 1 | present | NULL |
| `d7b24e6d…` | sleeping | 1 | present | NULL |

For `1050255c…` the successful sleep snapshot landed at `05:01:20.573Z` and the failing background
snapshot fired at `05:01:21.801Z` — **1.2 seconds later**. The failing capture is a redundant
post-stop attempt against an already-torn-down devcontainer; the authoritative snapshot already
exists and the session is resumable. Suppressing the incident loses no signal.

### Error origin chain

- `internal/server/git.go:357` `resolveContainerForWorkspace` returns
  `workspace not found` or `workspace is not running/recovery (status: %s)`
- `internal/server/session_snapshot_container_support.go:77` `resolveContainerSnapshotTarget` passes it through
- `internal/server/session_snapshot.go:302` wraps it: `resolve snapshot devcontainer: %w`, boxed in
  `sessionSnapshotCaptureError` (which implements `Unwrap()`, so `errors.Is` traverses the chain)
- `internal/server/session_snapshot_coordinator.go:76` is the **only** snapshot incident report site
  (verified by enumerating every `ReportError(` caller), so there is no `.claude/rules/61`
  cover-every-runtime gap — the foreground/final capture path returns its error to the HTTP caller
  instead of reporting an incident.

### Defect in the first cut of PR #1924

The PR widened the **shared** `isContainerUnavailableError` (`workspace_provisioning.go:156`) by
adding the `"workspace is not running/recovery"` substring. That predicate has four callers and at
**three** of them it is a **workspace-recovery trigger**, not a noise classifier:

- `websocket.go:222` — terminal session create failed → `recoverWorkspaceRuntime`
- `websocket.go:504` — multi-terminal session create failed → `recoverWorkspaceRuntime`
- `agent_ws.go:338` — SessionHost container resolve failed → `recoverWorkspaceRuntime`

Blast radius **today** is zero: those three sites only ever see errors minted by
`pty.Manager.CreateSessionWithID` (`devcontainer not available: %w`, `internal/pty/manager.go:113`)
or the container resolver (`no running devcontainer found`), never the `git.go` text. But the
coupling is latent — the predicate now means two different things, and any future error path that
reaches both call sites silently gains a recovery attempt. This is the `.claude/rules/24` /
`.claude/rules/59` "one implementation per operation" class applied to a predicate.

Two smaller issues in the same diff:

- It suppressed `context.DeadlineExceeded`. A background snapshot that blows its
  `SessionSnapshotOperationTimeout` budget is a **material** failure (policy `d08d64dc`: snapshot
  failures must surface visibly) and there are **zero** such errors in production, so the
  suppression buys nothing and hides something real.
- It missed `workspace not found` (1 occurrence), which is the same teardown race.

### CI state on PR #1924 before this work

- **Preflight Evidence — FAIL**: `Missing or malformed Agent Preflight block markers in PR body.`
- **SonarCloud — FAIL**: `new_duplicated_lines_density` 72.4% vs threshold 3%, caused by the two
  new ~58-line near-identical incident tests.
- All 25 other checks pass.

## Implementation checklist

- [x] Add typed sentinels `errWorkspaceRuntimeNotFound` / `errWorkspaceNotRunning` in `git.go`, and
      have `resolveContainerForWorkspace` wrap them with `%w`, preserving the exact message text
- [x] Revert the widening of `isContainerUnavailableError` (restore its recovery-trigger meaning)
- [x] Add `isSnapshotTeardownRaceError` in the snapshot coordinator, composing the sentinels with
      `isContainerUnavailableError` (composition, not duplication)
- [x] Simplify `shouldReportBackgroundSnapshotIncident` to the evidence-backed rule; drop the
      `context.Canceled` / `context.DeadlineExceeded` suppression
- [x] Rewrite the two duplicated tests as one table-driven test with a shared harness (clears Sonar)
- [x] Cover all three teardown-race spellings plus a material-failure control in the table
- [x] Prove the guard discriminating: delete it, confirm only the suppression cases go red, restore
- [x] Add process-fix rule `.claude/rules/67-shared-predicates-that-trigger-actions.md`
- [x] Add the Agent Preflight block + Post-Mortem + Specialist Review Evidence to the PR body
- [x] File a SAM Idea for the unaddressed HTTP-409 stale-generation snapshot noise (7 occurrences)
      -> SAM Idea `01M0Y8FDWWPFAJ50WSYSEZQ5KD`

## Acceptance criteria

- [x] `isContainerUnavailableError` function body is byte-identical to `main` (verified by diffing the
      function against `origin/main`; only a doc comment was added above it) — no behaviour change at its
      three recovery call sites, and pinned by `TestWorkspaceLifecycleErrorsClassifyWithoutTriggeringRecovery`
- [x] All three production teardown-race messages stop producing error incidents
      (`TestBackgroundSessionSnapshotIncidentSeverity`, cases built from the real resolver)
- [x] A material snapshot failure (e.g. `HTTP 400: checksum mismatch`) still produces an incident
- [x] A snapshot timeout still produces an incident (`capture exceeded its time budget` case)
- [x] The generation-scoped `reportSnapshotFailure` callback still fires for suppressed failures, so
      the control plane is not blinded (asserted in every table case)
- [x] `go test ./...` green in `packages/vm-agent` (also `-race`); `go vet` and `gofmt` clean
- [x] SonarCloud quality gate passes; Preflight Evidence passes
- [x] Real-VM staging verification per `.claude/rules/27` + `/do` Phase 6b, with staging nodes
      deleted afterwards (Hetzner 10-server shared cap, policy `a63e6a68`)

## Staging verification result (2026-08-26)

Deployed `f90e4b2e3` (run 32936025010). Deleted all staging nodes first so the new node pulled the
new binary. Provisioned node `01M0YCA7Q4KJ75YBWJDJ6RSTXB` (06:32:26Z), heartbeat 06:34:53Z (2m27s).
Agent ran a real prompt (Prompt completed 06:35:44Z), then `POST /api/workspaces/:id/sleep` at
06:36:07Z provoked the teardown race.

The race FIRED — node log 06:36:08.241557Z:
`WARN Background session snapshot failed` /
`error: resolve snapshot devcontainer: workspace is not running/recovery (status: stopped)`
— two seconds after a successful capture, the exact production signature.

Result: **0** matching rows in staging `platform_errors` after baseline, while **12** vm-agent rows
were reported in the same window (liveness control — so the absence cannot be a dead reporter), and
`session_snapshots` shows `available` / `degradation=none` / `home_r2_key` present / `capture_error`
NULL. Pre-test baseline on the old binary had accumulated 15x + 2x of these signatures.

Test node and workspace deleted; staging back to zero VMs at rest.

## Review findings addressed (Phase 5)

Three local reviewers ran. All findings addressed in-branch; none deferred.

| Finding | Severity | Resolution |
|---|---|---|
| go-specialist: suppression keys off the `errWorkspaceNotRunning` sentinel, which covers `stopped`, `creating` and `error` alike, while evidence only validated `stopped`. `errors.Is` cannot see the interpolated status. | MEDIUM | Introduced `workspaceNotRunningError` carrying the status; `isSnapshotTeardownRaceError` now branches with `errors.As` and suppresses **only** `stopped`. Added must-still-report cases for `creating` (restart race) and `error`. Proven discriminating: widening back to all statuses turns both red. |
| test-engineer: no regression test for `context.Canceled`, the other half of the suppression the first cut added. Proven by re-adding it and watching the whole suite stay green. | HIGH | Added a `capture cancelled mid-flight` case. Proven discriminating: re-adding `context.Canceled` suppression turns it red. |
| test-engineer: the dominant production wrap (`resolve snapshot devcontainer: %w`) was hand-duplicated in the test helper, so changing it to `%v` would disable classification with no test failing. | MEDIUM | Extracted `newSnapshotResolveError` in `session_snapshot.go` as the single seam; production and tests both call it. Proven discriminating: `%w` -> `%v` now turns two cases red. |
| test-engineer: the `create WIP bundle` timeout case used a shape that cannot reach the classifier (WIP failures degrade the manifest instead of erroring). | MEDIUM | Rebuilt from `completeSnapshot`'s real hard-failure shape, which does box the error with a generation. |
| test-engineer: `waitFor`'s stopping condition called `shouldReportBackgroundSnapshotIncident` — the function under test. Verified non-exploitable but fragile. | LOW-MED | Harness now takes `wantIncident` from the caller and adds a settle window for absence assertions. |
| task-completion-validator: PR body missing Preflight/Post-Mortem/review table; no staging verification. | HIGH x2 | PR body rewritten; staging verification performed in Phase 6. |
| both: one case uses a literal string for the `no running devcontainer found` shape. | LOW | Documented why (substring predicate, no `%w` chain, pinned independently by `TestIsContainerUnavailableError`). |

## Post-mortem

**What broke.** Not a user-visible outage. The vm-agent classified an expected teardown race as a
platform error, so 224 of 234 vm-agent error incidents over six days were noise. That noise was
dispatched to the automated triage lane, where it consumed the diagnosis budget — nine of the ten
incidents in the triggering dispatch window carry `lastFailureReason` values like
`Per-run debugging token ceiling reached` and `Daily deployment debugging budget exhausted`. The
real signals in that window were starved by the noise.

**Root cause.** `startBackgroundSessionSnapshot` treated "the runner returned a non-nil error" as
"this is an incident". A background capture races workspace teardown by design — the coordinator
starts it, returns `202 Accepted`, and the workspace can stop while it runs — so a
container-already-gone error is the *expected* terminal state of that race, not a fault.

**Why it was not caught.** No test asserted anything about *which* failures should reach the error
reporter; the pre-existing snapshot tests only covered dedup, ordering, and the
generation-scoped callback. There was no severity contract to violate, so nothing went red.

**Class of bug.** A fault-classification boundary with no explicit "expected failure" set: every
error is escalated because nobody enumerated which ones are normal. The sibling class, and the one
the first cut of this PR walked into, is fixing that by *widening a shared predicate that already
drives an action* — `isContainerUnavailableError` triggers workspace recovery at three call sites,
so reusing it as a noise classifier silently changes what those three sites do.

**Process fix.** `.claude/rules/67-shared-predicates-that-trigger-actions.md` — before reusing a
predicate, enumerate its callers and check whether it is a *classifier* (answers a question) or a
*trigger* (drives an action). Never widen a trigger to serve a classification purpose; compose a
new named predicate instead.

## References

- `.claude/rules/24-no-duplicate-ui-controls.md`, `.claude/rules/59-understand-before-adding.md`
- `.claude/rules/39-debug-before-redesign.md` — measure before silencing
- `.claude/rules/62-tests-must-observe-the-real-trigger.md` — prove the guard discriminating
- `.claude/rules/27-vm-agent-staging-refresh.md` — nodes must be recycled to pick up a new binary
- `.claude/rules/47-control-loop-io-budget.md` — incident-queue budget is capacity, not disposition
- Policies `a3780107` (preserve work across runtime loss), `d08d64dc` (snapshot failures surface
  visibly), `a63e6a68` (shared Hetzner capacity)
