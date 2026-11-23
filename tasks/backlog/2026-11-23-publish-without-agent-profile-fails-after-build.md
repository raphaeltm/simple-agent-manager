# Agent publish from a task without an agent profile fails after the build

## Problem

`build_and_publish` (`apps/api/src/routes/mcp/compose-publish-tools.ts`) accepts a publish from a
task that has no agent profile. The environment policy (`isDeploymentPolicyAllowedForProfile`)
allows it when `allowedDeployProfileIds` is empty, and the tool passes
`agentProfileId: policyResult.taskAgentProfileId || null`. The VM publisher then refuses:
`packages/vm-agent/internal/publish/orchestrator.go:205`, `publish: empty agentProfileID`.

It refuses only after `compose config` and `docker compose build` have run, so the agent wastes a
build and sees `publish_failed` with `retryable: true`, which invites retries that fail the same way.

## Context

Found 2026-11-23 on a disposable self-host box during PR #2987 (box uploads). A task submitted
without `agentProfileId` failed twice this way (jobs `01M841XXYH7V16YTP981WGVRQE`,
`01M841Y6RG3QX5NZJTFKG4TAN1`). The same task with a profile published fine. Not box-specific: the
check is in the vm-agent and the API path is shared.

## Acceptance Criteria

- [ ] The API and the vm-agent agree: either the tool refuses a profile-less publish up front with a
      clear, non-retryable error, or the publisher accepts an empty profile id when the policy allows it.
- [ ] The decision is made before any build work starts.
- [ ] A test drives `build_and_publish` from a profile-less task through the real policy.
