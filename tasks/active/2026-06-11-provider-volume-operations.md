# Provider Volume Operations for App Deployment

## Problem Statement

SAM app deployments need provider-native block volumes as first-class resources in `packages/providers`. Persistent environment data must live on attached provider volumes, not node root disks, so future node replacement can detach and reattach data volumes.

## Research Findings

- SAM MCP task instructions require output branch `sam/implement-first-class-provider-01ktwd`.
- Required library docs `app-deployment/04-data-volumes-and-resiliency.md`, `02`, and `08` were requested, but `list_library_files` failed recursively and the root listing only returned unrelated root files. Directory listings for `/app-deployment/` and `app-deployment/` returned no files. Implementation is based on the task description, existing archived app-deployment slice context, current code, and official provider API references.
- `packages/providers/src/types.ts` defines the `Provider` interface and keeps provider credentials constructor-injected. `VMConfig` intentionally contains only non-secret operational data.
- `packages/providers/src/hetzner.ts` uses Hetzner Cloud API via `providerFetch`, maps provider payloads with validation helpers, and has normalized `ProviderError` category mapping.
- `packages/providers/src/scaleway.ts` uses Scaleway Instance API with user `secretKey` and `projectId`, searches across known zones for existing servers, and maps tags to labels.
- Official Hetzner Cloud API references expose volume endpoints under `/volumes`, with actions at `/volumes/{id}/actions/attach`, `/detach`, and `/resize`. Hetzner docs state volumes are location-scoped, min 10 GB, max 10 TB, and up to 16 volumes can be mounted on one server.
- Official Scaleway Block Storage API uses `/block/v1/zones/{zone}/volumes` for create/list/get/update/delete. Size is bytes and volumes are AZ-scoped. Attaching/detaching a block volume to an Instance uses Instance API endpoints `/instance/v1/zones/{zone}/servers/{server_id}/attach-volume` and `/detach-volume`; docs state block volumes must be in the same Availability Zone and one Instance can attach up to 15 block volumes at a time.
- Volume lifecycle conventions from the task: provider abstraction should document/extents `ext4` creation format, mount root `/mnt/sam-env-{environmentId}/`, and fstab `nofail`; node-side mount enforcement is out of scope.

## Implementation Checklist

- [ ] Add provider-agnostic volume types and lifecycle conventions in `packages/providers/src/types.ts`.
- [ ] Extend `Provider` with volume capability metadata and operations: create, attach, detach, resize, delete, get, list.
- [ ] Add validation payload helpers for Hetzner and Scaleway volume responses.
- [ ] Implement Hetzner volume operations using the Hetzner Cloud Volumes API.
- [ ] Implement Scaleway volume operations using Block Storage plus Instance attach/detach endpoints.
- [ ] Surface provider constraints through metadata, including min size, grow-only resize, co-location, attach limit, default format, mount root template, and fstab options.
- [ ] Ensure shrink requests are rejected in the provider layer before API calls.
- [ ] Add unit tests with mocked HTTP for exact Hetzner payloads/endpoints, constraints, grow-only rejection, attach limit metadata, and error mapping.
- [ ] Add unit tests with mocked HTTP for exact Scaleway payloads/endpoints, constraints, grow-only rejection, attach limit metadata, and error mapping.
- [ ] Run package-level typecheck, lint, and tests.

## Acceptance Criteria

- [ ] `Provider` exposes first-class volume lifecycle operations.
- [ ] Location/zone is explicit in create, attach/detach, get/list, and resize APIs where provider APIs need it.
- [ ] Hetzner implementation supports create, attach, detach, resize up only, delete, get, and list using user API token.
- [ ] Scaleway implementation supports equivalent operations at the current package support level using user secret key and project ID.
- [ ] Provider constraints are exposed through metadata instead of hardcoded by callers.
- [ ] Volume lifecycle conventions are encoded in package types/docs for future cloud-init/agent consumers.
- [ ] Unit tests assert exact provider API payloads and error mapping.
- [ ] Existing VM provisioning paths are not regressed by provider interface changes.

## References

- SAM task `01KTWD21EQX9BHMGG8YG60585A`
- Official Hetzner Cloud API reference: `https://docs.hetzner.cloud/reference/cloud`
- Official Hetzner Volumes FAQ: `https://docs.hetzner.com/cloud/volumes/faq/`
- Official Scaleway Block Storage API reference: `https://www.scaleway.com/en/developers/api/block`
- Official Scaleway Block Storage CLI/API guide: `https://www.scaleway.com/en/docs/block-storage/api-cli/use-block-storage-cli/`
- `packages/providers/src/types.ts`
- `packages/providers/src/hetzner.ts`
- `packages/providers/src/scaleway.ts`
- `.claude/rules/02-quality-gates.md`
