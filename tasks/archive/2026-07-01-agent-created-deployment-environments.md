# Agent-created deployment environments

## Problem

SAM agents need an MCP path to create deployment environments for their current project. The creator must be a real task with a resolved explicit agent profile, and the created environment must default to agent deployment enabled only for that creator profile. The human project owner remains the ultimate administrator through the existing REST/UI control surface.

Source idea: `01KWF8V7S87SV3SBA5MWJV06KK` — "Agent-created deployment environments with creator-profile ownership".

## Research Findings

- `apps/api/src/routes/deployment-environments.ts` already has the human REST creation/list/get/policy/delete paths. REST creation currently leaves `agentDeployEnabled` false by default, and policy update can enable/disable agent deployment and override `allowedDeployProfileIds`.
- `apps/api/src/services/deployment-control.ts` already centralizes deployment policy helpers: `getTaskAgentProfileId`, `assertAgentDeploymentAllowed`, `assertAgentDeploymentAllowedForProfile`, `encodeAllowedDeployProfileIds`, `uniqueDeployProfileIds`, and `validateAllowedDeployProfiles`.
- `apps/api/src/routes/mcp/deployment-tools.ts` already filters `list_deployment_environments` through `isDeploymentPolicyAllowedForProfile(toDeploymentAgentPolicy(row), taskAgentProfileId)`, so creator-only defaults will naturally hide created environments from other profiles.
- `apps/api/src/services/deployment-environment-summary.ts` is the shared REST response shaper and should include additive creator metadata once schema fields exist.
- `apps/api/src/routes/mcp/tool-definitions-deployment-tools.ts` and `apps/api/src/routes/mcp/index.ts` are the MCP tool definition and dispatch points.
- `apps/api/tests/unit/mcp-deployment-tools.test.ts` has an in-memory Drizzle fake that can be extended to test creation, duplicate conflicts, creator metadata, and list visibility.
- Latest D1 migration is `0079_deployment_volume_node_exclusivity.sql`; deployment environment metadata must be added via an additive `0080` migration. `deployment_environments` has cascading children, so table recreation is prohibited by `.claude/rules/31-migration-safety.md`.

## Implementation Checklist

- [x] Add additive `deployment_environments` creator metadata columns in schema and migration, including user id, agent profile id, task id, workspace id, and creation source as needed for audit.
- [x] Add a reusable service helper that creates an agent-owned deployment environment from MCP context, validates the creator profile exists in the project, preserves duplicate-name conflict behavior, and seeds `agentDeployEnabled = true` plus `allowedDeployProfileIds = [creatorProfileId]`.
- [x] Add `create_deployment_environment` MCP tool definition and dispatcher wiring.
- [x] Implement MCP handler validation: require a real `tokenData.taskId`, require the task to resolve to an agent profile, reject missing/invalid names, and return the shared environment summary.
- [x] Keep REST owner paths able to list, inspect, disable, reassign policy, lifecycle-control, and delete agent-created environments without extra restrictions.
- [x] Add tests covering successful MCP creation, creator metadata, creator-only visibility, denial without task/profile context, duplicate-name conflict, and REST/user policy override behavior where appropriate.
- [x] Update MCP deployment guide wording if needed so agents know they can create an environment when none is available.

## Acceptance Criteria

- [x] MCP agent with an explicit creator profile can create a deployment environment.
- [x] Created environment is visible to the creator profile via `list_deployment_environments` and not visible/usable by a different profile by default.
- [x] Creation without an explicit task/profile context is denied.
- [x] Duplicate names preserve existing conflict behavior.
- [x] Human REST/UI policy update paths can still override allowed profiles and disable the environment.
- [x] Tests cover the access boundary and creator metadata.

## References

- `apps/api/src/db/schema.ts`
- `apps/api/src/db/migrations/0072_deployment_control_surface.sql`
- `apps/api/src/routes/deployment-environments.ts`
- `apps/api/src/services/deployment-control.ts`
- `apps/api/src/routes/mcp/deployment-tools.ts`
- `apps/api/src/routes/mcp/tool-definitions-deployment-tools.ts`
- `apps/api/tests/unit/services/deployment-control.test.ts`
- `apps/api/tests/unit/mcp-deployment-tools.test.ts`
- `.claude/rules/31-migration-safety.md`
