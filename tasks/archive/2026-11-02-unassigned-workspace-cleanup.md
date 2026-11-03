# Recover unassigned direct-provisioning workspace deletion

## Scope

Complete and release distinct existing PR2497; original PR2458 cleanup is already confirmed and provider upgrade shipped via2484. Tracking idea01M68ZK972ZAP9YD4BZSD1H1S2. Do not mutate closed2458 branch or bypass deletion proof. No new VM, credential expansion or forced DB state.

## Research

- Own workspace01M68Z6WYTAYJ1F048V7SCXREG remains stopping/node_idNULL/deletionproofNULL. Oldnode01M68Z6WJV8ZK41HE8EVWW7GYJ absent; deleted_by_owner audit at2026-10-31T16:18:16.702Z.
- workspace-deletion.ts requires nodeId for VM deletion; node-row absence/audit alone are not strict proof.
- Deterministic workspace-create:<id> NodeLifecycle retains direct-provisioning intent including exact original node/incarnation/placement credential generation.
- Exact credential resolver and complete fail-closed Hetzner inventory already exist. Other provider inventory is not accepted as absence proof.
- Existing finalizer fences workspace owner/project/chat/generation and propagates lifecycle closure. Reuse existing DELETE; no admin endpoint/UI needed.

## Checklist

- [x] Inspect current cleanup, task credential-generation metadata, and node audit read-only.
- [x] Implement narrowly fenced terminal-intent/provider absence confirmation for unassigned explicit deletion, requiring the original strict-owner deletion audit.
- [x] Preserve blocking behavior for active/foreign/reassigned intent, in-flight provisioning, credential rotation, existing/ambiguous/incomplete provider inventory.
- [x] Prove behavior with real D1/DO and provider HTTP tests; run relevant type/lint checks.
- [x] Independent Cloudflare/security/completion review; fix findings.
- [x] Original staging cleanup: runtime9e620672c supported DELETE200confirmed/GET404 and primary D1 workspace/node absence at2026-11-02T16:32:08Z, zero newVM/provider mutation.
- [x] Final-candidate staging deployment/API and desktop/mobile projects/settings navigation; coordinated active2494 and serial dependency owners.
- [x] Exact-head CI/Sonar/E2E/Preflight/Specialist review evidence green at18accf31d68a9cc02ac2cc9d92132b263aabb2c8.
- [ ] Release follow-through tracked in PR2497 and local.do-state.md: CodeRabbit request/wait, merge and basic production smoke; retain cleanup evidence (original2457 handoff already complete).

## Acceptance

Authenticated explicit DELETE can finish this unassigned orphan only after original durable intent matches ownership/generation and terminal provisioning cannot replay, exact original Hetzner credential generation resolves, and complete provider inventory proves original node allocation absent. Changed/unknown state remains pending. Existing finalizer supplies terminal proof/lifecycle consistency. Actual staging workspace and node absent after supported cleanup. No repeated provisioning, forced DB writes or credential expansion.

## Design review

Independent Cloudflare/security/constitution review PASS. This historical recovery requires an immutable original credential generation, complete inventory across all incarnations, and the original strict owner-deletion audit. Merged #2496 refuses empty inventory while a node-present allocation remains unresolved; this node-absent path additionally requires a prior completed strict owner deletion. A fabricated historical timeout is not used as proof. Terminal saved intent stays sealed under its DO lock; active work rejects reconciliation. Empty inventory or missing node rows alone never authorize this recovery.

## Local validation

Final direct-provisioning Workers suite: 27 passed, including authenticated DELETE confirmed/pending, real D1/DO/provider HTTP and ProjectData closure, exact-account/no-fallback, ownership drift, terminal replay, live inFlight rejection, and manual-attestation audit rejection. Three removed safety guards caused the intended assertion failures; all source mutations were restored. Existing deletion/finalizer/node-cleanup compatibility regressions: 114 passed. Combined #2494 fix plus #2497 Workers suites: 44 passed (17 manual, 27 direct). Root lint/typecheck/build and sequential root tests (21 tasks, including 14,653 API tests) passed. Independent Cloudflare/constitution, completion/tests/doc-sync and adversarial security reviews passed. Final-candidate staging/release evidence follows below.

## Completion continuation (2026-11-03)

Explicit current user authorization covers release after all gates; original draft was an agent-created separation from completed dependency work, not a human hold. Reconciled no active2497 owner and completed original task. Main970edd000 (including2496) merged without conflict. Preflight PR impact analysis now references concrete changed paths. Independent fresh security and Cloudflare/constitution reviews found no blocking issue in2497; misleading shared-absence-contract comment corrected. Discriminating replay/inFlight/exact-account/reassignment tests passed. A composite MEDIUM proof-provenance issue against pending #2494 was fixed by its owner at83275fd7488298934930500748c0435ba949a14a: attestation provenance is written atomically and retained through DELETE retry. Fresh independent adversarial re-review and combined44-test Workers execution passed, resolving the finding without a waiver. No forced D1/provider mutation or credential expansion.

Current mainf88e48280 was merged cleanly into candidate18accf31d68a9cc02ac2cc9d92132b263aabb2c8 (own runtime unchanged fromef43a43); coordinated final staging41555611571 succeeded with its smoke tests. Active owners2455/2494 confirmed no staging conflict; no new VMs or test resources created. Production release remains serialized after2455→2452.

## Final-candidate staging evidence (2026-11-03)

Staging41555611571 succeeded, including smoke tests, on18accf31d68a9cc02ac2cc9d92132b263aabb2c8. Cloudflare confirms Worker3f09d96b-e957-4161-8e68-bdbfc166d065 serving this commit at100%. Managed-secret job sx-6da98d34c255f2189db9cf0b4b041e36722afeff72371ba73dfe884becd0d6f4 completed0 at01:06:41Z: login200, healthy API200, projects200, original workspaceGET404; primaryD1 original workspace/node counts0 and changed_dbfalse. Desktop1280x800/mobile375x667 dashboard, projects, project settings General→Infrastructure, and account settings Agents→Infrastructure navigation passed without page errors. Initial screenshot review exposed a setup overlay; dismissed through normal Exit setup, waited for actual destination content, recaptured and reviewed screenshots with no issues. No credentials/provider/database changes, forced cleanup or new VMs/resources. The supported original DELETE200confirmed remains the historical Nov2 evidence; no artificial orphan was recreated.

Runtime sources/tests are identical between reviewedef43a43 and deployed18accf31; the latter only incorporates current main’s workflow/mock-fixture pins. Relevant public API/environment/configuration contracts are unchanged. Final release bookkeeping is documentation-only. Production validation remains basic health/version/deploy marker, never fixture lifecycle tests.

Pre-archive task-completion validator independently PASS at18accf31: research/checklist/acceptance implemented, final live evidence verified, no forgotten implementation work. CodeRabbit, merge and basic production smoke remain explicitly tracked release steps in PR2497/.do-state.md.
