# Ensure the checkout branch exists before spinning up an Instant (cf-container) workspace

## Problem

Dispatching a task to the Cloudflare Container ("Instant") runtime fails with a raw node-agent 500:

```
Node Agent request failed: 500 {"error":"standalone git clone failed: exit status 128:
Cloning into '/workspaces/simple-agent-manager'...
fatal: Remote branch sam/fix-chat-fontmarkdown-regression-6gtq6t not found in upstream origin"}
```

The missing branch is always the task's own freshly generated **output branch**. The control plane
generates `sam/<slug>-<suffix>`, hands it to the container as the clone branch, and the container
runs `git clone --branch sam/...` against a remote where that ref has never existed. A container is
allocated and billed, then the task dies with an opaque error.

## Production Evidence (prod D1, account `e2eb9a8d…`, db `a8923a52…`)

`SELECT ... FROM tasks WHERE error_message LIKE '%not found in upstream origin%'` → **61 rows**,
which split cleanly into two eras:

| Variant | Count | First | Last |
| --- | --- | --- | --- |
| `git clone failed` (VM runtime) | 26 | 2026-03-16 | **2026-06-02** |
| `standalone git clone failed` (cf-container runtime) | 35 | **2026-07-29** | 2026-08-19 |

The VM variant stops dead on 2026-06-02 — the day `tasks/archive/2026-06-02-ensure-branch-exists-before-clone.md`
shipped `ensureBranchExists()`. The standalone variant starts 2026-07-29, when MCP `dispatch_task`
gained the Instant branch, and is still firing: **30 failures in August 2026 alone**, most recently
task `01M0CT3K97K5EXD52MMC6GTQ6T` (2026-08-19T10:47Z, output branch
`sam/fix-chat-fontmarkdown-regression-6gtq6t`). It is not SAM-specific — e.g. task
`01M0087KGMA0D376C5QBRHSR14` cloning `/workspaces/effprop-backend`.

So this is a **regression of an already-fixed bug on a sibling code path**, not a new defect.

## Research Findings

### The two runtimes diverge on branch handling

| | VM runtime | Instant (cf-container) runtime |
| --- | --- | --- |
| Pre-provision guard | `ensureBranchExistsOnRemote()` — `durable-objects/task-runner/workspace-steps.ts:230` | **none** |
| Clone request fields | `branch` + `baseBranch` + `defaultBranch` — `workspace-steps.ts:309-324` | `branch` only — `services/instant-session.ts:352-374` |
| Agent clone | `bootstrap.go:826-842` clones `BaseBranch`, then `createCheckoutBranch()` → `git checkout -b <branch>` | `standalone_workspace.go:99-124` clones `--branch <branch>`; `runtime.BaseBranch` is **never read** |

The VM runtime therefore has **two** independent defenses (pre-create the ref, and a base-branch
fallback in the agent). The Instant runtime has **zero**.

### Exact bug path

1. `routes/mcp/dispatch-tool.ts:308` — `generateBranchName(...)` → `branchName = sam/<slug>-<suffix>` (brand new).
2. `dispatch-tool.ts:362` — `const checkoutBranch = explicitBranch || branchName;`
3. `dispatch-tool.ts:503` — `branch: checkoutBranch` → `launchDispatchedInstantSession`
   (`routes/mcp/dispatch-instant.ts:80`) → `launchInstantSession`.
4. `services/instant-session.ts:195` — `const branch = input.branch?.trim() || project.defaultBranch || 'main';`
   (the generated name wins) → stored on the workspace row (`:226`) and posted to the node
   (`:361`) with no `baseBranch`.
5. `packages/vm-agent/internal/server/standalone_workspace.go:115` —
   `args = append(args, "--branch", branch, cloneSpec.URL, workDir)` → exit 128 → 500 at `:124`.

`routes/chat-start.ts` (browser Instant chat) passes **no** branch, so it falls through to
`project.defaultBranch` and has always worked. Only the MCP-dispatch → Instant combination is broken,
which is why the failure looked intermittent.

### Existing pieces to reuse (do NOT write a third implementation)

- `services/github-app.ts:1085` `ensureBranchExists(installationId, owner, repo, branch, defaultBranch, env)` —
  `GET /repos/:o/:r/branches/:b`, else `GET git/ref/heads/:default` for the SHA, else
  `POST git/refs`; treats 422 as a race win. Returns a bare boolean.
- `services/gitlab.ts:586` `ensureGitLabBranchExists({env, userId, projectId, branch, ref})`.
- `durable-objects/task-runner/workspace-branch.ts:12` `ensureBranchExistsOnRemote()` — the
  provider routing (`artifacts` skip / `gitlab` branch / GitHub default), installation lookup
  (`getExternalInstallationId`), and best-effort error swallowing. Tightly bound to
  `TaskRunnerState`/`TaskRunnerContext` and `rc.assertRecoveryAuthority`.
- Tests: `tests/unit/services/ensure-branch-exists.test.ts`,
  `tests/unit/durable-objects/task-runner/ensure-branch-on-remote{,-token}.test.ts`,
  `tests/unit/services/instant-session.test.ts`, `tests/unit/routes/mcp-dispatch-instant.test.ts`.

