# Recover, rebase, and land the harness-background-work sleep fix

## Problem statement

Production kills long-running task sessions because "the ACP prompt turn ended" is treated as "the
agent is idle". An orchestrator that launches a background poller or subagent and then returns its
top-level ACP prompt reports `idle`; the session-sleep sweep snapshots it after
`SESSION_SLEEP_AFTER_MS` (15 min default), deletes the workspace, and the stuck-task reconciler
terminalizes the task as `failed` ("conclusively gone (workspace_deleted)"). Roughly 15 task kills
since 2026-08-13, including the fix task for this very bug and its parent.

The fix was already written in full on branch `sam/use-sam-mcp-tools-xr5m1p` (tip `ec4af84d9`,
2026-08-16 15:12Z, 12 commits, 121 files, +9,207 lines) but never opened as a PR — the authoring
agent was killed by the 8-hour ACP prompt timeout at the Phase 4/5 boundary. **This task recovers
that work, rebases it onto current `main`, and lands it. It does not rewrite the design.**

The recovered task file (branch-only, self-archived) is
`tasks/archive/2026-08-16-prevent-hidden-harness-work-sleep-and-add-durable-task-waits.md`, which
carries the full architecture, research findings, incident post-mortem, and implementation checklist.
That checklist is entirely `[x]` with recorded green `pnpm lint/typecheck/test/build`, 7,341 API
tests, 640 workerd tests, and `go test -race`.

## Research findings

### F1. Nothing from the branch exists on `main` — VERIFIED

`git grep 'wait_for_subtasks|runtimeWorkState|harnessWork|HARNESS_BACKGROUND_WORK' origin/main`
returns only two documentation hits, both explicitly stating the capability is **not** implemented:

- `apps/www/src/content/docs/docs/reference/configuration.md:645` — "…parent wake behavior, and
  `wait_for_subtasks` remain disabled."
- `tasks/active/2026-08-09-worker-projectdata-durability-foundation.md:7` — "It deliberately does not
  … add `wait_for_subtasks`."

→ Both must be updated by this change (see checklist). This is a docs-sync obligation, not just a
grep artifact.

### F2. The migration collision is in the name-keyed SQLite ledger, NOT wrangler's positional array

The task brief anticipated a positional `[[migrations]]` hazard per `.claude/rules/07`. **Verified
that hazard does not apply here:** `apps/api/wrangler.toml`'s `[[migrations]]` blocks are byte-identical
between `origin/main` and the branch (no new DO class, no `new_sqlite_classes` entry).

The real collision is `apps/api/src/durable-objects/migrations.ts`:

