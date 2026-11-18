# Reliability A: remove platform publication, preserve snapshots

## Problem

Successful agent turns automatically stage all files, commit, push and create review requests. Publication must remain agent-directed while independent sleep snapshots preserve work.

## Research

- Shared VM/Instant callback in `internal/server/server.go` is the sole production caller of `gitPushWorkspaceChanges`.
- `agent_ws.go` wires contextual completion for both harnesses; `workspaces.go` terminal prompts use that same callback.
- Standalone/container snapshot WIP paths use temporary GIT_INDEX_FILE and commit-tree; preserve these.
- Coordinator owns consolidated staging and merge. Use assigned snapshot-supported root branch rather than unpreserved sibling worktree. Task kept on assigned branch to avoid independent main mutation during coordinated release.

## Checklist

- [x] Static audit VM/Instant, both harnesses and actual completion.
- [x] Remove automatic staging/commits/push/review creation.
- [x] Preserve explicit git/PR tools and completion reporting.
- [x] Unit test dirty/staged/workflow/local-commit preservation and absence of publication.
- [x] Update docs, run checks and independent local reviews. (reconciled 2026-10-26: #2355/#2363 changed 8 `apps/www` docs pages; #2355 body records Go test/vet/build, lint, typecheck and www build; reviews `review_a` and `A2363-GO/SEC-20261016-01` PASS)
- [x] Draft PR and consolidated staging plan/evidence handoff. (reconciled 2026-10-26: draft PR #2355 at `3d45a2d1c` carried the staging plan; evidence was handed to release PR #2363)

## Acceptance

Turn end and actual completion never publish. Snapshot-supported workspace paths preserve tracked/untracked/staged/workflow files and local commits across capture/restore. No claim of sibling worktree preservation. Agent-directed git and complete_task evidence remain available.

## Evidence and remaining runtime proof

- Implementation pushed: 99c8ca22a. Shared `agent_ws.go:getOrCreateSessionHost` binds both callbacks independently of agent type; ACP `session_host_attempt.go` delivers completion for Claude Code and Codex. `workspaces.go:startAgentWithPrompt` uses the same callback. No alternate publication caller remains.
- Actual terminal `apps/api/src/routes/mcp/task-tools.ts` preserves supplied summary/PR/evidence and calls `cleanupTerminalTaskResources`; `services/task-terminal-cleanup.ts` tears down runtime without Git publication. These interfaces are unchanged.
- Targeted callback/cold-wake/WIP tests pass. Independent reviewer confirmed snapshot tests preserve local commits, dirty/untracked files, staged and unstaged content, and workflow files through both standalone/container implementations.
- Direct callback repository mutation proof is standalone; workspace-role callback rejects publication errors but does not execute Docker. Harness wiring/actual terminal paths are statically audited, not yet live-proven.
- Independent local Go/test/completion review: no production defect; stale docs corrected; constitution check and diff whitespace pass. Reviewer review_a.
- Coordinator runtime sweep remains REQUIRED: pin candidate across VM/Instant and Claude/Codex; create local unpushed commit plus staged/unstaged and workflow files; record HEAD/index/status/remote refs/PRs before turn end and complete_task, assert no publication; sleep/wake supported root, compare all content and staged state. Verify VM heartbeat and workspace/terminal access; clean up immediately. Do not claim arbitrary sibling-worktree recovery.
- Keep task active and PR draft pending coordinated runtime evidence. No independent deployment or merge.

## A release ownership transfer — 2026-10-16

Raphaël transfers sole release execution to Sol task `01M5344FTRACH9093B26A3M56C`, through normal production deployment. This supersedes the historical coordinator/draft-only restrictions above; original A remains sleeping and relinquished. Release target is existing PR2363, not an accidental autosave PR. Preserve original WIP and evidence.

Production main `8778abe1ce6cc003eb0f50428ede5c2b6a9a6093` was normally merged into PR2363 at `b5394835c`; B2358 and incident2368 remain intact. The unrelated speech factory refactor was restored exactly to main. Documentation preserves upstream Instant branch exceptions for attachments, Execute and explicit resource overrides.

- [x] Documentation complete and source checks/reviews recovered from PR2355.
- [x] Fresh integrated local Go/security reviews: `A2363-GO-20261016-01`, `A2363-SEC-20261016-01` PASS. Completion/docs/constitution `A_completion_20261016` findings addressed.
- [x] Go1.26.6 targeted completion/callback/cold-wake/WIP/snapshot selection PASS (10.255s), server vet and all-package build PASS.
- [x] Affected API callback suite 8 tests PASS, affected ESLint PASS, API typecheck PASS; www build 242 pages PASS; runtime-state check PASS. Initial API invocation failed before tests because shared package was not built; standard dependency build resolved it.
- [x] Final current-head CI/Sonar/security and trusted CodeRabbit ready-state request/wait. (reconciled 2026-10-26: merged head `e05b6e058` passed CI 38969998177, E2E smoke 38969998031 and Sonar check 117212525025; CodeRabbit workflow 38969349122 was rate-limited and the wait ended 21:49 UTC per #2363 body; zero unresolved threads)
- [ ] Explicit shared staging slot after PR2305 → PR2304, final deployment and bounded missing A runtime proof. — not done (reconciled 2026-10-26): the slot and staging 38964359320 at `470026e13` succeeded, but the Codex VM fixture failed at setup (cause unknown), so the missing runtime proof was never obtained; the release relied on audit `A_sourcebound_acceptance_20261017` (#2363 body)
- [x] Merge, canonical automatic production deploy, live SHA/version/health and actual normal agent rollout. (reconciled 2026-10-26: merged `bde4f9821`; run 38973836161 failed on R2 CORS, fixed by #2370; run 38979561653 succeeded at `d241cb05e`; Worker `de4fb378` at 100%, health 200, VM `01M53GKC7Q6BDMR6123Y0YW42A` on agent `b5394835` at 23:30 UTC per #2363 body)

Historical original receipts recovered from channel `reliability.2026-10-15`, sequences 141–155 and later source reviews: Instant Codex original preparation/turn/sleep-wake/actual completion and same-context postterminal remote refs/PR inventory covered; independent artifact provenance review is not independent runtime execution. Failed attempts and deadline misses remain failures. Claude VM WIP recovery and initial actual complete_task covered; its composite independent publication observer FAILED. Later supplement MCP download failed before probe, cause unknown. Codex VM coverage not done. None of these gaps is upgraded to PASS by source/unit checks.

Smallest remaining live plan: one fresh configured-pool VM Codex fixture, actual turn/completion nonpublication and supported local commit/staged/unstaged/untracked/workflow snapshot recovery, with retained original receipts before Sleep and independent observer in the already retained Instant context. Max one staging VM, no sizing/pool/security overrides. Finite 45-minute action/export window plus normal cleanup tail; refresh capacity and catalogue before admission. Prior catalogue two-rounded-hour compute estimate EUR0.0176–0.0512, excluding IP/tax/Instant/storage/provider delays. Do not expand into another matrix or destroy preserved fixtures. C activation remains separate.

## Current release evidence — 2026-10-16 21:30 UTC

This supersedes the prospective live plan above; it preserves every failed attempt. PR2363 normally integrates PR2305 main51a0 at470026. Exact CI38962678368, smoke38962678497, Sonar/security and local specialist gates pass. Standard staging38964359320 succeeds at470026; CF Worker80d54154-8d4e-4da0-aa68-528e7e0edcd1 is100%, required agentb539, health healthy.

One ordinary full-profile Codex VM fixture01M538JX7K9G9XXQDVQ8C3WQRG was admitted with no pool/sizing/security override. Actual node01M538K4VXBE7W4Q34KK5CCG8Q reports b539; READY observed. Setup terminal failed before retrieving original baseline/probe bytes, cause unknown. This supplies no Codex dirty-WIP/nonpublication proof. Normal Sleep200 at21:19:29, snapshot available/undegraded, old workspace strictly deleted with runtime proof21:25:41. Sole VM remains in normal warm retention; release executor owns actual provider-termination verification, no Stop/delete. Original failure receipts are permanently encrypted in Library `/reliability-a-release-2026-10-16/codex-001-failed-setup/`. No replacement fixture or clock reset.

Independent Sol audit `A_sourcebound_acceptance_20261017` passes meaningful A acceptance: the relevant server.go completion-callback diff from historical b467→current470 changes only four empty-publication-result calls to nil and optional metadata encoding; workspace/snapshot production paths are identical. Actual complete_task and terminal-cleanup producers are identical from historical APIe2 to current470. Current tests cover the callback metadata delta. Historical Instant original baseline01M5103R5HSAMTPZQ7XRSXTQWN, expectations01M5107YX0EWAZQ5WS7ZK4MKVZ and observer01M511TM0SXY87MZ5ZJY6SFABG were independently downloaded and checked for exact bytes, schema, task/session association and chronology. They establish turn-end, sleep/wake, actual completion and postterminal all-refs/exact-branch all-state PR preservation. Execution was same-context, not an independent runtime. Claude receipts supplement WIP recovery and initial actual completion with their stated limitations. Together with current tests, staging and fresh full-VM heartbeat this closes the behavior gate without another cross-runtime matrix. New Codex setup remains failed/unknown; historical observer/download failures remain failures.

PR ready21:26. Trusted CodeRabbit workflow38969349122 succeeded; request21:26:15, response21:26:22 rate-limited. Required bounded wait remains through approximately21:41; two previous functional findings are fixed/resolved. Old test-complexity nitpick is being addressed without production changes. PR2304 owns the next production sequence; integrate its main normally and await its verified release before A merge. Production SHA/run/live proof and actual owned-VM termination remain pending.

## Reconciliation 2026-10-26

- Shipped by #2363 (`bde4f9821`, merged 2026-10-16), built from #2355 (`3d45a2d1c`; GitHub
  records #2355 as merged via `b467f3898`), plus deploy repair #2370 (`d241cb05e`, merged
  2026-10-16). Run 38973836161 for `bde4f9821` failed; first successful production deploy:
  run 38979561653 (head `d241cb05e`, 2026-10-16).
- Unticked: 1 — the bounded Codex VM runtime proof was never obtained (fixture setup failed);
  the release owner accepted the source-bound audit instead.
- Verdict: ARCHIVE. Owner task 01M5344FTRACH9093B26A3M56C completed. Since the deploy, none of
  the 2,083 fetched remote refs has an "Auto-committed by SAM on agent completion" commit; the
  last one is dated 2026-10-16T21:18:44Z.
- Open PRs: draft #2354 holds only autosaves, `.agent-evidence/` files and a
  `scripts/e2e/reliability-a` harness; nothing here depends on it.
