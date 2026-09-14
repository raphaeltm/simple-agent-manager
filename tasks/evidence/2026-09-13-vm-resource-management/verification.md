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

Global zero remains unproven: previous run's node `01M2CX7B90KKPSJFPWJGX0JP6M` is still destroying with no provider instance ID or termination proof. Preserve it. Both this and the own allocation used user credentials; a platform-only orphan scan cannot prove that account's inventory. Historical deleted rows predating termination-proof tracking are not evidence of live VMs. An unrelated sleeping Cloudflare Container is preserved.

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
