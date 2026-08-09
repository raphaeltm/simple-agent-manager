# Integrate durable execution foundations

## Problem statement

The verified VM Agent and Worker/ProjectData durable-execution foundations were completed on separate branches, but their prior integration workspace was destroyed before its protocol repairs were pushed. The surviving commits must be integrated onto current `main` and repaired so both sides implement one exact prompt-receipt protocol, terminal VM checkpoint ownership, and active Worker delivery/reconciliation without including the later supervisor or park/wake work.

This task is SAM task `01KZM7QR5CW8T93FMS8X5CDF7A` on branch `sam/resume-ship-durable-execution-5cdf7a`. Cancelled mission `6009d56f-9a80-4f29-aef6-fcf498edc721` is read-only design evidence and must not be resumed.

## Research findings

- VM foundation tip `9c53b61e2` adds stable prompt epochs, durable receipts, checkpoint rollover, and strict resume, but mission risk `a863a707-cc5f-4bd7-b8fc-b3f702b199e7` records a terminal-ownership race: cancel/deadline/strict-resume failure can still fall through delayed `process.Wait` into a fresh restart or later `Ready`.
- Worker foundation tip `4847cf0b8` adds ProjectData migration 025, the durable mailbox delivery owner, checkpoint episode storage, and handler isolation, but mission risk `88e68232-d34b-4180-a471-23e04157f83b` records that the live JSON request omitted `protocolVersion` and `deliveryId` and used the wrong/flat capability contract.
- Canonical contract `c56ade8f-45e1-4a6f-95a3-117685427aad` requires `GET /workspaces/{workspaceId}/agent-capabilities` with protocol version 1, VM-authoritative runtime identity, nested receipt/rollover capabilities, versioned prompt submission, wrapped responses, epoch-millisecond receipt times, 202 for new acceptance, 200 for duplicates, and exact 404/409 reconciliation semantics.
- Only a positive same-runtime receipt `not_found` result may authorize replay. A changed or unproven runtime after ambiguous delivery is terminal ambiguity.
- Current `main` commit `8c689a6a7` changed Worker control loops after both foundations branched. Integration must preserve its bounded I/O, candidate escape, alarm isolation, operational kill switches, and finite mailbox expiry/attempt semantics.
- Existing ProjectData migrations are append-only and require clean-install plus previous-ledger upgrade coverage. VM protocol changes require fresh-node staging because VM binaries are downloaded only during node provisioning.
- Follow-on supervisor behavior—candidate selection, checkpoint execution generations, cancel/provision fencing, wait subscriptions, terminal child wake, and parent hibernate/restart—is explicitly out of scope.

## Implementation checklist

- [ ] Cherry-pick the complete VM foundation history through exact tip `9c53b61e2`, resolving against current `main` without weakening commit `8c689a6a7`.
- [ ] Cherry-pick the complete Worker foundation history through exact tip `4847cf0b8`, resolving control-loop, migration, fixture, and documentation conflicts against current `main`.
- [ ] Define exact cross-contract protocol-v1 fixtures used by both VM and Worker tests.
- [ ] Align VM capabilities, versioned prompt submission/lookup, wrapped response, receipt fields, time units, and 202/200/404/409 semantics with the canonical contract.
- [ ] Add durable VM terminal ownership and restart suppression so cancel, deadline, process exit, and strict-resume failure cannot create a fresh session or late `Ready`.
- [ ] Add deterministic delayed-`process.Wait` race tests proving no `NewSession`/`Ready` after terminal ownership and exact-once convergence.
- [ ] Serialize `protocolVersion` and `deliveryId` in the Worker’s real prompt request body while preserving legacy callers.
- [ ] Align Worker capability discovery and receipt reconciliation with nested VM-authoritative runtime identity and epoch-millisecond timestamps.
- [ ] Prove replay occurs only after same-runtime positive `not_found`; changed or unproven runtime becomes terminal `ambiguous_delivery`.
- [ ] Preserve the latest main control-loop limits, alarm isolation, finite mailbox expiry, and operational stop controls.
- [ ] Run focused contract, Go race, Miniflare/workerd, migration, and normal prompt/cancel regression suites.
- [ ] Run full repository lint, typecheck, test, build, and quality gates.
- [ ] Run task-completion, Go, Cloudflare, constitution, documentation, and test specialist reviews; address all blocking findings.
- [ ] Delete all staging nodes, deploy the final branch, provision a fresh VM, verify heartbeat/workspace/protocol behavior end to end, and delete all staging test resources so zero VMs remain.
- [ ] Open/update the PR with evidence, obtain green CI, merge, and monitor the matching production deployment to success.

## Acceptance criteria

- Both verified foundation commit histories are present on a branch based on current `main`; their exact source tips and current-main control-loop protections are traceable.
- VM and Worker tests consume byte-equivalent canonical protocol-v1 fixtures for capabilities, new acceptance, duplicate acceptance, receipt lookup, not-found, conflict, and ambiguity cases.
- A versioned Worker request reaches the VM with `protocolVersion` and `deliveryId`; legacy callers retain the existing unversioned path.
- Canonical responses use nested capabilities, VM runtime identity, wrapped prompt responses, epoch-millisecond receipt timestamps, 202 new/200 duplicate, and specified 404/409 meanings end to end.
- Automatic replay is permitted only with positive same-runtime `not_found`; runtime mismatch or inability to prove identity produces terminal ambiguity without invoking the prompt twice.
- VM cancel, deadline, delayed process exit, and strict-resume failure each converge exactly once and cannot produce a later fresh `NewSession` or `Ready`.
- Migration 025 and all ProjectData migrations pass clean-install, upgrade, safety, and workerd/Miniflare tests.
- Full Go tests including `-race`, repository quality gates, specialist reviews, CI, fresh-VM staging verification, cleanup, merge, and production deployment complete successfully.

## References

- Ready idea `01KZK586BN98BRDGKC44V12HT0`
- Cancelled mission `6009d56f-9a80-4f29-aef6-fcf498edc721` (read-only)
- VM foundation `sam/execute-task-using-skill-400hv6` at `9c53b61e2`
- Worker foundation `sam/execute-task-using-skill-5c1np2` at `4847cf0b8`
- `.claude/rules/23-cross-boundary-contract-tests.md`
- `.claude/rules/27-vm-agent-staging-refresh.md`
- `.claude/rules/31-migration-safety.md`
- `.claude/rules/45-durable-object-concurrency-mutex.md`
- `.claude/rules/47-control-loop-io-budget.md`
- `.claude/rules/53-scheduled-handler-isolation-and-liveness-signals.md`
- `.claude/rules/54-vm-agent-rollout-compatibility.md`