### Why fix the control plane rather than the agent

Making `cloneStandaloneRepository` accept a base branch would also work, but:

- it needs a vm-agent/container-image rollout (rule 54) whereas the Worker fix ships immediately;
- the branch would still not exist on the remote, so every **later** re-clone breaks too —
  `session_snapshot.go:411` re-clones `runtime.Branch` on snapshot restore/wake;
- the fix that already works for VMs is a control-plane pre-condition, and reusing it keeps one
  implementation instead of two (rules 24, 59).

Creating the ref up-front makes the branch durable for the clone, the wake re-clone
(`packages/vm-agent/internal/server/session_snapshot.go:411` re-runs
`prepareStandaloneWorkspaceRuntime` → `cloneStandaloneRepository` on restore), and the eventual push.

**This control-plane fix is not complete on its own.** When a project's `github_installations` row
is owned by a different member than the dispatching user — a real, shipped multiplayer scenario
(`schema.ts` `project_members`) — the guard reports `unknown` and does nothing, so that population
still hits the original clone failure. For them the deferred agent-side `baseBranch` fallback is not
defense in depth, it is the only remaining fix. Both gaps are tracked
(`01M0D1K634N0X3PZE8ECZYCTVH`, `01M0D1JSX5W76CEFZSD2J43S7W`); deferring them is a rollout/security
scoping decision (rules 54, 28), not a claim that the bug is fully closed.

### Fail fast vs. best-effort

The DO wrapper is deliberately best-effort ("the clone will produce the definitive error") and that
is correct **for VMs**, because `bootstrap.go` recovers via `BaseBranch`. The standalone clone has no
such fallback: if the ref cannot be confirmed or created, the clone is *guaranteed* to fail. So the
Instant path must fail closed, before allocating a container — same outcome, no wasted container, and
an actionable message instead of a raw 500. VM behaviour must stay best-effort (verified by a
discriminating control test).

## Implementation Checklist

- [x] Extract the provider-aware ensure logic into a shared service
      `apps/api/src/services/workspace-branch.ts`, returning a structured result
      (`exists` / `created` / `skipped` / `unavailable` + reason) instead of a bare boolean
- [x] Re-point `durable-objects/task-runner/workspace-branch.ts` at the shared service; keep the
      DO-only concerns (recovery-authority assertion, `task_runner_do.ensure_branch.*` logs,
      best-effort swallow) in the wrapper. No behaviour change for VMs.
- [x] Call the shared helper from `acceptInstantSession()` (`services/instant-session.ts`) **before**
      `createNodeRecord()`, i.e. before any container is allocated
- [x] Short-circuit when the resolved branch equals the project default branch, so the browser
      Instant chat path adds zero latency and zero GitHub API calls
- [x] Throw a clear, actionable error (naming the branch and the reason) when the branch cannot be
      ensured, so the task fails fast with an actionable message before any container is allocated,
      instead of a later opaque node-agent 500 discovered mid-clone. (NB: in production
      `handleDispatchTask` runs the launch under `execCtx.waitUntil`, so the MCP tool call has
      already returned; the error surfaces on the task via `markQueuedTaskFailed`, not as a
      synchronous JSON-RPC error.)
- [x] All timeouts/limits configurable — no hardcoded values (Principle XI)
- [x] Tests (see Acceptance Criteria)
- [x] Post-mortem + process fix in `.claude/rules/` targeting the *class* of bug
- [x] File SAM ideas for everything deferred: `01M0D1JSX5W76CEFZSD2J43S7W` (agent-side `baseBranch`
      fallback), `01M0D1K634N0X3PZE8ECZYCTVH` (shared-installation no-op),
      `01M0D2PM547J75PCP7XQ7NPRQJ` (phantom `output_branch` on explicit-branch Instant dispatches)
- [x] Address review findings: guard the GitHub/GitLab arms so a THROWN check degrades to `unknown`
      instead of hard-failing the launch; validate the branch name server-side before any ref write;
      add the provisioning-path enumeration test that makes rule 61 machine-checked

## Acceptance Criteria

- [x] Dispatching an Instant task with a freshly generated output branch ensures the ref on the
      remote before the container is launched — `instant-session-branch-vertical-slice.test.ts`
      asserts the exact GitHub URLs + create-ref body. "and the clone succeeds" remains staging-only.
- [x] **Discriminating regression test**: an Instant launch whose branch differs from the default
      branch must call the ensure helper *before* `createNodeRecord`/`createWorkspaceOnNode`. The
      test must fail against the pre-fix code.
- [x] When the branch cannot be ensured, no node record / workspace row / container is created and
      the error names the branch — `instant-session-branch-guard.test.ts`
- [x] **Control test**: branch === project default branch → no GitHub API call at all —
      `workspace-branch.test.ts` + vertical slice (`expect(fetchMock).not.toHaveBeenCalled()`)
- [x] **Control test**: VM path stays best-effort — a failing ensure does not throw; verified
      discriminating (making the DO fail-closed turns it red)
