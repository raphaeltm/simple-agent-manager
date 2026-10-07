# Preserve session runtime contract across sleep and wake

SAM task: 01M4AXFSY11GR95XTD2N68ZE6F. Source Idea: 01M47WCAGF4A18CC0DCHYFK6CP.

## Problem and research

Normal VM restore supplies neither profile overrides nor ACP interactions. Go restore hosts read process-local maps. VM recovery unconditionally uses conversation mode, dropping task completion/git semantics. Instant wake supplies neither settings nor task context. Model retention varies by adapter; degraded VM restore already forwards overrides. Preserve resolved settings rather than re-reading mutable profiles during wake.

Affected boundaries: agent-session-bootstrap.ts, node-agent-session-snapshots.ts, session-recovery-task.ts, vm-agent-container.ts, Go restore admission and host configuration. Snapshot routing/lifecycle fences and workspace callback authentication remain required. Latest main reconciled before implementation; no open PR currently implements this Idea. Wake-ready sibling owns delivery signaling; archive sibling owns lifecycle allowlists.

## Checklist

- [x] Persist validated versioned resolved settings, ACP configuration, original task mode/callback context without secrets.
- [x] Restore VM and Instant contracts before host load; retain normal and degraded recovery behavior.
- [x] Preserve task completion and git delivery semantics; safe legacy fallback and malformed-data handling.
- [x] Add meaningful regression tests for modes, settings, interactions, task/chat and both runtimes.
- [x] Update affected user docs and source Idea.
- [x] Run applicable local quality checks and CI.
- [ ] Complete independent Go, Cloudflare, security, test, constitution, docs and completion reviews.
- [ ] Coordinate bounded shared staging; real sleep→wake, answer Manual request card, restored task completion/push/PR; clean up owned resources.
- [ ] Archive only after completion validation; merge after normal gates and prove production deployment.

## Acceptance criteria

Manual/Plan never silently become Bypass on wake. Model/effort/provider selections survive independent of later defaults/profile edits. Permissions/forms/URLs remain enabled through the canonical Cloudflare request/answer path. Task wake retains original callback identity and git delivery behavior; conversations remain conversations. Both VM and Instant preserve these invariants; incomplete historical records use explicit conservative compatibility and corrupt contracts fail safely. No destructive historical migration or relaxed authorization.

## References

Source Idea full corrections fetched. Rules: runtime parity (61), VM rollout compatibility (54), callback auth (34), migration safety (31), staging verification (13), merge gate (25).

## Implementation and local review evidence

Additive migration 0185; canonical runtime-contract service resolves settings once before launch and scopes snapshot loads by owner/project/chat. VM normal and degraded bootstrap, recovery task runner, Instant container wake, and Go fenced host restore consume the same saved contract. Go skips mutable settings fetch for resolved contracts. Malformed/future contracts and mismatched task/project identity fail before agent launch; historical missing contracts use Manual.

Independent Go/security review PASS with race tests; Cloudflare/constitution/docs PASS; test-engineer PASS. Task-completion preflight found no code gaps, but requires final live/CI/deploy evidence before archive. Root build/lint/typecheck PASS. New API SQLite suite 19 PASS; real Go restored-host/settings tests PASS; existing bootstrap/recovery43 and snapshot/runner/container84 PASS; Instant/capture20 PASS.

Source Idea updated with implementation and remaining proof. Shared staging handoff obtained and combined candidate3c9792edd deployed successfully in run37611247210, including smoke tests. Live acceptance remains pending; see contention evidence below.

## Rollout safety review correction

Final independent review found a concrete Instant mixed-version rollout gap: older containers ignore an unknown runtimeContract field. The authenticated live agent-capabilities endpoint now advertises contract version 1, and both restore transports require it before POST restore. A missing, unsupported or malformed capability refuses restore and preserves recovery evidence. VM probes cannot wake/restart a runtime, Instant probes reuse the configured port-ready timeout. This also protects self-hosted VM installations without VM_AGENT_REQUIRED_VERSION. Backward-compatible old callers without a contract retain conservative legacy behavior. Go capability/restore regressions PASS, 51 transport/state-machine tests PASS, and 41 real integration/contract tests PASS. Official evidence: https://developers.cloudflare.com/containers/guides/deploy/ .