| Side | Migration(s) |
|------|--------------|
| `main` (PR #1840, `6ab27592`, merged 2026-08-16 23:25Z) | `029-session-activity-reconciliation` — **IMMUTABLE, deployed to production** |
| branch | `029-harness-work-and-task-waits`, `030-task-wait-replay-hardening` |

`runMigrations()` (`migrations.ts`) tracks applied migrations **by name** in a `migrations` table
(`name TEXT PRIMARY KEY`) and skips already-applied names while iterating `MIGRATIONS` in array
order. So renumbering is safe **iff no deployment has already recorded the branch's names**.

### F3. The branch was never deployed anywhere — renumbering is safe — VERIFIED

The branch's own `030` carries a defensive comment ("development/staging Durable Objects may already
have recorded migration 029 from an earlier branch build"). Verified this is not the case: an
unfiltered `gh run list --workflow=deploy-staging.yml --limit=60` covering 2026-08-09 onward shows
**zero** runs for `sam/use-sam-mcp-tools-xr5m1p`. The branch never reached staging, and it was never
merged, so no ProjectData DO in any environment has `029-harness-work-and-task-waits` recorded.

→ Renaming branch `029`→`030` and `030`→`031`, appended after main's `029`, is safe for both a clean
bootstrap and an existing deployment at the latest applied tag. Both paths must still be tested.

### F4. Main's #1840 and the branch are ADDITIVE on the same rows, not competing designs

This was the main risk flagged in the brief ("reconcile the two designs rather than clobbering
#1840's reconciled-activity work"). Verified by reconnaissance rebase: **6 conflicted files, every
conflict additive.** The two changes annotate the same `session_state` row and the same
INSERT/SELECT statements with **disjoint** column sets:

- #1840 (main): `activity_source`, `activity_reason`, `activity_probe_at`, `activity_probe_attempts`
  — *provenance + why a session left a working state*, so a stale working state can be probed
  against the vm-agent rather than trusted indefinitely.
- branch: `runtime_work_state`, `runtime_work_count`, `runtime_work_source`,
  `runtime_work_updated_at`, `runtime_work_progress_at` — *normalized harness-owned background work*.

No column name overlaps. Resolution for each conflict is "keep both sides", not "pick one":

| File | Conflict | Resolution |
|------|----------|-----------|
| `durable-objects/migrations.ts` | both define `029` | keep main's `029`; append branch's as `030` + `031` |
| `project-data/session-state.ts` (4 hunks) | both extend the same INSERT/UPSERT/SELECT + row mapper | merge both column sets into each statement |
| `project-data/alarm-schedule.ts` | `computeSessionActivityProbeAlarmTime` vs `computeTaskWaitAlarmTime` | keep both in the alarm `min()` candidate set |
| `shared/src/types/session.ts` | both extend `SessionStateSnapshot` | keep both field groups |
| `routes/mcp/index.ts` | main added `handleListTriggers`; branch added `handleWaitForSubtasks` | keep both imports |
| `tests/unit/.../migrations.test.ts` | index count 49 (main) vs 50 (branch) | recompute combined total; assert empirically |

The two designs are complementary: #1840 answers "is the recorded activity trustworthy?", the branch
answers "is there agent-initiated work the ACP turn never revealed?". Both feed the same sleep gate.

### F5. Canonical idle semantics (Raphaël, 2026-08-17) — the bar this must meet

A session is IDLE only when the agent has handed control back to the user **and** nothing it started
is still running: no tool call still executing, no sub-agent still running, agent itself doing
nothing. **Long-lived side effects the agent started but is not interacting with do NOT block
idleness** — an abandoned `run_in_background` dev server must not pin the session awake. The
discriminator is "is an agent-initiated unit of work still in flight and expected to return to the
agent", not "is any process alive on the box".

→ **Open design risk to verify and report explicitly:** Claude's `background_tasks_changed` set can
plausibly include an abandoned dev server. Must confirm the finite lease
(`DEFAULT_HARNESS_BACKGROUND_WORK_LEASE_MS`, 5 min) plus absolute ceiling actually bound this, and
state plainly in the PR what happens to a session whose only background task is an abandoned server.
Do not paper over it.

### F6. Known coverage limits — document, do NOT fix here

- Detection is Claude-Code-only (adapter source `claude_sdk`, via `_claude/sdkMessage`). Codex and
  OpenCode sessions get no background-work signal at all.
- ACP's own terminal methods (`CreateTerminal`, `TerminalOutput`, `WaitForTerminalExit`) are
  hard-stubbed "not supported" in `session_host_client.go`, so background shells are invisible
  harness-agnostically.
- `message_extract.go` already parses `ToolCall`/`ToolCallUpdate` status
  (pending/in_progress/completed) but only persists it as chat-message metadata — an existing
  harness-agnostic signal a future unified predicate could consume.

→ File a SAM idea covering all three; document in the PR. Out of scope for this change.

### F7. Scope boundaries

- **Do NOT modify** `apps/api/src/scheduled/stuck-tasks.ts` or `task-runtime-liveness.ts` — owned by
  parallel task `01M07P0C3A83HACDVHHYC8TW3K` (branch `sam/land-already-written-fix-c8tw3k`). Rebase
  onto main again before merge if it lands first.
- Unifying **all** shutdown timers onto one shared idle predicate is deliberately out of scope.
- Branch `sam/terminal-sleep-authoritative` (2026-08-13, unmerged) moves the same sleep predicate in
  the *opposite* direction (sleep completed-task sessions more aggressively). Assess whether it is
  superseded and recommend keep/drop in the PR description. **Do not merge it.**

## Implementation checklist

- [x] Rebase `ec4af84d9` onto `origin/main`, resolving all 6 conflicts additively per F4
- [x] Renumber branch migrations `029`→`030-harness-work-and-task-waits`,
      `030`→`031-task-wait-replay-hardening`, appended after main's `029`; update the `030` comment
      that references the stale `029` name
- [x] Update `apps/api/tests/unit/durable-objects/migrations.test.ts` index/table counts to the
      combined total; assert empirically rather than by arithmetic
- [x] Verify DO migration clean-bootstrap AND existing-deployment-at-latest-tag paths both pass
- [x] Run `scripts/quality/do-migration-compatibility.test.ts` and the DO migration safety gate
- [x] Confirm `session_state` row mapper + INSERT/UPSERT/SELECT carry BOTH #1840 and harness columns
- [x] Confirm both `computeSessionActivityProbeAlarmTime` and `computeTaskWaitAlarmTime` remain in
      the alarm candidate set
- [x] Verify sleep gate rejects fresh active/settling work at BOTH the pre-claim and
      point-of-no-return checks in `session-sleep.ts`
- [x] Verify the abandoned-dev-server case is bounded by the finite lease (F5); document the exact
      behavior in the PR description
      → **It was NOT bounded.** The sliding lease reads `runtimeWorkUpdatedAt`, which the VM agent's
      periodic re-report refreshes, so an adapter re-reporting a stale task set renewed it forever.
      Fixed by adding an absolute ceiling anchored on the progress clock
      (`HARNESS_BACKGROUND_WORK_MAX_DURATION_MS`, default 30 min). Independently found by the
      security-auditor and test-engineer reviews.
- [x] Update the two stale docs from F1 that assert `wait_for_subtasks` is disabled
- [x] Open a DRAFT PR as soon as the rebase builds green (hard requirement — durable artifact)
- [x] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` green
- [x] `go test -race ./...` green in `packages/vm-agent`
- [ ] File SAM idea for the F6 coverage gaps
- [ ] Phase 5 specialist review: go-specialist, cloudflare-specialist, security-auditor,
      test-engineer, task-completion-validator — all PASS/ADDRESSED
- [ ] Phase 6: delete ALL staging nodes BEFORE deploy (rule 27), provision a FRESH VM, demonstrate
      real Claude background-task lifecycle reporting deferring sleep, verify no raw-payload or
      secret leakage in logs, then delete every staging node/workspace (Hetzner 10-server shared cap)

## Acceptance criteria

Inherited from the recovered task file, plus rebase-specific criteria:

- A Claude background shell or subagent that outlives the top-level ACP prompt keeps the session
  ineligible for automatic sleep while its finite runtime-work lease is fresh.
- An abandoned background process does NOT pin the session awake indefinitely — the finite lease and
  absolute ceiling bound it, and the PR states the exact observed behavior.
- Runtime heartbeat, harness lifecycle progress, ACP prompt activity, and absolute task deadlines
  remain distinct clocks.
- No raw Claude SDK payload content is logged, persisted, broadcast, or sent to the control plane.
- Missing extension support is backward-compatible: non-Claude sessions retain existing ACP behavior
  and finite idle cleanup.
- A parent can wait for direct child tasks with `all`/`any`, end its prompt, and receive exactly one
  durable wake prompt after satisfaction or deadline.
- **PR #1840's reconciled-activity behavior is preserved, not clobbered** — its columns, probe
  accounting, and staleness scan remain functional alongside the harness-work columns.
- New migrations pass clean-install AND previous-ledger upgrade tests.
- A fresh staging VM demonstrates real Claude lifecycle reporting deferring sleep, with zero staging
  VMs remaining afterward.
- CI green, PR merged, production deployment for the merged SHA succeeds.

## References

- Recovered task file: `tasks/archive/2026-08-16-prevent-hidden-harness-work-sleep-and-add-durable-task-waits.md` (on `sam/use-sam-mcp-tools-xr5m1p`)
- Colliding PR #1840 (`6ab27592`) — `029-session-activity-reconciliation`
- Ready idea `01KZK586BN98BRDGKC44V12HT0`; SAM parent session `36a5bb77-2746-43c1-8669-030b51b8f36d`
- `.claude/rules/27-vm-agent-staging-refresh.md` — delete all nodes before vm-agent staging tests
- `.claude/rules/54-vm-agent-rollout-compatibility.md` — version-aware rollout
- `.claude/rules/31-migration-safety.md`, `.claude/rules/07-env-and-urls.md` — migration safety
- `.claude/rules/57-write-only-cross-boundary-state.md` — the reconciliation rule #1840 implements
- ACP extensibility: https://agentclientprotocol.com/protocol/v1/extensibility
