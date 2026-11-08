# VM Agent Integration: npm missing from the devcontainer Node feature

## Problem

`TestIntegration_InstallAgent_Devcontainer_WithNodeFeature`
(`packages/vm-agent/internal/acp/install_integration_test.go`) fails in CI with
`Error: Cannot find module '/usr/local/share/nvm/current/bin/npm'` (Node.js v22.23.4) when it
checks that npm is present from `ghcr.io/devcontainers/features/node:1` on
`mcr.microsoft.com/devcontainers/base:debian`. Both references float, so an upstream feature or
image release can change the result without a repository change.

## Context

Seen twice on 2026-11-05 on the live-steering draft PR (#2536, CI runs 41978096615 and
41982747882). That branch does not touch the test or its fixtures. The same job passed on
`main` at 2026-11-05T01:49Z (run 41951127872), so the change is likely upstream.

## Acceptance Criteria

- [ ] Reproduce with the current feature/image and identify what changed (nvm layout, npm shim).
- [ ] Either pin the feature/base image versions used by the test or adapt the npm check to the
      new layout, so the test reflects what SAM's installer actually needs.
- [ ] VM Agent Integration passes on `main` again.
