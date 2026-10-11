# PR Shepherd: leave PRs owned by active tasks to their owner

- SAM task: `01M4MZTACYDRW4B3SC9S99DJN8` (reliability wave D, channel `reliability-wave-1011`)
- Idea: `01M496QHP8MY2S8W3F2BJPV2XN`
- Trigger: `01KPED8FFDM34EZNNFTW672S5E` ("PR Shepherd (steady-state blitz)", cron `0 */6 * * *`,
  profile `01KTX849BEN08SNZ84H0DJJDZD`). **Paused by the wave coordinator. Do not resume it.**

## Problem

The PR Shepherd prompt only checks for another running Shepherd. Nothing checks whether an
active task already owns a PR before bucket 1 (merge) or bucket 2 (dispatch a completion task).

- 2026-10-06: Shepherd run `01M496307Q35BZA1X2K9HPDDRS` merged #2243 while completion task
  `01M493DKQER8TR2RQ2PHX0BTNM` was still working on it.
- 2026-10-08: Shepherd run #146 (`01M4EAS542DWEFEK5KWEVC365Y`) dispatched completion tasks for
  #2279 (`01M4EB22GQYH4KT6ZYX02X934D`) and #2276 (`01M4EB1RKGP1WNNFA60F3KDVTZ`) while their
  owners `01M4DV5NEPH267ZZ6WQJT83AZB` (sleeping) and `01M4DV45S0WXQETVAEPVJY5M2K` were active.
- Both earlier reliability waves had to pause the Shepherd.

## Research Findings

### What links a task to a PR (production D1, verified 2026-10-11)

| PR    | Head branch                                 | Owner task                                | Linked by                        |
| ----- | ------------------------------------------- | ----------------------------------------- | -------------------------------- |
| #2279 | `sam/cut-production-error-noise-t83azb`     | `01M4DV5NEPH267ZZ6WQJT83AZB`              | `output_branch` = head           |
| #2276 | `sam/failed-wake-leave-conversation-jy5m2k` | `01M4DV45S0WXQETVAEPVJY5M2K`              | `output_branch` = head           |
| #2243 | `sam/docs-update-2tahhd`                    | `01M493DKQER8TR2RQ2PHX0BTNM` (completion) | **workspace branch** = head only |

- `dispatch_task` stores the generated name in `tasks.output_branch`; an explicit `branch`
  (the PR head for completion tasks) only reaches the workspace row
  (`apps/api/src/routes/mcp/dispatch-tool.ts`, `checkoutBranch = explicitBranch || branchName`).
  All three incident completion tasks had `workspaces.branch` = PR head and a generated
  `output_branch` (`sam/complete-pr-2243-…`).
- `output_pr_url` is written only by `complete_task` (`routes/mcp/task-tools.ts`, both modes), the
  VM agent's end-of-turn `gitPushResult` (`routes/tasks/callback.ts`), or a user PATCH. An
  in-flight task-mode completion task has it NULL.
- The VM agent rewrites `output_branch` to the branch it pushed at the end of every successful
  task-mode turn (`packages/vm-agent/internal/server/server.go:makeTaskCompletionCallback` →
  `gitPushResult.branchName`).
- On wake, `session-recovery.ts` re-queues the same task with `workspace_id = NULL` until a new
  workspace exists; while asleep the old workspace row keeps its branch. The 32 recovery
  successors created since 2026-10-01 all kept their source's `output_branch`; none were created
  after 2026-10-04 (wakes now reactivate the task).
- Production has 0 rows with the legacy `status = 'awaiting_followup'` (it is now an execution
  step; those tasks are `in_progress`/`sleeping`). All 116 non-null `output_pr_url` values are
  canonical `https://github.com/<owner>/<repo>/pull/<n>` with no trailing slash.
- "Active" = `WAKEABLE_TASK_STATUSES` (`services/task-status.ts`): queued, delegated, in_progress,
  legacy awaiting_followup, sleeping. `list_project_agents` uses
  `AGENT_ACTIVITY_ACTIVE_TASK_STATUSES` (queued, delegated, in_progress, sleeping) and excludes
  superseded predecessors.

### Can the Shepherd's tools answer "which active task owns this PR"? (scope item 2)

