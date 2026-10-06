# PR #1980 integration verification — 2026-09-13

Candidate implementation: `f03c29e6db90260f49cbcdd9317c7aa0da7c62f5`, based on main `c2f035b35`.

## Local verification

- Full TypeScript package coverage suites passed. Final API run: 718 files / 9,755 tests. Web: 308 files / 3,749 tests.
- Full root lint (13 tasks), typecheck (19 tasks), and build (9 tasks) passed; final API typecheck and affected lint passed after the last module extraction and SDK update.
- Quality/deployment script suite: 610 tests passed with one worker. Two initial fixture deadline failures under concurrent execution passed unchanged in the serialized run.
- All 15 structural quality commands, migration ordering, format ratchet, preflight and specialist evidence checks passed.
- Current-tree and PR-range secret scans passed with zero new findings.
- Entire VM-agent Go module passed race testing with coverage and vet. Final affected config/resource/persistence/server race tests and extraction regressions also passed.
- Docker-backed bootstrap and ACP integration passed, as did VM E2E and both mock-control-plane and real-Worker VM smoke suites.
- One pre-existing asynchronous ACP test assertion was corrected to wait for its actual result; 100 race repetitions passed. A cold external devcontainer tool build exceeded the fixture deadline on its first run; after warming the unchanged fixture, full ACP integration passed.
- Real shared UI components passed Playwright mobile/desktop normal, stress, empty and 30-card checks. Start action and no horizontal overflow asserted; screenshots reviewed and corrected badge/mobile title defects recaptured.

## Reviews

Go/security/resource, API/lifecycle/admission, Cloudflare, sysinfo/generation, independent adversarial, UI/UX, constitution/environment/documentation and implementation completion reviews passed after findings were addressed. Final completion review passed implementation and owned VM evidence; overall workflow remains incomplete because global staging cleanup and downstream merge gates are open.

## CI

GitHub CI run `34747092182`: all applicable jobs passed, including the rerun specialist evidence check. Fresh SonarCloud analysis of documentation head `5d9a52ca0` completed at 09:13:17 UTC: quality gate OK, zero bugs and vulnerabilities. All 24 applicable PR checks passed (six path-based skips). Eighteen maintainability smells were independently reviewed without correctness/security blockers; no findings were waived or suppressed.

## Staging

