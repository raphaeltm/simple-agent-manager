# Integrate ACP permissions and validate staged roundtrip

## Problem

The reviewed ACP runtime bridge in PR #2201 and project-chat permission UI in PR #2200 are independently green, but the combined candidate has not been reconciled or proven through the real browser → Worker `InteractionStore` → live VM/Instant runtime → ACP callback path. The integration must remain dormant in production and must be handed to the parent as a draft PR with exact, bounded evidence.

## Preflight

- Classes: `cross-component-change`, `business-logic-change`, `security-sensitive-change`, `ui-change`, and `infra-change` because the candidate spans the web app, Worker/runtime contracts, VM agent, and deployment validation.
- Authority: approved v2 idea `01M3P2E0JJNQRXX020P65ZRKEJ`, parent reviews on PRs #2200/#2201, and this task's explicit staging-only authorization.
- Source pins: UI `e13a166b5b14860b99922211927dc1e0941087a4`; runtime `96df904f7f847b84a2cb86df98439a19634a8612`. Both exact heads have green CI as of 2026-09-30.
- Data flow: `apps/web` reads/answers the project-session interaction routes; the Worker stores encrypted interaction details and routes a committed exact-option answer through the no-wake delivery service; `packages/vm-agent` resolves the waiter bound to workspace/session/runtime/connection generation and returns the ACP callback result.
- Rollout: `ACP_INTERACTIONS_ENABLED` remains globally false. Only the coordinated staging deployment may override it for the test. Forms and URL elicitation remain unadvertised.
- Security: request and answer canaries must remain absent from events, transcripts, logs, and unauthorized reads. Creator authorization is rechecked; noncreator and cross-project callers receive no detail or mutation authority.
- Constitution: configuration continues to use the centralized typed environment/default contract. Integration fixes may not add hardcoded URLs, timeouts, limits, or identifiers.
- Shared staging is reserved by task `01M3REWHQEVNFNB5CC5G5KJ5WX` until it explicitly releases the environment. GitHub and Cloudflare live state must be checked before mutation.

## Research findings

- PR #2200 owns the real chat surface, refresh/reconnect behavior, exact option selection, authorization eviction, delivery-state rendering, and desktop/mobile audit fixtures. It deliberately does not change Worker/runtime contracts.
- PR #2201 replaces raw viewer broadcast and first-option selection with the durable create/wait/settle bridge, fresh connection generations, exact-option receipts, and VM/Instant no-wake delivery. It deliberately does not change the web UI.
- The reviewed runtime follow-up uses direct Instant container-port forwarding because the pinned container helper can start stopped compute. Stale persisted-running/actually-stopped races are therefore staging-blocking invariants.
- The pinned ACP SDK derives permission request context from the connection. SAM therefore binds permission ownership to the active prompt attempt, and the staged fixture must prove a later request remains usable after cancellation/deadline of an earlier attempt.
- Source PR unit/CI evidence is necessary but insufficient: acceptance requires one pinned integrated staging sweep through the real UI and live runtimes.
- Fixture behavior and actual harness behavior are different evidence classes. Codex under SAM `never`/`full-access` may emit no permission request; Claude supports emission. No live external-account success may be claimed without direct evidence.
- No source branch may be changed. Any integration or harness fix belongs only on this integration branch and must be called out separately for parent review.

## Implementation checklist

- [ ] Merge the exact reviewed source heads into the current-main integration branch without changing either source branch.
- [ ] Reconcile conflicts and inspect the combined diff for contract, flag, privacy, and runtime compatibility issues.
- [ ] Add only narrow integration/harness fixes required for the combined candidate and identify them separately.
- [ ] Run focused web, Worker vertical-slice, VM agent, fixture, lint, typecheck, build, and relevant repository checks.
- [ ] Re-run desktop/mobile permission-card screenshots against the integrated candidate and review layout, overflow, accessibility, and normal-chat behavior.
- [ ] Complete task-completion, Cloudflare, Go, UI/UX, security, environment, constitution, documentation, and test reviews; resolve blocking findings.
- [ ] Wait for the current staging owner to release the environment, then query active GitHub deploys and Cloudflare live state before any mutation.
- [ ] Deploy exactly one pinned integration commit to staging with staging-only ACP permission enablement and record the deploy/run/commit.
- [ ] Exercise the real UI → Worker `InteractionStore` → live runtime → ACP callback roundtrip on both VM and Instant using the deterministic reversed-option fixture.
- [ ] Prove a second request without reconnect; browser disconnect/reconnect; duplicate and conflicting answers; lost delivery receipt; creator/noncreator/cross-project authorization; canary-safe events/transcript/logs; cancellation/deadline/Stop/process loss; recreated generation; feature-off/version skew; and stopped/stale-running no-wake behavior.
- [ ] Record actual Codex SAM `never`/`full-access` emission and Claude supported emission separately from fixture results, without unsupported account claims.
- [ ] Confirm normal chat remains functional and review mobile/desktop staging screenshots.
- [ ] Delete only integration-owned staging workspaces/nodes immediately and prove zero owned VMs remain at rest.
- [ ] Create and maintain a draft integration PR with exact deployed commit, resource IDs, fixtures, requests/results, bounded observability, cleanup, integration fixes, and remaining gaps.
- [ ] Send the final branch/head/PR/CI/staging evidence to parent task `01M3RT1PBZNM57EMC00B7ZXAEK`; do not merge or mark ready.

## Acceptance criteria

- The integration branch is based on the then-current `main` and contains both exact reviewed heads, with no pushes to either source branch.
- Production defaults remain false; no forms or URL capability is advertised; only staging receives the temporary test override.
- VM and Instant each complete the exact-option permission roundtrip through the real UI and Cloudflare authority, with reversed fixture options proving order is not authority.
- Reconnect, repeat-request, idempotency/conflict, authorization, lifecycle, generation, version/flag, privacy, and no-wake cases have direct staged or clearly identified deterministic evidence.
- Fixture, pinned harness, and actual Codex/Claude emission claims are clearly separated and truthful.
- Normal chat and mobile/desktop UI remain healthy.
- The evidence names the exact deployment commit/run and staging resources, and owned staging compute is fully cleaned up.
- The integration PR remains draft and unmerged for parent review.

## References

- Approved v2 idea `01M3P2E0JJNQRXX020P65ZRKEJ`
- PR #2200 and parent review comment `5909839236`
- PR #2201 and parent review comment `5909503211`
- `.claude/rules/13-staging-verification.md`
- `.claude/rules/22-infrastructure-merge-gate.md`
- `.claude/rules/35-vertical-slice-testing.md`
- `apps/api/.claude/rules/34-vm-agent-callback-auth.md`
- `packages/vm-agent/.claude/rules/27-vm-agent-staging-refresh.md`
- `packages/vm-agent/.claude/rules/54-vm-agent-rollout-compatibility.md`
