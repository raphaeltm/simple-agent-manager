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

- [x] Merge the exact reviewed source heads into the current-main integration branch without changing either source branch.
- [x] Reconcile conflicts and inspect the combined diff for contract, flag, privacy, and runtime compatibility issues.
- [x] Add only narrow integration/harness fixes required for the combined candidate and identify them separately.
- [x] Run focused web, Worker vertical-slice, VM agent, fixture, lint, typecheck, build, and relevant repository checks.
- [x] Re-run desktop/mobile permission-card screenshots against the integrated candidate and review layout, overflow, accessibility, and normal-chat behavior.
- [x] Complete task-completion, Cloudflare, Go, UI/UX, security, environment, constitution, documentation, and test reviews; resolve blocking findings.
- [x] Wait for the current staging owner to release the environment, then query active GitHub deploys and Cloudflare live state before any mutation.
- [x] Deploy exactly one pinned integration commit to staging with staging-only ACP permission enablement and record the deploy/run/commit.
- [x] Exercise the real UI → Worker `InteractionStore` → live runtime → ACP callback roundtrip on both VM and Instant using the deterministic reversed-option fixture.
- [x] Prove a second request without reconnect; browser disconnect/reconnect; duplicate and conflicting answers; lost delivery receipt; creator/noncreator/cross-project authorization; canary-safe events/transcript/logs; cancellation/deadline/Stop/process loss; recreated generation; feature-off/version skew; and stopped/stale-running no-wake behavior.
- [x] Record actual Codex SAM `never`/`full-access` emission and Claude supported emission separately from fixture results, without unsupported account claims.
- [x] Confirm normal chat remains functional and review mobile/desktop staging screenshots.
- [x] Delete only integration-owned staging workspaces/nodes immediately and prove zero owned VMs remain at rest.
- [x] Create and maintain a draft integration PR with exact deployed commit, resource IDs, fixtures, requests/results, bounded observability, cleanup, integration fixes, and remaining gaps.
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

## Integration-only fix

The runtime slice introduced six typed/documented configuration overrides used by the permission start contract, but the reusable deploy workflow and Wrangler synchronization allowlist did not forward them. This made the documented knobs inert in deployed environments and prevented a staging operator from pinning runtime limits independently of built-in defaults. The integration branch adds the six names to both reusable deployment phases, the synchronization allowlist, and its deployment contract test:

- `ACP_INTERACTION_PERMISSION_TASK_DEADLINE_MS`
- `ACP_INTERACTION_PERMISSION_CONVERSATION_DEADLINE_MS`
- `ACP_INTERACTION_DEADLINE_MARGIN_MS`
- `ACP_INTERACTION_OPTION_ID_MAX_CHARS`
- `ACP_INTERACTION_RUNTIME_RECEIPT_LIMIT`
- `ACP_INTERACTION_RUNTIME_RESPONSE_MAX_BYTES`

No default value or production flag changed. `scripts/quality/deploy-reusable-workflow.test.ts` passes with all 47 deployment assertions.

The integrated Playwright audit also exposed a deterministic tablet timing race in its geometry helper: it queried the conditionally rendered jump button before waiting for that button to appear, although the failure snapshot showed the button moments later. The integration branch waits for the accessible button to become visible before running the DOM geometry calculation. This changes test synchronization only; production UI behavior is unchanged.

Cloudflare review found that the Instant no-wake path returned `RUNTIME_STOPPED` safely but answer delivery classified that terminal response as an ambiguous transport failure. The integration branch now records it as interrupted immediately, with VM and Instant regression coverage proving a single no-wake capability probe.

Constitution and documentation review found that three typed frontend ACP polling controls were omitted from the Vite build environment. The integration branch forwards all three GitHub Environment overrides, extends the deployment contract test, and synchronizes the public configuration table plus the ACP rollout wording. The checked-in production creation flag remains `false`.

UI review found that the visual audit's geometry checks changed scroll position immediately before capture. The audit now restores the validated anchored-card position before owner desktop/mobile screenshots; the rerun passed 24/24 at 375×667 and 1280×800 after terminating a stale local preview process.

The deterministic fixture exposed a VM/Instant launcher mismatch: VM `docker exec` resolves the ACP adapter with the profile runtime `PATH`, while Instant constructed `exec.Cmd` before applying that environment and therefore searched only the vm-agent host `PATH`. The integration branch resolves local adapter commands from absolute directories in the merged runtime `PATH`, deliberately retaining Go's protection against implicit workspace execution, and adds checked-in Claude/Codex fixture aliases. Focused Go tests prove the local launcher executes an explicitly selected fixture and rejects a relative workspace `PATH`; VM keeps its existing `docker exec` behavior.