| Tool                  | Fields                        | Verdict                                                                                                                                                                                                                                                    |
| --------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_tasks`          | `outputBranch`, `outputPrUrl` | **No.** Its tool enum cannot request `sleeping` (it still lists the retired `awaiting_followup`), and for workspace agents it silently caps at 50 rows by `updated_at` with no cursor (`operations/task-core.ts:listTasks`). The #2279 owner was sleeping. |
| `search_tasks`        | same                          | **No.** Matches title/description only, same stale enum, max 20.                                                                                                                                                                                           |
| `list_project_agents` | `branch` (= `output_branch`)  | **Partly.** Every active task, uncapped, but no PR URL and no workspace branch, so it cannot see in-flight completion tasks (the #2243 class).                                                                                                             |

So a server-side capability is required.

### Other observations and late implementation delta

- The prompt's double-run check ("title starts with 'PR Shepherd'") never matches: run titles
  are generated as "Execute … PR Shepherd run …". Overlap is prevented by the trigger's
  `skipIfRunning=true` / `maxConcurrent=1`. Changing it to a substring match would also match
  this task's own title, so it is left as is.
- The retained late delta (`32c69e6f7`) replaces stale `list_tasks`/`search_tasks` enums with shared `TASK_STATUSES`, including `sleeping`/`ready`, and exposes workspace pagination (`hasMore`, `nextCursor`, `cursor`). It compensates for the hidden own task before computing the next page. These changes require independent delta review and live final-candidate schema verification.

## Design

Smallest capability that answers the question exactly, in one place:

1. `list_project_agents` gains optional `prHeadBranch` and `prUrl` arguments. When either is set,
   it returns only active agents that own that PR: output branch or workspace branch equals
   `prHeadBranch`, or output PR URL equals `prUrl`, or the description cites `prUrl` (union of all
   links). The description link covers a dispatched completion task that has no workspace yet
   (added after architecture review). The filter is SQL in
   the shared `listAgentActivityTasks` service, so the active-status set and superseded exclusion
   are reused rather than copied.
2. Each agent entry also returns `outputPrUrl` and `workspaceBranch`.
3. A filtered response echoes the applied `filter`, so "no owners" is distinguishable from "the
   server ignored the arguments" (fail closed in the prompt otherwise).
4. Invalid filter arguments are rejected (`INVALID_PARAMS`), never silently ignored.

Prompt change (minimal): an owner check before any action on a PR and again immediately before
each merge and dispatch; owned PRs are left alone and listed as `left-to-owner` in the digest;
`prHeadBranch` is passed only for same-repository PRs (SAM tasks cannot push to forks);
completion dispatches must pass `branch=<head>` and cite the full PR URL; a failed or
non-echoing owner check counts as owned. (The first draft's title-based secondary signal was
dropped after review: titles are AI-generated and need not keep the PR number.)

## Implementation Checklist

- [x] `services/agent-activity.ts`: select `t.output_pr_url`, `w.branch`; add `outputPrUrl`,
      `workspaceBranch` to `AgentActivityTask`; add optional PR-owner filter option and SQL
- [x] `routes/mcp/workspace-tools-direct.ts`: parse/validate `prHeadBranch`, `prUrl`; return new
      fields and the `filter` echo
- [x] `routes/mcp/index.ts`: pass `toolArgs` to `handleListProjectAgents` (one-line change)
- [x] `routes/mcp/tool-definitions-workspace-tools.ts`: document the arguments and fields
- [x] Real-route + real-SQL test: each disjunct, each active status, awaiting follow-up,
      terminal/ready/draft, superseded, cross-project, own-task, unrelated agent, no-filter, trim,
      invalid args, query failure, incident shapes
- [x] Prove each disjunct discriminating (delete it, the intended test goes red, restore)
- [x] Update existing mocked `mcp.test.ts` / `agent-activity.test.ts` expectations if needed (none
      needed: the 6 related suites, 304 tests, pass unchanged)
- [x] `.claude/skills/api-reference/SKILL.md`: document the filter; public agents guide MCP tool
      table gains a `list_project_agents` row
- [ ] Verify final candidate on staging through real MCP (historical deployment alone is insufficient)
- [x] Retain sleeping/status-enum and workspace pagination fixes plus real-route tests
- [x] Complete two independent Sol delta reviews of the late status/pagination changes (both code PASS at `310d89a7`; overall completion remains pending)
- [ ] Restore PR template, before/after prompt diff, and accurate preflight/review evidence
- [ ] (post-merge) After production deploy: run the owner check by hand through production MCP
      against the open PRs and active tasks; compare with the D1 query. Evidence: PR comment + idea
- [ ] (post-merge) `update_trigger` with `promptTemplate` only; verify every other field is
      unchanged and the trigger is still `paused`. Evidence: PR comment + idea
- [ ] PR body: full before/after prompt diff
- [ ] (post-merge) Update idea `01M496QHP8MY2S8W3F2BJPV2XN` with outcome

## Implementation Notes

- Test: `apps/api/tests/integration/list-project-agents-pr-owner.test.ts` (27 tests) drives
  `POST /mcp` `tools/call list_project_agents` against a real SQLite D1; only KV is in memory.
- Discrimination (each mutation applied alone, then restored; `.tmp/discriminate.py`):

| Mutation                                      | Red tests                                                                              |
| --------------------------------------------- | -------------------------------------------------------------------------------------- |
| drop `t.output_branch` link                   | 15 (incl. every active-status case, superseded, cross-project, trim)                   |
| drop `w.branch` link                          | 3: exact-owners, #2243 completion-task shape, trim                                     |
| drop `t.output_pr_url` link                   | 5: exact-owners, PR-URL-only, both awaiting-follow-up cases, empty-filter control      |
| drop description link                         | 4: exact-owners, PR-URL-only, description-only, empty-filter control                   |
| drop empty-filter refusal                     | 1: empty owner filter                                                                  |
| router ignores arguments (pre-fix shape)      | 11: every filtered case with an unrelated agent present, the echo, 4 malformed filters |
| drop `w.project_id = t.project_id` join guard | 1: cross-project workspace row                                                         |
| drop prUrl trailing-slash normalization       | 2: trailing-slash URL, `/`-only URL                                                    |
| drop trim                                     | 2: surrounding-whitespace match, whitespace-only rejection                             |
| swallow query failure as an empty list        | 1: failed owner query surfaces as an error                                             |

- `pnpm turbo run typecheck` injected a turborepo block into root `AGENTS.md`; reverted, not committed.

## Review Outcomes and Decisions

| Reviewer                  | Result          | Action                                                                                                                                                                                            |
| ------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| constitution-validator    | PASS            | none                                                                                                                                                                                              |
| cloudflare-specialist     | PASS, 3 LOW     | `prHeadBranch` only for same-repository PRs (a fork PR headed `main` would match tasks whose workspace is on `main`); normalized echo now asserted; unreachable empty-filter error class accepted |
| security-auditor          | PASS, 2 LOW     | no length cap (below); prompt-enforced fail-closed accepted, since `gh pr merge` runs outside SAM                                                                                                 |
| test-engineer             | PASS, 4 LOW     | added trim, normalized-echo, awaiting-follow-up and query-failure tests; legacy status (below)                                                                                                    |
| doc-sync-validator        | 1 MEDIUM, 1 LOW | `SKILL.md` no longer claims the trigger already uses the filter; `null` stays undocumented leniency                                                                                               |
| task-completion-validator | 1 MEDIUM, 2 LOW | staging runs before the PR (Phase 6); criteria 1-5 checked off with evidence; tense fixed                                                                                                         |
| architecture-reviewer     | 2 MEDIUM, 3 LOW | added the description link and dropped the title heuristic; `w.branch` resync limit documented; status list removed from the prompt; zombie owners (below)                                        |

- **No length cap on `prHeadBranch`/`prUrl`.** They are equality-checked echoes of GitHub values.
  `apps/api/.claude/rules/51-runtime-boundary-validation.md` gives an echoed value no tighter cap
  than its source. A guessed cap would turn a long legitimate branch into a failed owner check,
  which the prompt treats as owned, so that PR would be skipped every run. An oversized value
  affects only the caller's own request.
- **Legacy `status = 'awaiting_followup'`.** Not a `TaskStatus` any more, no writer remains in
  `apps/api/src` or `packages/vm-agent`, and production has 0 such rows. The shared allowlist
  excludes it; the current form (an `awaiting_followup` execution step on an `in_progress` or
  `sleeping` task) is covered and tested.
- **Zombie owners.** An owner cannot defer a PR forever: a sleeping task terminalizes as
  `snapshot_expired` within 7 days (67 such terminations since 2026-10-01; no sleeping task in
  production is past its snapshot expiry), and `in_progress` tasks are bounded by the stuck-task
  sweep and runaway ceilings. Every run's digest lists each deferral with the owner's task ID and
  status.
- **Remaining window.** A completion task dispatched by someone else without `branch=<head>` and
  without the PR URL in its description is invisible until its first turn ends and the VM agent
  rewrites `output_branch`. The prompt requires both for the Shepherd's own dispatches.

## Acceptance Criteria

- [x] `list_project_agents` with `prHeadBranch`/`prUrl` returns exactly the active owners
      (proven per disjunct against a real SQL engine through the real MCP route; see the
      discrimination table)
- [x] The #2243, #2276 and #2279 owner shapes are all found; pre-fix code returns unrelated agents
      (`seedOneOwnerPerLink` cases; "router ignores arguments" turns 11 tests red)
- [x] Terminal, ready, draft, superseded, other-project and own tasks are never returned
      (`never treats a %s task`, superseded, cross-project, own-task tests)
- [x] Unfiltered calls keep working and include `outputPrUrl` and `workspaceBranch`
      ("keeps the unfiltered listing" test)
- [x] The reviewed proposed Shepherd prompt requires the owner check before merge/dispatch, leaves owned PRs alone,
      reports them in its digest, and fails closed (prompt diff below)
- [ ] Only `promptTemplate` changed on the trigger; it stays `paused`
- [ ] Hand-run owner check against current open PRs recorded with evidence

## Trigger Prompt Change (reviewed record)

The prompt lives in production D1 (`triggers.prompt_template`), not in this repository. This is the
reviewed copy. `update_trigger` sends `promptTemplate` only; every other field stays as it was.

Before: read 2026-10-11 from production D1, 2,729 characters, sha256 `94486433d2a6c68ab6ffd81c8192d555bb6eeed964b2d2c674a697464faadd40`. After: 3,699 characters (limit 8,000).

### Diff

```diff
--- before
+++ after
@@ -2,14 +2,16 @@

 First call get_instructions, then check list_tasks for another active shepherd run (a task whose title starts with 'PR Shepherd' in status in_progress). If one is already running, post a one-line update_task_status and stop immediately — do not double-shepherd.