- [x] Provider coverage on the shared helper: GitHub exists / created / missing / unknown / thrown,
      GitLab created / exists / unknown / thrown, `artifacts` skip, unparseable `owner/repo`,
      missing installation, cross-tenant installation + owner control, invalid ref names
- [x] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` green (7777 unit + 671 Miniflare
      worker tests, 0 collection errors)
- [~] Staging: **PARTIALLY VERIFIED — blocked on staging configuration.**
      - VERIFIED: the deployed shared guard creates a real ref on a real remote. Task
        `01M0D4KEMNYHZXW9TGDPCMBG71` on project `hono` (`serverspresentation2025/hono`) generated
        `sam/verify-branch-guard-print-cmbg71`; that branch appeared on the remote at the
        `workspace_ready` step (branch count 23 → 24) and the task completed successfully. This
        exercises `services/workspace-branch.ts`, the `github_installations` lookup, real GitHub App
        installation-token minting, and a real `POST git/refs` — the whole shared path both runtimes
        now use. Node + workspace deleted afterwards.
      - NOT VERIFIED: the Instant/cf-container leg. Staging has `CF_CONTAINER_ENABLED = false`
        (read from the deployed Worker settings), so `resolveWorkspaceRuntime`
        (`services/workspace-runtime.ts:61`) short-circuits every profile to VM. Confirmed
        empirically: `POST /api/projects/:id/sessions/start` with a `runtime='cf-container'` profile
        returns `409 "Selected profile resolves to VM runtime; use task submission instead."`
        The value comes from the staging GitHub Environment variable `vars.CF_CONTAINER_ENABLED`
        (`.github/workflows/deploy-reusable.yml:522`); the deploy script's own default is `'true'`
        (`scripts/deploy/sync-wrangler-config.ts:444`), so staging is an explicit operator opt-out —
        which also contradicts the project policy "Enable Cloudflare container instant runtime by
        default". A human must flip it before this leg can be verified.

## References

- Prior art (VM-only fix): `tasks/archive/2026-06-02-ensure-branch-exists-before-clone.md`
- `.claude/rules/44-dual-write-migration-enumerate-writers.md` — enumerate every path that needs the guard
- `.claude/rules/24-no-duplicate-ui-controls.md`, `.claude/rules/59-understand-before-adding.md` — one implementation per operation
- `.claude/rules/35-vertical-slice-testing.md` — realistic cross-boundary state
- `.claude/rules/54-vm-agent-rollout-compatibility.md` — why the agent-side fallback is deferred
- `.claude/rules/11-fail-fast-patterns.md` — fail closed at the boundary


## Post-Mortem

**What broke.** Every MCP-dispatched Instant (cf-container) task failed with
`Node Agent request failed: 500 … standalone git clone failed: exit status 128 … fatal: Remote
branch sam/<slug>-<suffix> not found in upstream origin`, after a container had already been
allocated. 35 production tasks, 2026-07-29 → 2026-08-19, 30 of them in August, across multiple
projects.

**Root cause.** `dispatch-tool.ts:362` sets `checkoutBranch = explicitBranch || branchName`, where
`branchName` is a branch generated moments earlier and never pushed. The VM runtime tolerates that
because `TaskRunner` pre-creates the ref (`ensureBranchExistsOnRemote`) *and* `bootstrap.go` clones
`BaseBranch` then `git checkout -b`s the target. The Instant runtime does neither: it forwards only
`branch`, and `cloneStandaloneRepository` runs a bare `git clone --branch`.

**Timeline.** The identical failure existed on VMs from 2026-03-16 (26 tasks) and was fixed on
2026-06-02 by `tasks/archive/2026-06-02-ensure-branch-exists-before-clone.md` — zero VM occurrences
since. The Instant dispatch branch landed ~8 weeks later without the guard, and the same bug
reappeared on 2026-07-29. It ran for three weeks before being reported.

**Why it wasn't caught.** The guard was written at a runtime-specific altitude (inside the TaskRunner
DO) even though it expresses a property of the repository, not of that orchestrator — its own doc
comment generalises ("called before workspace provisioning") while having exactly one caller. Adding
a runtime therefore opted out of it silently. No test asserted the precondition at the
operation level, so the Instant path could be added with a fully green suite. The failure was also
easy to misread as intermittent: `chat-start.ts` passes no branch and so was never affected.

**Class of bug.** A cross-cutting precondition implemented per-orchestrator instead of per-operation,
so a newly added execution substrate silently skips it. Sibling of `.claude/rules/44`'s
"enumerate every writer", applied to provisioning paths rather than storage writers.

**Process fix.** New `.claude/rules/61-guards-must-cover-every-runtime.md`: cross-runtime
preconditions live in `services/` and are called by every substrate; every substrate must be
enumerated in the PR; per-runtime best-effort must be justified against a *named* fallback;
"known bad" (`missing`) must be distinguished from "could not check" (`unknown`) and only the former
may block; and the test matrix must include a discriminating control on the runtime that is
deliberately best-effort, so a later "make it consistent" refactor cannot break it with a green suite.
