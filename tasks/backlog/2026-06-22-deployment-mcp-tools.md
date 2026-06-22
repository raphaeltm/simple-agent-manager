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

- [ ] Inspect current parent branch MCP registration and schema/handler patterns.
- [ ] Inspect deployment environment routes/services for access checks, config CRUD, and logs.
- [ ] Design tool names/descriptions/input schemas with narrow project/environment scoping.
- [ ] Implement `list_deployment_environments` for accessible environments.
- [ ] Implement `read_deployment_logs` for accessible environments/deployments with existing log filters.
- [ ] Implement `list_deployment_environment_config` with plaintext variable values and masked secret metadata only.
- [ ] Implement `set_deployment_environment_config` for variables and secrets, preserving existing validation/encryption/rate-limit behavior.
- [ ] Ensure every handler verifies project/session/agent access and never exposes decrypted secret values.
- [ ] Add or update MCP tests covering success paths, unauthorized access, missing resources, secret masking, var writes, secret writes, and log reads.
- [ ] Run focused tests and quality checks.
- [ ] Run specialist review before archiving the task.
- [ ] Open a stacked PR based on PR #1381.

## Acceptance Criteria

- [ ] Agents can list deployment environments they are authorized to access.
- [ ] Agents can read logs only for deployment environments/deployments they are authorized to access.
- [ ] Agents can list environment config for authorized environments, including non-secret values and secret keys/metadata without decrypted values.
- [ ] Agents can set variables and secrets for authorized environments using existing config validation and encrypted storage paths.
- [ ] Unauthorized project/environment access returns MCP errors without leaking whether inaccessible resources exist beyond existing API behavior.
- [ ] No MCP tool returns decrypted secret values, raw encrypted payloads, or sensitive values in error details.
- [ ] The PR is stacked on #1381 and does not modify the parent branch.

## Test Plan

- [ ] MCP unit/worker tests for each new tool.
- [ ] Realistic D1-backed or route-stack tests for environment access and config rows where existing patterns support it.
- [ ] Regression tests for secret masking and secret write behavior.
- [ ] Focused `mcp.test.ts` or equivalent MCP test suite.
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` or documented focused equivalents if the full suite is blocked by pre-existing failures.