-Then triage EVERY open PR with gh (state, CI checks, review evidence, staging status, labels, age) into four buckets and act:
+Owner check (before acting on any PR): list open PRs with gh pr list --state open --json number,url,headRefName,isCrossRepository. For each PR, call list_project_agents with prUrl=<url>, plus prHeadBranch=<headRefName> when isCrossRepository is false. Every agent it returns is an active task that owns the PR: its output branch or workspace branch is the head branch, its output PR URL is the PR, or its description cites the PR URL. Leave owned PRs to their owner: do not merge them, dispatch for them, push to them, close them or label them. Report each one in the digest under left-to-owner with the PR number and each owner's taskId and status. Repeat the call immediately before each merge and each dispatch, and skip the PR if it now returns an owner. If the call fails or its response has no filter field, treat the PR as owned.
+
+Then triage EVERY open PR without an owner with gh (state, CI checks, review evidence, staging status, labels, age) into four buckets and act:
 1. READY: all gates green or one mechanical step from green — complete the remaining gates and merge. Project policies grant you the authority: best-practice engineering decisions are yours to make and document; verified security fixes merge without human sign-off; /do-dispatched work carries merge authorization. Monitor each production deploy per CLAUDE.md.
-2. NEEDS COMPLETION: dispatch ONE completion task per PR via dispatch_task with an explicit valid agent profile (call list_agent_profiles first), citing the PR number and the exact remaining gates, and including the sentence: Execute this task using the /do skill. Never start a description with a slash command. Verify each dispatch actually started per .claude/rules/09; inspect failed dispatches before any retry.
+2. NEEDS COMPLETION: dispatch ONE completion task per PR via dispatch_task with an explicit valid agent profile (call list_agent_profiles first) and, for a same-repository PR, branch set to the PR head branch, citing the full PR URL (later owner checks match on it) and the exact remaining gates, and including the sentence: Execute this task using the /do skill. Never start a description with a slash command. Verify each dispatch actually started per .claude/rules/09; inspect failed dispatches before any retry.
 3. DEPENDABOT/DEPS: apply the deps doctrine — merge green safe bumps; prefer LTS; keep image tags moving together with their SDK/package versions; close majors that need a coordinated migration, with documented rationale on the PR.
 4. GENUINELY HUMAN: label needs-human-review with a one-line reason. Valid reasons ONLY: unspecified product/UX-visible semantics, data-loss-risk or irreversible actions, security DESIGN changes, new spend or account-limit changes, credential/infra blockers agents cannot resolve. Nothing else qualifies.

 Staging discipline: staging is one shared environment on a Hetzner account shared with production (10-server limit). Serialize staging users — check active deploy-staging workflow runs and recent deploys before triggering anything; if a verification-train workflow exists in the repo rules/skills, prefer batching staging-needing PRs into one train instead of per-PR deploys. Staging must return to zero VMs after any verification (delete test nodes/workspaces).

