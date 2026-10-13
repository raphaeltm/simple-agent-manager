# Same-container exec_with_secrets MVP

## Authority and scope
User authorized implementation, draft PR initially, reviews, normal CI, staging, merge and production deployment on 2026-10-13 ~19:38 UTC. Astra task 01M4TZ3DNKT0RTKDJ7RW0KHSF7 owns delivery before tomorrow morning Europe/Paris. Same-container mediation and accidental-disclosure reduction, not hostile-agent isolation. Classifier implementation excluded. No policy-store entries, persistent credentials, permission/security expansion, surprise active-session restarts, container recreation or data loss.

## Research
Full revised report is in SAM conversation 997b298c-547e-4502-ac69-69d965ec475b, normal reply and thread 4e8af169-d141-45fb-98fc-16724002c7a8.
- API runtime assets: profile-runtime-assets.ts resolveRuntimeEnvRows/resolveRuntimeFileRows; workspace-runtime-assets.ts getWorkspaceRuntimeAssets. Default delivery currently decrypts env values/files.
- VM bootstrap ensureProjectRuntimeAssets writes /etc/profile.d/sam-project-env.sh and /etc/sam/project-env; ACP ReadContainerEnvFiles/resolveAgentEnvVars inherits them.
- MCP auth/index and workspace-tools.ts requireWorkspace/lookupWorkspaceForVmAgent/startBuildPublishJobOnVm provide verified workspace/node management path.
- VM server agent_ws.go resolves session ContainerUser/ContainerWorkDir/live container; mcp_build.go provides async jobs.
- ACP AgentProcess.Stop documents host docker exec cancellation does not kill in-container processes.
- Fresh Docker exec is not an existing terminal: live files/network persist; aliases/functions/exports/activation require explicit setup.

## Implementation checklist
- [ ] Define shared request/result types and strict validation for arbitrary argv or explicit shell, selected secret names, cwd, nonsecret env, timeout, idempotency; no caller-selected workspace/container/user.
- [ ] Implement same-live-container execution, resolved session user/worktree, explicit fresh-process tool description, child supervision/cancel/timeouts and bounded redacted output.
- [ ] Authenticate caller/session/project/workspace and selected names; resolve ONLY requested managed env secrets immediately before execution; provide future decision seam without classifier.
- [ ] Project/profile/skill managed secret envs become recognizable placeholders in fresh ordinary environments; preserve merge precedence/nonsecret values, metadata discoverability, and nonselected placeholders in jobs.
- [ ] Prevent silent fallback restoring managed protected values via bootstrap/ACP/restore paths. Scope env secrets, explicitly preserve essential harness/MCP authentication; no universal credential migration or secret file corruption.
- [ ] Leave existing active/legacy sessions untouched and report legacy/stale state honestly; no forced restarts/recreation.
- [ ] Add scenario tests for auth negatives, selected/nonselected/default env, user/cwd/live uncommitted file, quoting/multiline, errors/redaction/cancel/idempotency and fresh/legacy compatibility.
- [ ] Update tool descriptions, API/public docs and environment references as applicable.
- [ ] Run lint/typecheck/test/build and required security/quality checks.
- [ ] Complete local specialist reviews (Go/security/API/env/docs/constitution/test/task completion), fix findings.
- [ ] Draft PR then ready only after gates; request CodeRabbit and wait; resolve arrived findings.
- [ ] Staging real VM, heartbeat/access and fresh-session sentinel verification; bounded cleanup.
- [ ] Merge normal gates, monitor exact production deployment; verify fresh-session behavior with synthetic sentinels and report deployed commit/results.

## Acceptance
Arbitrary commands run in the existing workspace container using current user and explicit cwd, observe live uncommitted files, and receive selected secret env values only. Ordinary fresh managed environments and nonselected names expose unmistakable placeholders. Tool explains fresh-process shell semantics and limitations. Existing auth/authorization preserved; no classifier or remote executor. All migrated injection paths covered; legacy active sessions not silently disrupted. Synthetic-only live proof and CI/review evidence attached to PR.

## Reference
packages/vm-agent/AGENTS.md; .claude/rules/25-review-merge-gate.md; .claude/rules/13-staging-verification.md; .claude/rules/14-do-workflow-persistence.md.
