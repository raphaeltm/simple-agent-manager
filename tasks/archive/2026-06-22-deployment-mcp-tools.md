# Deployment MCP Tools For Logs, Environments, And Config

## Problem

Agents need a safe deployment-facing MCP surface so they can inspect and manage app deployments without relying on UI-only workflows. The previous deployment UI/config PR (#1381) removed four unsafe or poorly scoped deployment MCP tools while keeping `build_and_publish` as the deploy path. This follow-up should add replacement tools that are explicitly scoped to deployments/environments the agent can access.

Required tools:
- Read logs from deployments/environments the agent has access to.
- List deployment environments the agent has access to.
- List environment config variables/secrets for accessible environments, showing variable values but never decrypted secret values.
- Set variables and secrets for accessible environments.

## Research Findings

- Parent session `d2d3a20b-d55c-4d85-81ca-babd51ab1350` showed PR #1381 as the combined parent branch for deployments UI subpages, unified Variables/Secrets config, Compose interpolation, test hardening, and MCP cleanup.
- GitHub verification on 2026-06-22 shows PR #1381 is still open and mergeable, branch `sam/use-sam-mcp-tools-01kvr3`, head `1ed24a48`, base `main`.
- The stacked implementation branch is `sam/use-sam-mcp-tools-01kvrr` and must be based on the parent PR head, not directly on `main`.
- PR #1381 removed `apps/api/src/routes/mcp/deployment-tools.ts` style tools because they mixed user-facing deployment operations with incomplete authorization/product semantics. Replacement tools must use the newer deployment control surface and access checks.
- Existing deployment environment config behavior from #1381 is the product path: variables can be read, secrets are write-only/masked, and deployment config must flow through the config service rather than exposing decrypted secret values.
- Existing deployment logs APIs and deployment environment APIs should be reused rather than duplicating node access logic.
- App deployment MCP tool exposure must not create/apply deployments before the human control surface is ready. This task only exposes inspection and environment config management, not new deployment creation/apply tools.

## Relevant Rules And Skills

- `AGENTS.md`: call SAM `get_instructions`, review parent session with `get_session_messages`, and use SAM task status updates.
- `.codex/prompts/do.md` and `.claude/rules/14-do-workflow-persistence.md`: maintain `.do-state.md`, task file, commits, validation, specialist review, and PR.
- `.claude/rules/35-vertical-slice-testing.md`: feature crosses MCP route, access checks, D1/service code, and deployment log proxy boundaries.
- `$api-reference`: API/MCP route surface.
- `$cloudflare-specialist`: Worker/D1 route patterns.
- `$security-auditor`: credential and secret visibility boundary.
- `$test-engineer`: realistic tests for critical access/config behavior.
- `$constitution-validator`: no hardcoded limits or deployment-specific identifiers.

## Implementation Checklist

- [x] Inspect current parent branch MCP registration and schema/handler patterns.
- [x] Inspect deployment environment routes/services for access checks, config CRUD, and logs.
- [x] Design tool names/descriptions/input schemas with narrow project/environment scoping.
- [x] Implement `list_deployment_environments` for accessible environments.
- [x] Implement `read_deployment_logs` for accessible environments/deployments with existing log filters.
- [x] Implement `list_deployment_environment_config` with plaintext variable values and masked secret metadata only.
- [x] Implement `set_deployment_environment_config` for variables and secrets, preserving existing validation/encryption/rate-limit behavior.
- [x] Ensure every handler verifies project/session/agent access and never exposes decrypted secret values.
- [x] Add or update MCP tests covering success paths, unauthorized access, missing resources, secret masking, var writes, secret writes, and log reads.
- [x] Run focused tests and quality checks.
- [x] Run specialist review before archiving the task.
- [x] Open a stacked PR based on PR #1381.

## Acceptance Criteria

- [x] Agents can list deployment environments they are authorized to access.
- [x] Agents can read logs only for deployment environments/deployments they are authorized to access.
- [x] Agents can list environment config for authorized environments, including non-secret values and secret keys/metadata without decrypted values.
- [x] Agents can set variables and secrets for authorized environments using existing config validation and encrypted storage paths.
- [x] Unauthorized project/environment access returns MCP errors without leaking whether inaccessible resources exist beyond existing API behavior.
- [x] No MCP tool returns decrypted secret values, raw encrypted payloads, or sensitive values in error details.
- [x] The PR is stacked on #1381 and does not modify the parent branch.

## Test Plan

- [x] MCP unit/worker tests for each new tool.
- [x] Realistic D1-backed or route-stack tests for environment access and config rows where existing patterns support it.
- [x] Regression tests for secret masking and secret write behavior.
- [x] Focused `mcp.test.ts` or equivalent MCP test suite.
- [x] `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` or documented focused equivalents if the full suite is blocked by pre-existing failures.

## Review Notes

- Security review: new handlers call `assertAgentDeploymentAllowed` before config/log access, scope environment rows to `tokenData.projectId`, proxy logs only through owned running nodes, encrypt secret writes through `upsertDeploymentEnvironmentConfigVar`, and return masked config responses from `buildDeploymentEnvironmentConfigResponse`.
- Cloudflare/D1 review: no migrations or binding changes are needed; new D1 access uses existing Drizzle tables and existing deployment config storage.
- Test review: `apps/api/tests/unit/mcp-deployment-tools.test.ts` exercises handlers through real deployment-control/config code with a realistic D1 boundary mock, plus node-agent HTTP boundary assertions.
- Constitution review: new deployment log limits use env-overridable defaults via `MCP_DEPLOYMENT_LOG_DEFAULT_LIMIT` and `MCP_DEPLOYMENT_LOG_MAX_LIMIT`.

## Validation

- `pnpm --filter @simple-agent-manager/api typecheck`
- `pnpm --filter @simple-agent-manager/api test -- --run mcp-deployment-tools mcp-build-and-publish mcp`
- `pnpm --filter @simple-agent-manager/api lint`
- `pnpm --filter @simple-agent-manager/api test` (339 files, 5,583 tests)
- `pnpm --filter @simple-agent-manager/api build`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm --filter @simple-agent-manager/api test:workers -- --run deployment-mcp-tools` was attempted while developing the first Worker-pool test version, but the Worker harness crashed with repeated `workerd` segmentation faults before assertions. That unstable test file was replaced by focused Node-side MCP handler coverage.

## Pull Request

- PR #1382: https://github.com/raphaeltm/simple-agent-manager/pull/1382
- Base branch: `sam/use-sam-mcp-tools-01kvr3` (parent PR #1381)
- Head branch: `sam/use-sam-mcp-tools-01kvrr`
