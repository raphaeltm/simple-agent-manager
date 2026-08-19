# A Guard Added for One Runtime Must Be Enforced for Every Runtime

## When This Applies

Any time SAM has **more than one execution substrate for the same user-visible
operation** and a correctness guard lives on only one of them. Today that means
the two workspace runtimes:

| | VM (`runtime: 'vm'`) | Instant (`runtime: 'cf-container'`) |
| --- | --- | --- |
| Orchestrator | `TaskRunner` DO (`durable-objects/task-runner/`) | `services/instant-session.ts` |
| Agent | full vm-agent + `internal/bootstrap` | standalone vm-agent (`internal/server/standalone_workspace.go`) |
| Entry points | `routes/tasks/submit.ts`, `startTaskRunnerDO`, `session-recovery.ts` | `routes/chat-start.ts`, `routes/mcp/dispatch-instant.ts` |

It applies equally to any future substrate split (a third runtime, a "lite"
provisioning path, a replay/recovery path that re-does provisioning).

## Why This Rule Exists

On 2026-06-02 `ensureBranchExists()` shipped to fix `git clone --branch` failing
on a not-yet-pushed output branch. It was wired into the TaskRunner DO. It
worked: production `tasks` rows with
`error_message LIKE '%not found in upstream origin%'` show **26 failures from
2026-03-16 and then zero after 2026-06-02**.

Eight weeks later MCP `dispatch_task` gained an Instant branch
(`dispatch-tool.ts` → `launchDispatchedInstantSession`). It passes the same
freshly generated `sam/<slug>-<suffix>` branch to a runtime that never got the
guard, and whose clone has no base-branch fallback. **The identical bug came
back**: 35 more production failures between 2026-07-29 and 2026-08-19, 30 of them
in August alone, across multiple projects.

Nothing was wrong with either the guard or the new code path in isolation. The
defect was purely that a *cross-cutting precondition* lived at a
runtime-specific altitude, so adding a runtime silently opted out of it.

## Class of Bug

**A precondition implemented per-orchestrator instead of per-operation.** The
tells:

- A guard, validation, or setup step that lives in `durable-objects/task-runner/`
  or `services/instant-session.ts` but describes a property of the *repository,
  project, or task* rather than of that orchestrator.
- A doc comment that generalises ("this is called before workspace provisioning
  to prevent git clone failures") attached to a function with exactly one caller.
- A new runtime branch (`if (isInstantRuntime) { ... } else { ... }`) where the
  two arms call different setup helpers.
- Best-effort error handling ("the clone will produce the definitive error")
  whose safety silently depends on a fallback that only one runtime has.

## Hard Requirements

1. **Cross-runtime preconditions live in `services/`, not in an orchestrator.**
   If a guard is about the repository, the project, the branch, credentials, or
   the task — not about how that particular orchestrator is built — it belongs in
   a shared service that every runtime calls. One implementation, not two
   (rules 24 and 59).

2. **Enumerate every runtime that performs the operation before merging.** Adding
   or changing a provisioning precondition requires listing each substrate and
   stating, per substrate, that it calls the guard or why it does not. This is the
   provisioning analogue of rule 44's "enumerate every writer".

3. **Best-effort is a per-runtime decision and must be justified against that
   runtime's fallback.** A guard may be advisory only where a downstream fallback
   genuinely recovers. `bootstrap.go:ensureRepositoryReady` clones `BaseBranch`
   and then `git checkout -b`s the target, so a failed ensure is survivable on
   VMs. `cloneStandaloneRepository` has no such path, so the same failure is
   terminal and the guard must fail closed. Write the reason in a comment naming
   the fallback.

4. **Distinguish "known bad" from "could not check", and only ever fail on the
   former.** A guard that cannot run (missing installation row, API 5xx,
   unsupported provider) has learned nothing. Turning that into a hard failure
   converts working launches into broken ones. Return a structured outcome —
   `missing` (positive evidence the operation will fail) vs `unknown` — and gate
   the refusal on `missing` alone.

5. **Prefer making the precondition durable over making one call site tolerant.**
   Creating the ref on the remote fixes the initial clone *and* every later
   re-clone (snapshot restore/wake in `session_snapshot.go`, worktrees, the final
   push). A tolerant clone would fix only the first one.

## Required Tests

- **Ordering test on the new runtime**: the guard runs *before* any resource is
  allocated (node record, workspace row, container). Asserting only "the guard was
  called" permits the wasteful ordering the guard exists to eliminate.
- **Fail-closed test**: on `missing`, nothing is allocated and the error names the
  offending value. Prove it fails against pre-fix code.
- **No-regression tests**: `unknown` and `skipped` both proceed.
- **Discriminating control on the OTHER runtime**: assert the runtime that is
  deliberately best-effort still does NOT throw. Verify it goes red if the
  fail-closed behaviour is copy-pasted across. Without this, a later "make it
  consistent" refactor breaks VMs with a green suite.
- **Thrown-check test**: make the guard's own dependency *throw* (rejected fetch,
  failed token mint, failed DB read), not merely return an error status, and
  assert it degrades to `unknown`. An unguarded `await` here silently converts
  requirement 4 into a lie — this is exactly what review caught in the first cut
  of this fix.
- **Machine-checked enumeration**: requirement 2 must not rely on reviewer
  diligence. Add a test that scans the source tree for the provisioning call and
  asserts every file either runs the guard or sits on an explicit allowlist with
  a written reason — see
  `apps/api/tests/unit/services/workspace-branch-guard-coverage.test.ts`. Assert
  a non-trivial minimum file count so a broken scan cannot pass as "all clear"
  (rule 02), and verify it goes red when an unguarded caller is added.

## Quick Compliance Check

- [ ] The precondition lives in `services/`, called by every runtime
- [ ] Every substrate that performs this operation is enumerated in the PR
- [ ] Per-runtime best-effort vs fail-closed is justified against a named fallback
- [ ] `missing` and `unknown` are distinct; only `missing` blocks
- [ ] Ordering, fail-closed, no-regression, thrown-check, and other-runtime control tests exist
- [ ] An enumeration test makes requirement 2 machine-checked, and was verified to go red
- [ ] The fail-closed test was verified to fail on pre-fix code

## References

- Task: `tasks/active/2026-08-19-ensure-branch-exists-before-instant-workspace.md`
  (moves to `tasks/archive/` on completion)
- Prior art (the VM-only fix this rule exists to have generalised):
  `tasks/archive/2026-06-02-ensure-branch-exists-before-clone.md`
- Implementation: `apps/api/src/services/workspace-branch.ts`
- `.claude/rules/44-dual-write-migration-enumerate-writers.md` — enumerate every writer/path
- `.claude/rules/24-no-duplicate-ui-controls.md`, `.claude/rules/59-understand-before-adding.md` — one implementation per operation
- `.claude/rules/54-vm-agent-rollout-compatibility.md` — why an agent-side fix is rollout-coupled
- `.claude/rules/11-fail-fast-patterns.md` — fail closed at boundaries
