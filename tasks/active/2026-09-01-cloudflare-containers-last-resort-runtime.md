# Cloudflare Containers Last-Resort Runtime

## Problem

SAM should keep Cloudflare Containers enabled, but ordinary dispatched agent work must prefer VM placement because container runtime is more expensive. Production investigation on 2026-09-01 found live container agents were not VM-provisioning fallbacks; agents explicitly passed `runtime: "cf-container"` through the MCP dispatch tool, including over a VM-backed profile.

## Research Findings

- `apps/api/src/services/workspace-runtime.ts` currently treats only user and project cloud credentials as VM-capable. Platform credentials fall through to `zero-config`, which can incorrectly classify hosted/platform-backed work as container-suitable.
- `apps/api/src/services/placement-resolver.ts` centralizes task-start runtime normalization. Before this change it only treated explicit container decisions as Instant; no-credential `zero-config` needed to remain a real container fallback while platform-backed decisions moved to VM.
- `apps/api/src/routes/mcp/dispatch-tool.ts` is the production path that let agents pass `runtime: "cf-container"` over a VM profile.
- `apps/api/src/routes/mcp/tool-definitions-task-tools.ts` currently describes containers as a fast path with no cloud credential and no VM sizing. That wording encourages expensive container use instead of last-resort use.
- `apps/api/src/durable-objects/sam-session/tools/dispatch-task.ts` does not expose a runtime override and dispatches through VM placement.
- `tasks/archive/2026-07-20-fix-dispatch-task-runtime-routing.md` identified runtime-selection drift across task-start entry points as the prior bug class.
- `tasks/archive/2026-07-10-cf-container-task-teardown-audit.md` documents the cost-sensitive cleanup risks of paid task-backed container runtime.

## Implementation Checklist

- [x] Update runtime decision policy so platform credentials resolve to VM by default.
- [x] Preserve explicit `cf-container` behavior for intentionally Instant profiles/requests when the container runtime is enabled.
- [x] Preserve no-credential `zero-config` container behavior as the actual last-resort path.
- [x] Update placement resolver coverage so a no-credential container decision routes to Instant, while platform credentials route to VM.
- [x] Update MCP dispatch tool guidance to describe `cf-container` as explicit/last-resort, not a normal fast path.
- [x] Update docs/configuration references that describe zero-config runtime selection.
- [x] Add/update focused tests for platform credential, no-credential, explicit container, and tool-schema guidance behavior.
- [x] Run targeted API tests plus lint/typecheck/build gates appropriate for the changed files.
- [x] Run local specialist review: task-completion-validator, cloudflare-specialist, constitution-validator, doc-sync-validator, and test-engineer.
- [ ] Deploy to staging if the final code change requires runtime validation; otherwise document why local tests are sufficient.

## Acceptance Criteria

- Cloudflare Containers remain enabled behind `CF_CONTAINER_ENABLED=true`.
- Automatic/default runtime resolution uses VM when project, user, or platform cloud credentials exist.
- Container runtime is still reachable when explicitly requested and enabled.
- A no-cloud-credential runtime decision can still choose container as last resort.
- MCP `dispatch_task` tool text tells agents to use `cf-container` only when explicitly requested by the human/profile or when no project, user, or platform VM credential is available. It also tells agents to report VM placement/provisioning failures instead of silently switching runtimes.
- Regression tests would fail if platform credentials again fell through to `zero-config` container selection.

## Post-Mortem

- **What broke**: Agents saw `cf-container` as an ordinary dispatch option and used it for review/audit work even when VM profiles and VM capacity existed.
- **Root cause**: Runtime affordance and resolver policy drifted from the desired economics. The tool schema marketed containers as fast/no-credential; the resolver did not treat platform cloud credentials as VM-capable.
- **Timeline**: The dispatch runtime override was introduced in the July 2026 runtime-routing work. Production evidence on 2026-09-01 showed agents using it directly rather than as fallback.
- **Why it was not caught**: Tests covered explicit routing mechanics, but not the cost-policy invariant that platform-backed automatic work should stay on VMs.
- **Class of bug**: Runtime cost-policy drift at an agent-facing dispatch boundary.
- **Process fix**: Add behavioral tests for the platform-credential branch and keep agent-facing tool descriptions aligned with runtime economics, not just capability availability.

## Validation

- `pnpm --filter @simple-agent-manager/shared build` — passed.
- `pnpm --filter @simple-agent-manager/providers build` — passed.
- `pnpm --filter @simple-agent-manager/cloud-init build` — passed.
- `pnpm --filter @simple-agent-manager/api test -- tests/unit/services/workspace-runtime.test.ts tests/unit/services/placement-resolver.test.ts tests/unit/routes/mcp.test.ts` — passed, 3 files / 264 tests.
- `pnpm --filter @simple-agent-manager/api test -- tests/unit/routes/mcp.test.ts` — passed, 1 file / 241 tests after strengthening and final-aligning MCP guidance assertions.
- `pnpm --filter @simple-agent-manager/api typecheck` — passed.
- `pnpm --filter @simple-agent-manager/api lint` — passed.
- `pnpm --filter @simple-agent-manager/api build` — passed.
- `pnpm --filter @simple-agent-manager/www build` — passed, 186 pages built.
- `pnpm --filter @simple-agent-manager/www build` — passed again after the final self-hosting/Instant credential wording cleanup, 186 pages built.
- `task-completion-validator` — passed after the strengthened MCP guidance assertion.
- `cloudflare-specialist` — passed after aligning docs/tool text to avoid claiming silent VM-failure fallback.
- `constitution-validator` — passed; no new hardcoded URLs, timeouts, limits, or deployment-specific identifiers.
- `doc-sync-validator` — passed in main-thread review; docs/tool text match code semantics for VM-first credentials, explicit/profile Instant, no-credential fallback, and no silent runtime switch after VM failure.
- `test-engineer` — passed; targeted route/service coverage exercises platform VM default, no-credential container fallback, explicit container routing, and VM-only field rejection.