Deployment [34747674165](https://github.com/raphaeltm/simple-agent-manager/actions/runs/34747674165) and standard smoke passed. The workspace eviction fencing migration applied at 08:32:57 UTC; after the 2026-09-14 main merge it was renumbered to `0164_workspace_eviction_fencing.sql` to follow main's `0157`–`0163` migrations.

- One real Hetzner VM ran the exact implementation agent SHA. Independent heartbeat 08:50:29.755 arrived 9.084 seconds after readiness; workspace running by 08:51:55.
- Terminal passed 09:01:29. A real Claude ACP turn passed 09:02:47 (34.887 seconds, synthetic response marker).
- Three short 4GiB pressure attempts did not trigger eviction. A read-only probe confirmed 2GiB swap; the final bounded 6GiB/90-second process triggered Docker OOM eviction. No host cgroup or swap settings were changed.
- Workspace eviction/accounting/session closure recorded 09:24:02.760; serialized finalization 09:24:06.180. Post-eviction node heartbeat 09:24:29.732 and system-info remained healthy.
- The existing pending snapshot row became available with no degradation. A fresh capture generation began 09:22:32 during the stress run; row created_at predates capture and is not a freshness assertion. Both home and WIP artifact/checksum metadata were present; artifacts were not downloaded.
- Live desktop/mobile screenshots were reviewed: Evicted status and Start action readable, no horizontal overflow. Clicking Start restarted by 09:27:35 with a new generation and metering record. Terminal readback confirmed the sentinel file survived.
- Own workspace and node cleanup completed 09:28:21.449; strict node DELETE acknowledged termination 09:28:20.780. No own resource remains. Staging serialization window released.

Inherited cgroup boot configuration is supported by pinned provisioning, matching main templates/generator, 176 cloud-init tests, and host survival under load. This is not a claim that the installed host cgroup verifier or a direct ancestry inspection ran. PSI logic has automated coverage; the live eviction exercised Docker OOM.

Historical state recorded on 2026-09-13 (superseded by the follow-up below): global zero remained unproven; previous run's node `01M2CX7B90KKPSJFPWJGX0JP6M` was still destroying with no provider instance ID or termination proof. Both this and the own allocation used user credentials; a platform-only orphan scan cannot prove that account's inventory. Historical deleted rows predating termination-proof tracking are not evidence of live VMs. An unrelated sleeping Cloudflare Container is preserved.

## Merge gate

No merge performed. Global zero-VM proof, final-head CI, CodeRabbit agreement, merge and production deployment remain required. The completion review found no new implementation gaps; tasks remain active until these gates finish.

## PR #1980 review-fix validation — 2026-09-14

Conflict resolution rebased the PR branch onto `main` while preserving the layered resource-management behavior, including task-lifecycle placement guards and explicit eviction restart reservation. The eight CodeRabbit comments from 2026-09-13 18:26 UTC were addressed with targeted changes:

- Terminal eviction callback responses now use the shared `errors.gone()` path.
- Evicted callback retries replay ProjectData/compute finalization before terminal-node rejection.
- Evicted restart failures before runtime dispatch stop compute tracking.
- Cleanup-only stop retry no longer depends on an operational node.
- Stopped/evicted WorkspaceCard Start uses the 56px shared button size.
- Legacy VM-agent container discovery is bounded by a configurable compatibility timeout.
- Eviction delivery completion is fenced by attempts and payload revision after payload upgrades.
- Timestamp and quantity spacing in this evidence file was corrected.

Focused local validation passed:

```bash
pnpm --filter @simple-agent-manager/api test -- tests/unit/routes/workspace-eviction-real-sql.test.ts tests/unit/routes/workspace-restart-deletion-race-real-sql.test.ts tests/unit/services/workspace-placement.test.ts
pnpm --filter @simple-agent-manager/web test -- tests/unit/WorkspaceCard.test.tsx tests/unit/components/workspace-card.test.tsx
pnpm --filter @simple-agent-manager/api typecheck
pnpm --filter @simple-agent-manager/web typecheck
pnpm --filter @simple-agent-manager/api exec eslint src/routes/projects/workspace-eviction-callback.ts src/routes/workspaces/lifecycle.ts src/routes/workspaces/workspace-stop.ts src/services/workspace-placement.ts tests/unit/routes/workspace-eviction-real-sql.test.ts tests/unit/routes/workspace-restart-deletion-race-real-sql.test.ts
pnpm --filter @simple-agent-manager/web exec eslint src/components/WorkspaceCard.tsx tests/unit/WorkspaceCard.test.tsx tests/playwright/fixtures/native-hardware-harness.tsx
cd packages/vm-agent && /tmp/sam-go-toolchain/go/bin/go test ./internal/container ./internal/persistence ./internal/server
pnpm --filter @simple-agent-manager/web exec playwright test tests/playwright/native-hardware-display.spec.ts --config=playwright.native-hardware.config.ts --grep "workspace-card (normal|long)"
git diff --check
```

Playwright result: 5 passed and 1 skipped by the existing 320px long-scenario matrix. Fresh reviewed screenshots are in [`../2026-09-14-pr1980-review-fixes/`](../2026-09-14-pr1980-review-fixes/).

## Shepherd follow-up — 2026-09-14 after 18:00 UTC

Independent review of `a44d14e93` confirmed the eight fixes were already present,
while GitHub still had eight unresolved threads (five with outdated anchors).
The restart fix required additional hardening: workspace-wide usage closure could
end a successor interval, and a failed restart left `error` status so another
restart skipped eviction admission and metering.

The follow-up uses a runtime-generation-specific usage ID. Before VM dispatch,
failure closes only that interval and restores the original evicted identity under
the attempt's identity/generation CAS. Retry performs fresh admission and billing.
An ambiguous failure after dispatch retains the new generation, reservation and
metering because the runtime may have started. Boot-log and metering setup share
the failure handler; a metering insert failure prevents dispatch.

Fresh validation: four new regressions failed against the inherited implementation;
83 focused SQL/admission tests pass after the fix. Independent API reviewer ran
37 SQL tests and passed Cloudflare/test/constitution review. Go/security reviewer
passed 10 focused race tests plus 2 subtests. Completion validator passed all six
implementation checks. Full gates, final staging and downstream CI are pending.

### Inherited CodeRabbit thread audit

All findings were valid when made. “Outdated” describes GitHub's old source anchor,
not a reason to dismiss a finding. None is being waived as obsolete behavior.

| Review comment | GitHub anchor at triage | Disposition and verification |
| --- | --- | --- |
| 4000469562: callback errors | Outdated | Addressed in `1606e7749`: `terminalResourceResponse` throws `errors.gone`; real SQL route tests retain standard error handling. |
| 4000469565: eviction finalization | Outdated | Addressed in `1606e7749`: evicted replay/finalization precedes terminal-node rejection; real SQL test covers terminal node after interrupted cleanup. |
| 4000469567: restart billing | Current | Further hardened in this follow-up: exact attempt interval, retryable pre-dispatch rollback, preserved reservation/billing after uncertain dispatch. Real SQL tests prove actual row state instead of mocking the cleanup helper. |
| 4000469568: cleanup-only Stop | Current | Addressed in `1606e7749`: operational-node guard skipped only with confirmed Stop proof. Regression moves node to stopped/unhealthy and verifies cleanup without a repeated VM stop. |
| 4000469571: Start target size | Current | Addressed in `1606e7749`: actual shared Button uses `size="lg"` (56 px). Existing component tests and September 14 reviewed desktop/mobile screenshots retained. |
| 4000469575: discovery deadline | Outdated | Addressed in `1606e7749`: compatibility resolver creates a configured timeout context. Focused discovery race tests passed again. |
| 4000469578: payload upgrade fence | Outdated | Addressed in `1606e7749`: monotonic payload revision joins attempts in completion DELETE predicate; stale completion after upgrade remains queued. Focused persistence race tests passed again. |
| 4000469579: evidence spacing | Outdated | Addressed in `1606e7749`: timestamp and quantity examples in this verification file have spaces. |

### Exact remaining provider evidence gap

Read-only staging checks after first checking deploy-staging runs found no active
deployment, no non-deleted VM node rows, and no row for prior allocation
`01M2CX7B90KKPSJFPWJGX0JP6M`. Its workspace `01M2CX7BFQ64E1KY2E91148Y5C`
remains `stopping` with a null node attachment. No retained termination marker,
event-outbox receipt or observability deletion receipt establishes provider cleanup.
The available orphan reconciliation path inventories platform credentials only;
the prior allocation used user credentials. No authenticated inventory of that
user/provider account is available through the existing read paths. Zero D1 rows
and platform-only inventory cannot prove zero VMs in that relevant account.

**credential/infra blocker; provider-side confirmation of user-credential Hetzner VM cleanup is unavailable to agents.**

Keep `needs-human-review` and do not merge unless that provider inventory is
actually proven clear. No staging resources were created or modified during the
read-only inventory investigation.

Fresh local gates for implementation `214aa4f5d`:

- Root lint: 13 tasks passed; root typecheck: 19 tasks passed.
- Root test: 21 tasks passed, including API 734 files / 9,989 tests and web
  308 files / 3,749 tests. Root build: 9 tasks passed.
- Full VM-agent `go test -race ./...` and `go vet ./...` passed using Go 1.26.6.
- Fresh Playwright workspace-card audit: 5 passed, 1 existing narrow-long skip.
  Desktop/mobile Evicted/Start and long-text screenshots were inspected; no clipping,
  overflow or unreadable status/action was found.
- Checksum-verified Gitleaks 8.30.1: current tree 50 reviewed / 0 new findings;
  PR range 0 findings. Agent-context budget measured after the reference correction.
- Preflight evidence passed with a real pull-request event payload. Specialist
  evidence fails only because the required `needs-human-review` label remains.
- All eight GitHub threads were replied to with evidence and resolved. CodeRabbit
  skipped the pushed commit with “Bot user detected”; its successful status is not
  a new approval. The latest substantive review remains the September 13 review.
- Full Workers suite is still running. Its overlapping TaskRunner start test hit
  the previously recorded intermediate-step timing assertion; the entire affected
  file passed unchanged on isolated retry (31 tests, 63.17 seconds).