Pinned deploy run `36718788997` then failed closed before publishing at the Worker text-binding budget: four staging ACP limit overrides raised the generated count from the 340 guard to 344. The integration branch removes four redundant task-reconciliation timing values from checked-in Wrangler vars; their environment override paths remain available and their existing shared typed defaults are byte-for-byte equivalent. This restores headroom without raising the repository guard or Cloudflare maximum.

## Staging evidence

- Exact candidate `bb853a04eb8247718b5b2ea1f5deacecbe57c955` passed CI run `36719533047`; E2E Smoke `36719533017` and CodSpeed `36719532995` also passed. Deploy run `36722105512` then completed successfully with the temporary staging-only permission overrides. Production configuration was read-only and remained unset; the checked-in default remains `false`.
- Instant fixture session `6104086e-f1da-4119-b9f5-d1675265b7ec` used node `01M3SAZJWS9WH9SNPZPFT0MVZS`, workspace `01M3SAZK3CF6FRBM035ZY272H1`, task `01M3SAZJGCQXFNB6B8R20QGZQ4`, and agent session `01M3SB024DZ6HPWR00GHQBNSSN`. The real project-chat UI selected `allow` from reversed `[reject, allow]` options and received `PERMISSION:allow`; the fixture immediately issued a second request on the same ACP prompt/connection. The browser page was closed and recreated while that request was pending, then selected `reject` and received `PERMISSION:reject`. Interaction records `c0c488f6-021b-4e9b-9542-0c711b66418a` and `f2d4292e-16ef-42a4-ae39-a0b31e661f22` both reached `delivery_confirmed`. The workspace, node, and profile were deleted after capture.
- Centered deployed screenshots `.codex/tmp/acp-cf-container-muo74b3k-desktop.png` and `.codex/tmp/acp-cf-container-muo74b3k-mobile.png` were inspected at 1280×800 and 375×667. The card, deadline, reversed exact-option controls, fixed composer clearance, and surrounding normal project-chat chrome remained legible without horizontal overflow.
- A separate preloaded-fixture session proved normal message transport with `E2E:normal-chat-control-...` before its intentionally unsupported synthetic wake attempt. This is fixture transport evidence, not an actual external-account success claim.
- VM fixture session `79b4bd52-22db-4a62-bef0-9dbe380ad6a5` used node `01M3SDAM8H6C58YWG91S43JWTK`, workspace `01M3SDJSPPBSYKW5DQ5WZF95Q7`, task `01M3SDADS25PPHHTQNQE37H2X4`, agent session `01M3SDS12GDCRFN5JPNARDX19H`, and profile `01M3SDA81TJ7S1HEC2G4E2QRAV`. Its reversed first/second records `e3db99c4-2a21-4bfb-9f51-033655fcf2ca` and `48cfaa87-b070-407f-b658-0317c80759fe` returned `PERMISSION:allow` and `PERMISSION:reject`, then reached `delivery_confirmed` after the browser page was recreated. A later live generation `d0009375-56af-473a-bcd7-27757b690fb2` proved a same-body/same-key replay returns 200 while a new key with a conflicting body returns 409.
- Live authorization checks on that VM generation returned: creator detail/answer success; noncreator structural list 200; noncreator detail 403; noncreator answer 403; cross-project detail 404. The bounded creator transcript, creator snapshot, and noncreator snapshot totaled 5,957 bytes and did not contain `fixture-raw-input-must-not-leak`. The persisted transcripts contained only the selected option results, not raw request/answer material.
- Fresh post-deploy deterministic evidence passed: 50 API config/callback/authorization/cancel tests, 9 Worker `InteractionStore`/vertical tests, 24 permission-card tests, and the focused Go race suite. These cover the 64 KiB contract, feature-off/version behavior, encrypted detail and bounded purge, duplicate/conflicting answers, creator/noncreator/cross-project enforcement, delivery loss, cancellation/deadline/Stop, process/generation fencing, and VM/Instant stopped-runtime no-wake paths. They remain labeled deterministic rather than live runtime proof.
- The two live runtimes prove successful delivery receipts; the deliberately lost/unconfirmed receipt, cancellation/deadline/Stop/process-loss, recreated-generation fencing, feature-off/version-skew, and stopped/stale-running no-wake cases remain deterministic evidence from the named suites rather than staged fault injection. This avoids mislabeling local coverage as deployed proof.
- The preload fixture exercised the pinned Codex ACP process path under SAM `bypassPermissions`/never-full-access configuration and emitted permission requests by design; it is not evidence that actual Codex emits them. No actual Codex account permission emission or actual Claude account emission was proven, so both remain explicit rollout gaps. Claude support here is limited to the reviewed adapter implementation and deterministic SDK fixture coverage.
- After deleting the VM and retained Instant workspace/node/profile through the public API, the authoritative D1 query returned zero nodes outside `deleted`/`failed`. All five temporary staging GitHub Environment overrides were then removed. Restoration deploy `36736535610` republishes the same exact candidate SHA with checked-in `ACP_INTERACTIONS_ENABLED=false`; production was never mutated.
