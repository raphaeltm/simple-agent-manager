# Scaleway Provider Implementation

**Created**: 2026-02-16
**Status**: Backlog
**Priority**: Medium
**Estimated Effort**: Large
**Branch**: `feat/multi-provider-support`
**Depends On**: `2026-02-16-provider-infrastructure.md`
**Note**: This provider's `ProviderConfig` variant and `CredentialProvider` union member must be added to `packages/shared` and `packages/providers` when implementing this task — they are NOT pre-defined.

## Context

Scaleway is a European cloud provider with a REST API that has several unusual patterns: cloud-init is set via a separate PATCH after server creation, servers are created in `stopped` state, running servers cannot be deleted, and public IPs must be explicitly requested. These quirks make this a more complex implementation than DO/Vultr/Linode.

## API Research

### Authentication

- **Method**: Secret key in custom header
- **Header**: `X-Auth-Token: <secret_key>`
- **Base URL**: `https://api.scaleway.com/instance/v1/zones/{zone}`
- **Note**: Zone is part of the URL path, not a query parameter
- **Credential fields**: `secretKey` (API secret key), `projectId` (default project UUID)

### VM Lifecycle

| Operation     | Method   | Endpoint                                                                  |
| ------------- | -------- | ------------------------------------------------------------------------- |
| Create        | `POST`   | `/servers`                                                                |
| Get           | `GET`    | `/servers/{id}`                                                           |
| List          | `GET`    | `/servers?tags={tag}`                                                     |
| Delete        | `DELETE` | `/servers/{id}`                                                           |
| Action        | `POST`   | `/servers/{id}/action` body: `{"action": "poweron\|poweroff\|terminate"}` |
| Set user_data | `PATCH`  | `/servers/{id}/user_data/cloud-init` (Content-Type: text/plain)           |

### Cloud-Init / User Data

- **CRITICAL QUIRK**: Cloud-init is NOT set during server creation. It's set via a **separate PATCH call** after the server is created.
- **Method**: `PATCH /servers/{id}/user_data/cloud-init`
- **Content-Type**: `text/plain` (not JSON)
- **Body**: Raw cloud-init YAML text
- **Workflow**: Create server (stopped) → Set user_data → Power on

### Tags / Labels

- Tags are an array of strings: `"tags": ["sam-managed", "node:abc123"]`
- Filter on list: `GET /servers?tags=sam-managed`
- Tags are set during creation

### Key Quirks

1. **Cloud-init set separately** — Three-step create process: (1) POST /servers, (2) PATCH user_data, (3) POST action poweron. More API calls but actually cleaner separation.
2. **Servers created in `stopped` state** — Must explicitly power on after creation and user_data setup.
3. **Cannot delete running servers** — Must `poweroff` first, then `DELETE`. The `terminate` action may handle both (verify).
4. **Public IP not auto-assigned** — Must set `dynamic_ip_required: true` in create request, OR allocate and attach a flexible IP separately.
5. **Image UUIDs are zone-specific** — The UUID for "Ubuntu 24.04" differs per zone. Use label-based lookup: `GET /images?name=ubuntu_noble` in the target zone.
6. **Zone in URL path** — All endpoints include the zone: `https://api.scaleway.com/instance/v1/zones/fr-par-1/servers`. The provider must be zone-aware.
7. **Project ID in request body** — `"project": "<project_id>"` must be included in create request.
8. **Status values**: `stopped`, `stopping`, `starting`, `running`, `locked`

### Size Mappings

| SAM Size | Scaleway Type | vCPU | RAM  | Disk  |
| -------- | ------------- | ---- | ---- | ----- |
| small    | `DEV1-M`      | 3    | 4GB  | 40GB  |
| medium   | `DEV1-XL`     | 4    | 12GB | 120GB |
| large    | `GP1-S`       | 8    | 32GB | 600GB |

_Note: Scaleway's size tiers don't map cleanly to our standard sizes. Verify available types via `GET /products/servers` at implementation time._

### Region/Location Mappings

Zones: `fr-par-1`, `fr-par-2`, `fr-par-3` (Paris), `nl-ams-1`, `nl-ams-2`, `nl-ams-3` (Amsterdam), `pl-waw-1`, `pl-waw-2` (Warsaw)

### Validate Token

- `GET https://api.scaleway.com/account/v3/projects` — Returns 200 if credentials valid, 401 if not.

## Implementation Checklist

- [ ] Add `CredentialProvider` union member to `packages/shared/src/types.ts`
- [ ] Add `ProviderConfig` variant to `packages/providers/src/types.ts`
- [ ] Create `packages/providers/src/scaleway.ts`
- [ ] Implement `ScalewayProvider` class
- [ ] Implement three-step `createVM()` — POST server → PATCH user_data → POST poweron
- [ ] Implement `deleteVM()` — poweroff if running → DELETE, idempotent
- [ ] Implement `getVM()` — GET /servers/{id}, map to VMInstance
- [ ] Implement `listVMs()` — GET /servers with tag filter
- [ ] Implement `powerOff()` — POST action poweroff
- [ ] Implement `powerOn()` — POST action poweron
- [ ] Implement `validateToken()` — GET /account/v3/projects
- [ ] Handle zone-in-URL-path pattern
- [ ] Handle project ID injection in create requests
- [ ] Handle dynamic IP assignment (`dynamic_ip_required: true`)
- [ ] Resolve image UUIDs by label per zone
- [ ] Handle cloud-init as separate PATCH (text/plain content type)
- [ ] Handle "cannot delete running server" constraint
- [ ] Map Scaleway status values to VMInstance status
- [ ] Define size mappings
- [ ] Define location list
- [ ] Write contract tests
- [ ] Write unit tests with mocked fetch
- [ ] > 90% coverage

## Testing Strategy

- Reuse provider contract test suite
- Test three-step create workflow (mock each step)
- Test delete-requires-poweroff flow
- Test zone-in-URL construction
- Test image UUID resolution by label
- Test user_data PATCH with text/plain content type

## Related Files

- `packages/providers/src/types.ts` — Provider interface
- `packages/providers/src/hetzner.ts` — Reference implementation

## Success Criteria

- [ ] `ScalewayProvider` passes full contract test suite
- [ ] Three-step create workflow works reliably
- [ ] Delete handles running servers (poweroff first)
- [ ] Cloud-init set via separate PATCH correctly
- [ ] Zone-specific image resolution works
- [ ] All unit tests pass with >90% coverage