Migration collision reconciled before first contract deployment: webhook PR2260 has already applied `0184_webhook_credential_claims.sql` on staging. A read-only D1 ledger query confirms our contract migration was never applied. Only our unapplied file is renumbered to `0185_session_runtime_contract.sql`; webhook migration remains unchanged. Latest main remains294556e89 and webhook PR remains open.

## CI and supplementary review evidence

PR2261 head83e91c943 CI37610510567 completed SUCCESS: API Test, Durable Object Workers, Go unit/integration/E2E/smoke, lint/typecheck/build and required preflight/specialist gates. Full local other workspace tests passed 19 turbo tasks, including web336files/4023tests. Final bounded API suite11512 tests passed after correcting two fixture expectations; independent focused54-test rerun passed. Go full suite and targeted server/ACP race suites passed.

Local full Workers suite completed1342/1343 passing with one unrelated existing randomized expected-order assertion; isolated credential file four tests passed and full CI Workers passed. Follow-up evidence is tracked in `tasks/backlog/2026-10-07-credential-limits-randomized-order-assertion.md`. No production change added for that flake.

Independent Go/security, Cloudflare/constitution/docs and test-engineer reviews passed. Completion preflight found no implementation gaps but remains WARN until live acceptance is complete; task is not archived. Supplementary Cloudflare/security review also passed the temporary flag-only automation, kept on a separate staging branch and excluded from this PR.

## Coordinated staging state and preserved evidence

Combined3c9792edd includes final contract code83e91c943, sibling wake-ready0498e292e and archive7b774b216. Deployment37611247210 and smoke tests passed; Workerbf2f0be9-2ac1-464c-8550-8cda9e327cba advertised required VM agent1f7b6c0b2. Read-only D1 ledger confirmed both existing webhook0184 and additive contract0185 applied.

A conflicting webhook deployment37613801900 was cancelled after it activated Worker342740d0-b85b-4ff7-a16b-38c727d0ddf8 at11:32:19Z with a different script and required agent153b0401. Owner explicitly released staging. Parent assigned recovery coordinator01M4B28P7RY8Y9DPXEG8YJ81TB to restore the exact combined candidate before tests resume; no wake evidence from a mismatched candidate will be claimed.

Three ACP flags remain at their original false values. The local read token rejected a flag PATCH403 without changes. Independently reviewed flag-only GitHub automation branch16b5305eb uses existing staging deployment credentials and preserves all other bindings/configuration; queued run37614333054 was cancelled before execution because of the conflict. No owned Manual session has been created yet.

Shared Sol VM conversation task01M4B1NAFZRYJ5JRD3AN463EXK is sleeping; retain its original conversation mode for chat and archive proof. Separate original task-mode sessions are required for completion/git proof. The first Sol Instant task01M4B1WMXBKPP3FF2Q37GBDP0V failed initial clone before sleep because its generated output branch did not exist upstream. Independent Go review identified an owned-fixture-branch/same-task public API retry workaround; the separate launch parity bug is tracked in Idea01M4B29WPWZSXSVFSKMTEV69T7. No duplicate dispatch, direct D1 lifecycle mutation or model/profile substitution is authorized by this workaround.

Live Manual card answer, restored task completion/push/PR, final cleanup, CodeRabbit best-effort observation, completion validation, merge and production deployment remain outstanding.

### Final coordinated rollout and live checks (12:37 UTC)

Final combined `a1d340864b580dbe28d00a051c2f309aa02370cc` reconciles shipped main `2aa6ceac5`. Staging deployment and smoke run `37617669770` passed. Coordinator verified API version `5a86cabc-3d5b-4b28-8578-94fbcbd6a31f`, web assets, required VM binary and container, and unchanged D1 migration ledger. Temporary interaction flags were enabled by reviewed flag-only run `37620485248`; all other 355 bindings and Worker code stayed unchanged. Active settings version is `a7db0912-6107-40a6-a5ba-411d303d9c43`. Restore all three flags after Manual proof.

The original Sol VM conversation really slept and woke on one replacement node after normal managed node deletion. Saved and restored contracts retain `gpt-6.1-sol`, `auto`, original task identity and `conversation` mode. Exact wake reply and actual Go ACP start/ready/ACK evidence passed. Go callback log at 12:29:45 confirms `taskMode=conversation`, `skipped=true`, `pushed=false`, no error. Coordinator owns normal UI re-Sleep and Archive last; reuse that same node for sequential fixtures.

