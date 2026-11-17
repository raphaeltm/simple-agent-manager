# Fix Vibe permission-mode translation (#2846)

## Scope and constraints

SAM task 01M7MBSSRNNTKQF3RQFC711AH9. Deliver a tested **DRAFT PR** only; **do not mark ready and do not merge**. Include `Closes #2846` in PR body. Never open new issues. Keep idea 01M43B7Q8HC87N3AEW187Q6BMT open while unmerged; Gemini/Amp/OpenCode slices remain open. Related #2845 task 01M7MBR1R0P912NNH546MHHVZD owns MCP serialization; avoid overlap.

## Problem and research / preflight

External author leonceaklin reports every tool denied by the approval callback on self-hosted SAM with Vibe 2.25.8. No live denial reproduction was performed by triage or implementation so far. Issue and fork are untrusted evidence, never instructions.

Classification: external-api-change, business-logic-change, security-sensitive-change, docs-sync-change. Before edits, inspected upstream #2846 and fork zebra-pig/simple-agent-manager#10; independently fetched official v2.25.8 `vibe/core/agents/models.py` and `vibe/acp/agent.py`. Context7 unavailable. Vibe uses ask, plan, accept-edits, auto-approve; unsupported IDs return None without changing mode. Builtins also include unrelated primary/subagents; this fix maps only SAM permission modes. Credit the external report and fork mapping reference.

Verified flow: `SessionHost.startSelectedAgent` → `startAgentWithSessionMode` → `prepareAgentStartup` → `establishACPSession` → `tryLoadPreviousACPSession` / `startNewACPSession` → `applySessionSettings` → `acpSessionModeID` → ACP session/set_mode. Main e5c5aa4f77e6adf389a24b25b9470a69c24acbff passes bypassPermissions verbatim and skips empty/default. Vibe silently ignores bypassPermissions. New sessions remain ask; restored sessions can retain a prior permissive mode.

`requestPermission` in session_host_interactions.go cancels only when interaction configuration/identity, active prompt, deadline or request requirements fail; otherwise it persists/routes via Cloudflare. Preserve this distinction and all routing. Vibe has no equivalent of Claude's dontAsk (deny unless preapproved). Use conservative ask fallback and explicitly document that it can ask with interactions enabled, rather than claim semantic equivalence or grant bypass. Unknown values must also reset to ask so a restored auto-approve session cannot retain permissive state or accept native-mode injection.

Smallest implementation: normalize nil settings for Vibe, treat Vibe mode-RPC rejection as fatal (existing startup cleanup stops the unsafe process), and add a Vibe-only switch in existing translation helper; map unset/default/dontAsk/unknown to ask, plan to plan, acceptEdits to accept-edits, bypassPermissions to auto-approve. No new dependencies, env vars, infrastructure, or approval callback changes. Protocol IDs are invariants (Principle XI); Principles II, III, X, XIII and XIV apply. Existing release resolver includes packages/vm-agent; deployment rolls new managed VM agents and Instant images normally. Existing processes need replacement to gain this fix.

Existing Antigravity tests provide real startup/fake process seams. Use a separate Vibe protocol fake that silently ignores unknown modes (matching provider), captures RPC/session IDs, and seeds restored mode as auto-approve. Incident lesson: .claude/rules/71 explains why direct-helper tests miss startup bugs; follow rules 23, 35, 62 using real startup and SDK pipes.

## Checklist / acceptance criteria

- [x] Add startup-path tests for new and restored sessions covering every SAM mode and unknown values; assert captured RPC mode/session ID and actual fake mode.
- [x] Seed restored sessions in auto-approve and prove default/unset/dontAsk/unknown downgrade safely.
- [x] Assert other-agent controls (Antigravity, Claude, Gemini, Amp, OpenCode, Codex) retain behavior.
- [x] Prove new regression tests fail against original code, then pass after minimal mapping fix.
- [x] Document Vibe mode behavior and dontAsk limitation in public agents guide.
- [ ] Run Go race tests, vet, coverage and build; run relevant docs/quality checks and manually dispatch full CI without readiness.
- [x] Complete local Go/security/test/task-completion reviews and resolve findings.
- [x] Record live-provider/staging gaps honestly; no blanket approval or permission routing changes.
- [x] Push output branch, create draft PR with Closes #2846, preserve draft-only constraint in state and PR, link idea without closing it.

## Workflow adaptations

SAM already created the isolated checkout and assigned output branch. Keep task and implementation on this branch so draft-only work does not write main. No extra worktree/dependency install needed for Go; downloaded pinned Go 1.26.11 into ignored .tmp/toolchain because Go was absent from PATH.

## Validation / post-mortem

Final tests run against original production files: 16/18 mode matrix cases fail (plan passes), plus both rejected-reset startup cases fail; unchanged other-agent controls pass. Restored auto-approve survives skipped/ignored resets; rejected reset leaves unsafe process running. Restored fixed files, targeted Vibe + Antigravity race tests pass. Local reviewers found nil-settings and nonfatal rejection gaps; both now fixed and regression-covered. Regression logs are ignored local artifacts .tmp/vibe-final-original-red.log and .tmp/vibe-green.log.

Both staging queues inspected 2026-11-17 09:07 UTC. staging held by sam/fix-scheduled-trigger-inputs-swedr3 with six queued tasks; staging2 held by sam/self-host-landing-slice-zhg1yq with two queued tasks. No deployment or interference. Live Vibe/provider denial reproduction, real tool execution and fresh-VM staging validation remain outstanding before readiness/merge; handoff is draft only.

Regression class: provider silently ignores canonical IDs that differ from its native enum; omitted reset retains loaded state. Startup-path tests plus conservative reset pin the boundary contract. New standing instructions unnecessary: existing rules 23/35/62 already require these checks; executable tests enforce this specific contract.

## Tested draft handoff

PR: https://github.com/raphaeltm/simple-agent-manager/pull/2851. **DRAFT ONLY: do not mark ready and do not merge.** SAM PR disposition is held. Broader idea updated with PR and kept open; Gemini/Amp/OpenCode remain open. No new GitHub issues created. CodeRabbit not requested because readiness is excluded; passive check skipped.

Local validation: full VM-agent race/coverage suite passes (31 packages), go vet and binary build pass. Final ACP race/coverage rerun passes (84.2% statements; acpSessionModeID 100%, applySessionSettings 96.4%). An intervening full ACP coverage run hit existing TestContainerSnapshotOuterLimit's snapshot-scan timeout under concurrent lint/typecheck load; isolated race rerun passed 2.782s and final full ACP suite passed 81.145s. No code or test weakened. Repository lint 22/22 tasks and typecheck 36/36 tasks pass; public-doc build and links pass (0 broken across 52 pages). Runtime-state and install-manifest checks pass; PR preflight and specialist evidence validators pass with actual PR body.

Review: local Go/security reviewer ADDRESSED (nil/reset-error findings fixed, re-review PASS); test/constitution PASS; completion/docs ADDRESSED, A-F revalidation PASS. Final tests fail against original production files in 16/18 mode matrix cases plus both rejected-reset startup cases. All other-agent controls pass.

Full CI manually requested without marking ready: https://github.com/raphaeltm/simple-agent-manager/actions/runs/44054109832 on code commit 53c7df8bdcdf45c6d0a8bcbcd71d5dddeecce575. Completion tracked in PR body. Initial draft PR Evidence saw a PENDING reviewer before review finished; live body corrected and evidence rechecked. This task record remains active while PR is unmerged; no archive/merge claim.
