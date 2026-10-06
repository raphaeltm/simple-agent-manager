---
title: CLI OpenAPI Contract
description: The CLI-facing REST API contract and how to regenerate it.
---

The CLI-facing REST API contract is defined in `apps/api/src/openapi/sam-cli.ts` and checked in as `apps/api/openapi/sam-cli.openapi.json`.

The live API serves the same document at:

```text
GET /api/cli/openapi.json
```

Regenerate the checked artifact after changing CLI-facing API routes or response shapes:

```bash
pnpm --filter @simple-agent-manager/api openapi:generate
```

Check that the artifact matches the source document:

```bash
pnpm --filter @simple-agent-manager/api openapi:check
```

The current slice intentionally covers only the endpoints consumed by `packages/cli/internal/cli/client.go`. It does not attempt to describe all admin, internal, callback, or browser-only routes. Go CLI code generation with `oapi-codegen` should consume `apps/api/openapi/sam-cli.openapi.json`; wiring generated Go types/client into `packages/cli` is a follow-up so this PR can first establish a tested API contract boundary.

The CLI-facing contract now includes `resourceRequirements` on task submission, `resourceRequirementsJson` on listed profiles/triggers, and provider-native node hardware fields (`providerInstanceType`, `providerInstanceVcpuCount`, `providerInstanceMemoryMb`, `providerInstanceDiskGb`). Legacy `vmSize` and `vmSizeOverride` remain compatibility labels; CLI output must label legacy-only hardware as an unknown compatibility estimate rather than fabricating a SKU.