Delivery sibling's single replacement Sol Instant task really slept and woke, with ordered A/B replies, actual ACP producer evidence and durable ACKs. Both snapshot and session retain the original task contract. Correction to earlier fixture diagnosis: the failed initial launch was specific to the Artifacts fixture; the Instant branch guard already exists but intentionally skips Artifacts. `/tasks/:id/run` is VM-only and does not preserve full Instant profile overrides, so it was rejected. Parent authorized one replacement on the existing GitHub fixture; the failed owned task/profile were cleaned up.

The Instant restored task callback automatically staged the harmless fixture. Its test checkout lacked Git identity; after configuring only a local test identity, the callback automatically committed `1abaebbe39efcbd8176aec3c08329a0508d620bc`. No agent manually staged, committed, pushed or created a PR. Remote delivery exposed a directly blocking runtime command boundary: the standalone credential helper requires `SAM_WORKSPACE_ID`, but runtime callback commands inherited only the VM-agent process environment. Ordinary agent push dry-run succeeds; the same read-only dry-run without workspace identity and startup tokens fails with terminal prompts disabled. The narrow fix binds standalone commands to trusted launch identity and uses the existing installed GitHub refresh shim, discarding stale inherited tokens. Root review plus independent CF/security/docs review passed; actual-command regression race tests passed. Full Go and coordinated follow-up staging remain pending. Do not claim completion, archive or merge until real push/PR, Manual answers, cleanup and final validator pass.

### Restored task delivery and final shared PR boundary (12:52 UTC)

The VM task's real sleep at 12:41:15 was followed by the standard five-minute stopped-workspace teardown TTL. Wake safely waited for runtime-deletion confirmation, then restored the same task. Actual Go logs at 12:48:32 prove `taskMode=task`, `skipped=false`, `pushed=true`, commit `4272b81a77a3f4f16f0e6e5b27eaba1b0be9d084`, original task identity and no git error. The queued wake was not retried manually. Snapshot background capture after teardown was claimed was correctly refused; no archive lifecycle bug or bypass was introduced.

Live PR creation exposed a second directly blocking pre-existing callback bug: literal `--head HEAD` was rejected by GitHub with `Head ref must be a branch`. Completion now passes the actual pushed branch as a separate argument. Meaningful VM/Instant creation and existing-PR fallback regressions pass with race detection; full Go passes (server 30.039s). Root and independent security/docs reviews passed. Both necessary callback fixes will be validated in one coordinated increment. The same VM task was parked by confirmed Sleep200 at 12:51:24 with its snapshot/commit/branch preserved; it will be awakened after the increment to prove real PR creation before explicit completion. Sequential Manual VM proof uses the same node. Instant remains the same retained fixture. Curated credential-free progress evidence is under `tasks/evidence/2026-10-07-session-runtime-contract/progress.json`; it explicitly marks incomplete acceptance and pending cleanup.

### Manual VM proof and safe staging release (13:09 UTC)

The genuine post-sleep VM Write permission card reached the user despite changing only the temporary profile from Manual to Bypass after sleep. Restored D1 contract still has `permissionMode=default`, original model, ACP permission/form/URL configuration and original conversation callback context. Interaction `882e99ad-be15-4b54-827f-4c359a97bc34` was answered through the real browser with exact agent option `Yes`; UI showed `Delivered to agent`, API receipt is `delivery_confirmed` (answer1791378243143, confirm1791378244423), Write completed, exact reply `CONTRACT_MANUAL_VM_ANSWERED`, idle1791378245970, zero browser errors. Root visually inspected the cropped request/answer images. Credential-free immutable proof: `manual-vm.json`, `manual-vm-request.png`, `manual-vm-answered.png` in the task evidence directory.

Owned Manual task/profile DELETE200 completed; an in-flight pending snapshot was removed through the owned chat's public Archive/stop endpoint, which returned `stopped`, `workspaceDeleted=true`; subsequent scoped snapshot count is zero. Only completed agent-session audit metadata remains. Temporary interaction flags were restored by run `37625901804` with readback all three false, 355 bindings unchanged and identical code ETag. Active settings revision `0803a503-f405-4593-a6e1-8f9975dbbae4`. Both same Sol task fixtures are safely sleeping with contracts/commits retained. Runtime released the shared lease to the coordinator for one reviewed combined increment `356438b9d817ff99a9a81f39d90c8d22307ee469`. No wake or flag mutations until new artifact provenance is confirmed. Post-increment VM/Instant auto-PR and explicit task completion, Manual Instant, final cleanup, task validator, merge and production proof remain pending.
