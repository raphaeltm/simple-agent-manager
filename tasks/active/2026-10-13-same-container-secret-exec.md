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

- [x] Define shared request/result types and strict validation for arbitrary argv or explicit shell, selected secret names, cwd, nonsecret env, timeout, idempotency; no caller-selected workspace/container/user.
- [x] Implement same-live-container execution, resolved session user/worktree, explicit fresh-process tool description, child supervision/cancel/timeouts and bounded redacted output.
- [x] Authenticate caller/session/project/workspace and selected names; resolve ONLY requested managed env secrets immediately before execution; provide future decision seam without classifier.
- [x] Project/profile/skill managed secret envs become recognizable placeholders in fresh ordinary environments; preserve merge precedence/nonsecret values, metadata discoverability, and nonselected placeholders in jobs.
- [x] Prevent silent fallback restoring managed protected values via bootstrap/ACP/restore paths. Scope env secrets, explicitly preserve essential harness/MCP authentication; no universal credential migration or secret file corruption.
- [x] Leave existing active/legacy sessions untouched and report legacy/stale state honestly; no forced restarts/recreation.
- [x] Add scenario tests for auth negatives, selected/nonselected/default env, user/cwd/live uncommitted file, quoting/multiline, errors/redaction/cancel/idempotency and fresh/legacy compatibility.
- [x] Update tool descriptions, API/public docs and environment references as applicable.
- [ ] Run lint/typecheck/test/build and required security/quality checks.
- [ ] Complete local specialist reviews (Go/security/API/env/docs/constitution/test/task completion), fix findings.
- [ ] Draft PR then ready only after gates; request CodeRabbit and wait; resolve arrived findings.
- [ ] Staging real VM, heartbeat/access and fresh-session sentinel verification; bounded cleanup.
- [ ] Merge normal gates, monitor exact production deployment; verify fresh-session behavior with synthetic sentinels and report deployed commit/results.

## Acceptance

Arbitrary commands run in the existing workspace container using current user and explicit cwd, observe live uncommitted files, and receive selected secret env values only. Ordinary fresh managed environments and nonselected names expose unmistakable placeholders. Tool explains fresh-process shell semantics and limitations. Existing auth/authorization preserved; no classifier or remote executor. All migrated injection paths covered; legacy active sessions not silently disrupted. Synthetic-only live proof and CI/review evidence attached to PR.

## Reference

packages/vm-agent/AGENTS.md; .claude/rules/25-review-merge-gate.md; .claude/rules/13-staging-verification.md; .claude/rules/14-do-workflow-persistence.md.

## Implementation handoff (2026-10-13)

Worker branch `sam/implement-authorized-same-container-8ha1es` implements the MCP start/status/cancel tools, selected-only merged secret resolution, fresh ordinary placeholders, private framed stdin execution and in-container group cleanup, existing SQLite durable job snapshots, strict scope/response validation, and user/API/env documentation. Parent harness commit `69dec30e3` was cherry-picked as `258b34a82`.

Local evidence: 37 targeted API tests passed; Go server/ACP/bootstrap/supervisor packages passed; Go race checks passed for the secret execution HTTP lifecycle and supervisor. The HTTP integration test covers request cancellation after acceptance, redaction before persistence, one side effect across retries, conflict detection, and session-scoped polling/cancellation. Runtime user/container observations are mocked only at the external runtime boundary in that local test; the parent’s real staging sentinel run is still required for actual live-container identity.

Scope/limitations: Bash and setsid required; native Instant execution uses the existing local process runtime, VM execution uses the exact container launched by the active session and rejects container changes. Running output is empty until completion. Exact selected values are redacted, not transformed/file outputs. Harness/MCP/Git auth and runtime secret files remain separate. No restart, deployment, merge or archive by implementation worker.

Remaining unchecked gates are assigned to parent task `01M4TZ3DNKT0RTKDJ7RW0KHSF7`: final specialist reviews, CodeRabbit, consolidated staging real VM/heartbeat/sentinels, readiness/merge, production deployment/verification. Full local lint/typecheck/test/build is running before worker completion. Task stays active until acceptance reconciliation.

### Independent-review fixes (worker, 2026-10-13)

Initial green checks did not cover valid env names clobbering supervisor locals, fresh per-session env overlays in existing containers, credential-name collisions, and accepted-job liveness. The worker fixed these with child-only export using function positional arguments, an empty-export guard, env-only current-session overlays, protected-name checks after harness injection, and finite job-owned activity accounting/cancellation through the existing session lifecycle. Managed names never silently regain provider/Git fallback values; unsupported harness env collisions fail clearly while auth-file credentials remain separate.

Added actual MCP HTTP entry → real KV auth/D1/encryption/JWT → mocked node HTTP tests, selected-name/actor/session/workspace/mode/fingerprint/timestamp audit metadata, no-wake transport controls, and explicit child environments for every new subprocess test. Shell startup controls ENV/BASH_ENV are rejected rather than silently stripped from selected/override env; Bash readonly names fail execution.

Safe validation after fixes uses `env -i`, minimal PATH, temporary HOME and nonsecret cache paths. Full VM-agent tests passed; focused Go race checks passed; full API suite passed (874 files plus one skipped). Final exact-commit review/CI and parent-owned live acceptance remain required. The task is not archived and the worker does not deploy/merge. Parent owns PR body/labels and final independent revalidation.

### Parent verification (2026-10-13)

Latest implementation head `13fd16d5` passed code/test/quality CI and Sonar. Secret Scan remains blocked by the historical synthetic PEM wrapper introduced in `e43d2ab1` and corrected in `7f1062a0`; no scanner exception is approved/applied. A coordinated rewrite of this task's own branch history is an alternative pending explicit authorization, with the original history/evidence preserved and final tree equality checked.

Staging deployment `38468953890` at API commit `6065b7c42` passed. Its VM agent reports `c47d87127`, the last VM source change; there is no VM source difference through `13fd16d5`. Disposable fresh VM/workspace acceptance reports all 16 sentinel checks passing. Independently fetched persisted MCP result records corroborate actual jobs: injected command exit 0 with selected-value hash, nonselected placeholder, same container/user/cwd/live file checks; redaction job exit 0 with both streams exactly redacted; explicit shell exit 0; timeout status timed_out/exit 143. Container `a08592d804f9`, user `node`, measured UID/GID 1000, environmentMode placeholder. Ordinary before/after probe checks passed. Browser navigation checks passed with zero page errors. The first test VM missed readiness and was deleted by normal bounded recovery before the successful replacement; no existing workspace was restarted.

Added explicit synthetic-only regressions: `TestEmptyInjectionDoesNotPrintInheritedEnvironment` requires an empty-injection `true` command to emit no stdout/stderr (the bare-export failure); `TestOrdinaryEnvironmentListingContainsOnlyManagedPlaceholders` runs an ordinary env-listing child with an explicitly synthetic environment and verifies only the protected placeholder survives. Minimal env-i focused Go regressions pass; independent security reviewer PASS. No test output includes real environment values; failure assertions report only status/byte counts.

Production deployment/verification, final CI/review evidence reconciliation and CodeRabbit request/wait remain pending. Credential rotation is not a release blocker per user; no credential or security-policy changes are authorized by this evidence.
