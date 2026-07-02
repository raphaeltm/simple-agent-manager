# Cloudflare Managed Devcontainer Cache

## Problem

The GHCR devcontainer cache path cannot push cache images with GitHub App installation tokens. PR #963 proved that Cloudflare managed Containers Registry supports the Docker-native pull/build/tag/push flow SAM already uses, including a real SAM devcontainer image. The production path needs to mint short-lived registry credentials in the API/control plane and pass them to the VM agent without installing Wrangler on VM nodes.

## Research Findings

- `packages/vm-agent/internal/cache/cache.go` already provides best-effort Docker login, pull, tag, and push helpers.
- `packages/vm-agent/internal/bootstrap/bootstrap.go` currently derives `ghcr.io/<owner>/<repo>:devcontainer-cache` and logs in with the GitHub token. This needs to accept explicit registry credentials and an explicit cache ref.
- `apps/api/src/durable-objects/task-runner/workspace-steps.ts` creates workspaces through `createWorkspaceOnNode()` after node provisioning. This is the right place to mint and pass per-workspace short-lived credentials.
- `packages/vm-agent/internal/server/workspaces.go` accepts the workspace creation request and stores runtime metadata. The request body needs non-logged cache credential fields.
- `apps/api/src/env.ts`, `packages/cloud-init`, and self-hosting/deploy docs only expose `DEVCONTAINER_CACHE_ENABLED` today.
- Relevant postmortems: project credential security hardening, env-var quote stripping, and devcontainer gitconfig lock failures.

## Checklist

- [x] Add API service for Cloudflare managed registry config, cache ref construction, and short-lived credential minting.
- [x] Pass registry host, username, password, and cache ref from TaskRunner workspace creation to the VM agent.
- [x] Extend VM-agent config/provisioning state to use explicit cache credentials and cache ref when present.
- [x] Preserve existing fallback when Cloudflare registry config is absent.
- [x] Keep registry passwords and tokens out of logs and persisted metadata.
- [x] Add focused API tests for config absence, request construction, ref construction, and response validation.
- [x] Add focused Go tests for config parsing/cache ref precedence and no-password logging behavior.
- [x] Update env docs, self-hosting docs, and deployment secret mapping.
- [x] Run targeted tests, then broader validation as practical.
- [x] Update PR #963 with agent preflight and specialist review evidence.

## Acceptance Criteria

- No Wrangler dependency is added to VM nodes.
- Cloudflare registry credentials are minted in the API/control plane with configurable account ID, token, repository prefix, registry host, and credential TTL.
- VM agent receives Docker registry credentials and cache ref during workspace bootstrap.
- Missing Cloudflare registry config falls back to current behavior.
- Secrets are not logged or persisted in workspace metadata.
- Tests cover the new API and VM-agent behavior.
- Changes are pushed to PR #963 and the PR is not merged.

## Validation

- `pnpm --filter @simple-agent-manager/shared build`
- `pnpm --filter @simple-agent-manager/providers build`
- `pnpm --filter @simple-agent-manager/cloud-init build`
- `pnpm --filter @simple-agent-manager/api test -- tests/unit/services/devcontainer-cache.test.ts`
- `pnpm --filter @simple-agent-manager/api typecheck`
- `pnpm --filter @simple-agent-manager/api build`
- `pnpm --filter @simple-agent-manager/api lint` (passed with existing warnings, 0 errors)
- `pnpm --filter @simple-agent-manager/api exec eslint src/services/devcontainer-cache.ts tests/unit/services/devcontainer-cache.test.ts src/durable-objects/task-runner/workspace-steps.ts src/services/node-agent.ts`
- `go test ./internal/config ./internal/cache ./internal/server`
- `go test ./...`
- `git diff --check`

## PR Evidence

- PR #963 body updated with agent preflight evidence, cross-component data flow, validation, staging caveat, and specialist review evidence.
- Implementation pushed in commit `0af2c518` and follow-up evidence commit.