-Also: file platform bugs you discover as backlog tasks or SAM ideas (do not silently drop them). Finish by posting ONE digest via update_task_status: merged / dispatched / closed / parked-with-reason / issues-found. Keep it short and factual.
+Also: file platform bugs you discover as backlog tasks or SAM ideas (do not silently drop them). Finish by posting ONE digest via update_task_status: merged / dispatched / closed / parked-with-reason / left-to-owner / issues-found. Keep it short and factual.

 Call "Complete" tool when done regardless of outcomes.
\ No newline at end of file
```

### Before

```text
You are the PR shepherd for {{project.name}} (run #{{execution.sequenceNumber}}, {{schedule.date}} {{schedule.time}} UTC) — the steady-state version of the 2026-08-05 backlog blitz. Goal: keep the PR queue draining continuously so open PRs never pile up again.

First call get_instructions, then check list_tasks for another active shepherd run (a task whose title starts with 'PR Shepherd' in status in_progress). If one is already running, post a one-line update_task_status and stop immediately — do not double-shepherd.

Then triage EVERY open PR with gh (state, CI checks, review evidence, staging status, labels, age) into four buckets and act:
1. READY: all gates green or one mechanical step from green — complete the remaining gates and merge. Project policies grant you the authority: best-practice engineering decisions are yours to make and document; verified security fixes merge without human sign-off; /do-dispatched work carries merge authorization. Monitor each production deploy per CLAUDE.md.
2. NEEDS COMPLETION: dispatch ONE completion task per PR via dispatch_task with an explicit valid agent profile (call list_agent_profiles first), citing the PR number and the exact remaining gates, and including the sentence: Execute this task using the /do skill. Never start a description with a slash command. Verify each dispatch actually started per .claude/rules/09; inspect failed dispatches before any retry.
3. DEPENDABOT/DEPS: apply the deps doctrine — merge green safe bumps; prefer LTS; keep image tags moving together with their SDK/package versions; close majors that need a coordinated migration, with documented rationale on the PR.
4. GENUINELY HUMAN: label needs-human-review with a one-line reason. Valid reasons ONLY: unspecified product/UX-visible semantics, data-loss-risk or irreversible actions, security DESIGN changes, new spend or account-limit changes, credential/infra blockers agents cannot resolve. Nothing else qualifies.

Staging discipline: staging is one shared environment on a Hetzner account shared with production (10-server limit). Serialize staging users — check active deploy-staging workflow runs and recent deploys before triggering anything; if a verification-train workflow exists in the repo rules/skills, prefer batching staging-needing PRs into one train instead of per-PR deploys. Staging must return to zero VMs after any verification (delete test nodes/workspaces).

Also: file platform bugs you discover as backlog tasks or SAM ideas (do not silently drop them). Finish by posting ONE digest via update_task_status: merged / dispatched / closed / parked-with-reason / issues-found. Keep it short and factual.

Call "Complete" tool when done regardless of outcomes.
```

### After

```text
You are the PR shepherd for {{project.name}} (run #{{execution.sequenceNumber}}, {{schedule.date}} {{schedule.time}} UTC) — the steady-state version of the 2026-08-05 backlog blitz. Goal: keep the PR queue draining continuously so open PRs never pile up again.

First call get_instructions, then check list_tasks for another active shepherd run (a task whose title starts with 'PR Shepherd' in status in_progress). If one is already running, post a one-line update_task_status and stop immediately — do not double-shepherd.

Owner check (before acting on any PR): list open PRs with gh pr list --state open --json number,url,headRefName,isCrossRepository. For each PR, call list_project_agents with prUrl=<url>, plus prHeadBranch=<headRefName> when isCrossRepository is false. Every agent it returns is an active task that owns the PR: its output branch or workspace branch is the head branch, its output PR URL is the PR, or its description cites the PR URL. Leave owned PRs to their owner: do not merge them, dispatch for them, push to them, close them or label them. Report each one in the digest under left-to-owner with the PR number and each owner's taskId and status. Repeat the call immediately before each merge and each dispatch, and skip the PR if it now returns an owner. If the call fails or its response has no filter field, treat the PR as owned.

Then triage EVERY open PR without an owner with gh (state, CI checks, review evidence, staging status, labels, age) into four buckets and act:
1. READY: all gates green or one mechanical step from green — complete the remaining gates and merge. Project policies grant you the authority: best-practice engineering decisions are yours to make and document; verified security fixes merge without human sign-off; /do-dispatched work carries merge authorization. Monitor each production deploy per CLAUDE.md.
2. NEEDS COMPLETION: dispatch ONE completion task per PR via dispatch_task with an explicit valid agent profile (call list_agent_profiles first) and, for a same-repository PR, branch set to the PR head branch, citing the full PR URL (later owner checks match on it) and the exact remaining gates, and including the sentence: Execute this task using the /do skill. Never start a description with a slash command. Verify each dispatch actually started per .claude/rules/09; inspect failed dispatches before any retry.
3. DEPENDABOT/DEPS: apply the deps doctrine — merge green safe bumps; prefer LTS; keep image tags moving together with their SDK/package versions; close majors that need a coordinated migration, with documented rationale on the PR.
4. GENUINELY HUMAN: label needs-human-review with a one-line reason. Valid reasons ONLY: unspecified product/UX-visible semantics, data-loss-risk or irreversible actions, security DESIGN changes, new spend or account-limit changes, credential/infra blockers agents cannot resolve. Nothing else qualifies.

Staging discipline: staging is one shared environment on a Hetzner account shared with production (10-server limit). Serialize staging users — check active deploy-staging workflow runs and recent deploys before triggering anything; if a verification-train workflow exists in the repo rules/skills, prefer batching staging-needing PRs into one train instead of per-PR deploys. Staging must return to zero VMs after any verification (delete test nodes/workspaces).

Also: file platform bugs you discover as backlog tasks or SAM ideas (do not silently drop them). Finish by posting ONE digest via update_task_status: merged / dispatched / closed / parked-with-reason / left-to-owner / issues-found. Keep it short and factual.

Call "Complete" tool when done regardless of outcomes.
```

## References

- `.claude/rules/09-task-tracking.md`, `.claude/rules/25-review-merge-gate.md`
- `.claude/rules/62-tests-must-observe-the-real-trigger.md`, `.claude/rules/28-credential-resolution-fallback-tests.md`
- `apps/api/.claude/rules/69-emergency-config-paths-need-their-own-coverage.md` (one test per disjunct)
- `.claude/rules/74-proxy-signals-must-match-the-condition.md` (fail closed on degraded input)

## Recovery gate record (2026-10-11)

This task was archived before the live MCP, delta-review, trigger-update and completion gates were done. Recovery moves the same task back to active; it does not repeat implementation or discard original work. Sole recovery owner: `01M4NAW5A7GP6XP14S7ZA4YFA5`; original branch `sam/wave-d-reliability-wave-99djn8`; existing draft PR #2301. Coordinator released source/tests/reviews via verified SAM event `2ff7f9a8-0a0c-4315-9875-d3e1251a75ad`. Staging mutation, provisioning, migrations, merge, production and trigger mutation still require sequencing grants.

Retained candidate `310d89a7bdddbbf07f1578e9eb111e93572bb4b2`: GitHub lint/typecheck/test/build, DO shards and other applicable code checks passed. Preflight Evidence failed because the PR body lacks its required block. CodeRabbit reports Review skipped for absent opt-in label; this does not establish the ready-state request/wait gate. Original transcript reports deployment of `a2db04be8`, but the KV token write failed and no real owner-query ran. Later list_tasks fixes were not part of that staging candidate. Current exposed production SAM MCP schema remains pre-fix; absence of a filter-capable callable is not a successful owner check. Trigger remains paused; reviewed prompt below is proposed, not applied.

Old snapshot/WIP content cannot be read/downloaded through exposed SAM tools (only current-workspace info/diff are available). Retained snapshot metadata and clean recovery checkout do not prove all old uncommitted content was recovered. Coordinator notified of this access limitation. Preserve all old snapshots/work.

Live read-only production probe (2026-10-11 14:04 UTC): authenticated `tools/call list_project_agents` with D branch and PR URL returned HTTP 200, 52 agents and **no filter echo**. Correct result is fail closed/defer; no ownership conclusion or trigger update was made. Two independent recovery local Sol reviewers found no blocking code/security issue at `310d89a7`; completion reviewer flagged the stale delta note (now corrected) and outstanding live/process gates.

Recovery focused validation: 63 tests passed across owner-filter, workspace task/search paging and platform-operation suites after dependency setup and shared/providers/cloud-init builds (2026-10-11 14:05 UTC). No runtime source edits were required.

## Corrective staging verification (2026-10-11 15:18–15:25 UTC)

Pinned deployment `96510f86b` succeeded in [run38146141473](https://github.com/raphaeltm/simple-agent-manager/actions/runs/38146141473). After a wrong-project attempt was cleaned up using supported APIs, coordinator expressly authorized one corrective session in existing fixture `01M4N4D24AEPFCWK6ETBEEHAQ8`. Session `8a7ca82f-2636-459e-b32d-5ccf5f88b606` used explicit cf-container and configured gpt-6.1-sol; exact serving variant is not independently observable.

[Persisted direct MCP responses](../evidence/2026-10-11-pr-shepherd/direct-mcp-results.json) demonstrate no-owner filter echo, malformed whitespace branch rejection (-32602), caller inclusion/exclusion, and sleeping-status acceptance. Schema fields were additionally shell-reported; do not equate that report with raw persisted tools/list output. Fixture contains only caller task: positive-owner, own-branch-owner and multi-page live cases remain unverified. Separately, 63 real-route SQLite/operation tests pass; they do not replace these live gaps. Both local recovery reviewers returned no blocking code/security findings; stale task note was addressed.

[Browser route results](../evidence/2026-10-11-pr-shepherd/browser-routes.json) record zero page errors for four authenticated routes. Captured screenshots: [dashboard](../evidence/2026-10-11-pr-shepherd/dashboard.png), [projects](../evidence/2026-10-11-pr-shepherd/projects.png), [settings](../evidence/2026-10-11-pr-shepherd/settings.png), [fixture chat](../evidence/2026-10-11-pr-shepherd/fixture-chat.png). These verify loaded routes, not every UI interaction.

Cleanup: session stop200/workspaceDeleted:true; own temporary profile `01M4NRNYAMJ5WGWVXW1ZJ58TXP` DELETE200; profile/node `01M4NRPEH57EWRRHTD9985D865`/workspace `01M4NRPEPHZ7GS3JPZX8K85GF4` GET404; stopped session retained200 for audit. Coordinator independently confirmed cancelled task/deleted compute. Final STAGING_RELEASE event `fb0c7ece-1352-4884-912a-ff33f0f034ac`; zero own active compute, no extra attempt/redeploy.

Applicable candidate CI checks pass, including preflight, lint, typecheck, tests/build, DO shards and Sonar: [run38145854513](https://github.com/raphaeltm/simple-agent-manager/actions/runs/38145854513). Remaining gates: honest live-fixture gap assessment, one bounded CodeRabbit request/wait, coordinator merge/production sequencing, verified production capability then authorized prompt-only update. Trigger remains paused. Snapshot-content access gap remains; existing work preserved.
