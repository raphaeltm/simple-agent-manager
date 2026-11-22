# Remove the dead registry push-credentials route and vm-agent types

## Problem

`POST /api/projects/:id/registry-push-credentials`
(`apps/api/src/routes/projects/registry-push-credentials-callback.ts`, mounted in
`apps/api/src/index.ts`) mints Cloudflare registry pull+push credentials for a workspace's publish.
Nothing calls it: the vm-agent publish path is R2-first (`packages/vm-agent/internal/publish/orchestrator.go`
uploads image archives as bucket artifacts). `routeMintPushCredentials` in
`packages/vm-agent/internal/publish/controlplane.go` and the `PushCredentials` /
`PushCredentialsRequest` types in `orchestrator.go` have no users. This is dead code on a
credential-minting path (rule: no dead code).

Affects hosted SAM code (the Worker route), so it needs its own PR with the usual gates.

## Context

Found 2026-11-22 during self-host multi-box step 3 (registry evidence,
`tasks/active/2026-11-22-selfhost-registry-evidence.md`, task 01M8265E185QAYMQJH7VESFK19).

## Acceptance Criteria

- [ ] Confirm with a search of every vm-agent release still supported by rollout compatibility
      (rule 54) that no shipped agent calls the route; if an old agent can, keep the route until
      that agent ages out and record why
- [ ] Remove the route, its mount, its tests, the unused Go constant and types, and
      `targetRef` (`orchestrator.go`, used only by `orchestrator_test.go`) with its tests
- [ ] `mintProjectRegistryCredential` keeps only the pull callers (`deploy-release-callback.ts`,
      `deployment-release-image-resolver.ts`); decide whether the legacy pull path is still
      needed: on a box it never has credentials, and nothing pushes to SAM's Cloudflare namespace
      any more; remove `REGISTRY_HOST` pull minting if hosted production has no such images
- [ ] Docs and API reference no longer mention registry push credentials
