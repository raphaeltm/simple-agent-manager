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
