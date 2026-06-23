# R2-first compose-publish image transport

## Problem

Compose-publish app deployments currently expose broad Cloudflare Registry credentials to build nodes for push and deployment nodes for pull. The MVP should prioritize project/user isolation over registry-layer performance by transporting build-backed service images through server-scoped R2 artifacts instead.

This task must stop at an open PR. Staging deployment and staging mutation are explicitly forbidden for this run.

## Research Findings

- API MCP build-and-publish entrypoint: `apps/api/src/routes/mcp/compose-publish-tools.ts`.
- Publish-side VM agent flow: `packages/vm-agent/internal/server/mcp_build.go` calls `packages/vm-agent/internal/publish`, which currently obtains registry push credentials, logs in, tags, pushes, and submits release metadata.
- Registry push credential route: `apps/api/src/routes/projects/registry-push-credentials-callback.ts`.
- Compose-publish release recording route: `apps/api/src/routes/projects/compose-publish-release-callback.ts`; current tests live in `apps/api/tests/unit/routes/compose-publish-release-callback.test.ts`.
- Deploy apply route/service: `apps/api/src/routes/deploy-release-callback.ts` and `apps/api/src/services/compose-publish-apply.ts`; current tests cover digest-pinned `pushedRef` transforms and registry credential response shape.
- Deploy signing: `apps/api/src/services/deploy-signing.ts` and `packages/vm-agent/internal/deploy/signature.go`; artifacts must be signed, not only compose/routes/env.
- Deployment VM agent flow: `packages/vm-agent/internal/deploy/{types.go,signature.go,engine.go,compose.go}`; current path logs into a registry, pulls, then runs `docker compose up`.
- R2 presign patterns already exist in `apps/api/src/services/attachment-upload.ts` and its tests.
- Existing docs/spec context: `apps/www/src/content/docs/docs/guides/app-deployments.md`, `specs/005-automated-deployment/*`, retained credential and deployment lessons in `.claude/rules/`.

## Implementation Checklist

- [x] Add API types and services for compose image artifacts: server-derived keys, upload init/complete metadata validation, download access generation, and release descriptors.
- [x] Extend compose-publish release recording to persist service artifact descriptors alongside legacy pushed refs.
- [x] Update MCP/control-plane publish contract so VM agent uploads per-service Docker archives to R2 using server-scoped URLs/keys and submits size/hash/archive metadata.
- [x] Update VM agent publish flow to build, capture compose YAML, export one archive per build-backed service, hash it, enforce the MVP size cap, upload directly to R2, and avoid registry login/tag/push for the R2 path.
- [x] Update compose-publish apply transform so artifact-backed services use local SAM image refs with pull policy `never`, while provider services pass through and image-only public services keep unauthenticated pulls.
- [x] Remove deployment-node `registryCredentials` from the new R2-backed compose-publish apply path while preserving compatibility where legacy releases still require it.
- [x] Extend TS deploy signing and Go verifier with an artifacts hash; include artifact keys, hashes, sizes, refs, archive type, and platform in the signed surface.
- [x] Update deployment VM agent to download scoped R2 artifacts, verify byte size and SHA-256, load/tag local images before compose up, and skip/limit compose pull for artifact-backed services.
- [x] Add focused API unit/route tests for artifact upload init/complete/finalize scoping and release recording.
- [x] Add compose transform tests for local refs, `pull_policy: never`, multi-service build artifacts, provider services, image-only public services, volumes, ports, labels, and networks.
- [x] Add TS/Go deploy signing contract fixture coverage for `artifactsHash`.
- [x] Add VM-agent Go tests for no registry login on R2 payloads, artifact tamper rejection, hash mismatch failure, load failure, pull skipping/limiting, and local tagging before compose up.
- [x] Update docs or PR notes with MVP limitations: external image-only policy and multipart status.
- [x] Run local quality checks and specialist reviews; do not use staging.

## Validation

- `pnpm lint` passed with existing repository warnings.
- `pnpm typecheck` passed.
- `go test ./...` passed in `packages/vm-agent`.
- Focused API tests passed for compose image artifacts, compose-publish apply, deploy signing, compose-publish release callback, and deploy release callback.
- Focused Go tests passed for `./internal/publish` and `./internal/deploy`.
- `pnpm test` ran the full suite; API passed 340 files / 5610 tests. The full command failed on one unrelated web timing test in `tests/unit/components/agents-section.test.tsx`, and the exact focused rerun passed 8/8 tests.
- `pnpm build` passed.
- Specialist reviews completed locally: Cloudflare/R2, security, Go, test engineering, constitution compliance, and task-completion validation.
- Staging validation was intentionally skipped by explicit human instruction; no staging deploys or staging mutations were performed.

## Acceptance Criteria

- New compose-publish releases can carry build-service R2 artifact descriptors with server-derived keys and recorded size/hash/archive metadata.
- Publish-side R2 path does not request or use broad registry push credentials.
- Deploy apply for R2-backed releases does not return registry credentials to deployment nodes.
- Artifact-backed services are signed, downloaded through scoped access, verified, loaded/tagged locally, and run without registry pulls.
- Legacy registry-backed behavior remains compatible where older release records still depend on it.
- Tests cover the security boundary, signing boundary, compose transforms, and Go deploy engine behavior.
- PR body clearly states staging validation was intentionally skipped by explicit human instruction.
- PR remains unmerged.

## References

- SAM idea `01KVFN7NEECY56VCPKG5D1QV02`: R2-first scoped image transport for app deployments.
- SAM task `01KVSRFT5MZGEVGFED61C90W52`.
- Knowledge preference: prioritize R2-scoped image transport over registry-token performance for app deployments.
