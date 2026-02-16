# DigitalOcean Provider Implementation

**Created**: 2026-02-16
**Status**: Backlog
**Priority**: Medium
**Estimated Effort**: Medium
**Branch**: `feat/multi-provider-support`
**Depends On**: `2026-02-16-provider-infrastructure.md`
**Note**: This provider's `ProviderConfig` variant and `CredentialProvider` union member must be added to `packages/shared` and `packages/providers` when implementing this task — they are NOT pre-defined.

## Context

DigitalOcean is one of the most straightforward providers to implement. Simple Bearer token auth, clean REST API, and a model very similar to Hetzner. Good candidate for the first provider after Hetzner modernization.

## API Research

### Authentication

- **Method**: Bearer token in `Authorization` header
- **Header**: `Authorization: Bearer <api_token>`
- **Base URL**: `https://api.digitalocean.com/v2`

### VM Lifecycle

| Operation | Method   | Endpoint                                               |
| --------- | -------- | ------------------------------------------------------ |
| Create    | `POST`   | `/droplets`                                            |
| Get       | `GET`    | `/droplets/{id}`                                       |
| List      | `GET`    | `/droplets?tag_name={tag}`                             |
| Delete    | `DELETE` | `/droplets/{id}`                                       |
| Power Off | `POST`   | `/droplets/{id}/actions` body: `{"type": "power_off"}` |
| Power On  | `POST`   | `/droplets/{id}/actions` body: `{"type": "power_on"}`  |
| Shutdown  | `POST`   | `/droplets/{id}/actions` body: `{"type": "shutdown"}`  |

### Cloud-Init / User Data

- **Field**: `user_data` in create request body
- **Format**: Plain text (NOT base64)
- **Limit**: 64KB

### Tags / Labels

- Tags are an array of strings (not key-value pairs)
- Create request: `"tags": ["sam:managed", "node:abc123"]`
- Filter on list: `GET /droplets?tag_name=sam:managed`
- **Limitation**: Only filter by ONE tag at a time. Multi-tag filtering must be done client-side.
- Tags must be created first via `POST /tags` (or auto-created on droplet create — verify)

### Key Quirks

1. **IP not in create response** — The create response does NOT include the public IP. Must poll `GET /droplets/{id}` until status is `active` and `networks.v4` is populated.
2. **Status values**: `new`, `active`, `off`, `archive` — no transitional states like `starting`/`stopping`.
3. **No exact 8vCPU/16GB match** — Closest is `s-6vcpu-16gb` (6 vCPU, 16GB). Or `s-8vcpu-16gb-amd` if available in region.
4. **Shutdown vs Power Off** — `shutdown` sends ACPI signal (graceful), `power_off` is hard power cut. Use `shutdown` with fallback to `power_off` after timeout.
5. **Delete is idempotent** — Returns 204 even if droplet doesn't exist (verify).

### Size Mappings

| SAM Size | DO Slug            | vCPU | RAM  | Disk  |
| -------- | ------------------ | ---- | ---- | ----- |
| small    | `s-2vcpu-4gb`      | 2    | 4GB  | 80GB  |
| medium   | `s-4vcpu-8gb`      | 4    | 8GB  | 160GB |
| large    | `s-8vcpu-16gb-amd` | 8    | 16GB | 320GB |

_Note: Verify exact slug availability per region at implementation time._

### Region/Location Mappings

Key regions: `nyc1`, `nyc3`, `sfo3`, `ams3`, `fra1`, `lon1`, `sgp1`, `blr1`, `tor1`, `syd1`

### Validate Token

- `GET /account` — Returns 200 with account info if token is valid, 401 if not.

## Implementation Checklist

- [ ] Add `CredentialProvider` union member to `packages/shared/src/types.ts`
- [ ] Add `ProviderConfig` variant to `packages/providers/src/types.ts`
- [ ] Create `packages/providers/src/digitalocean.ts`
- [ ] Implement `DigitalOceanProvider` class
- [ ] Implement `createVM()` — POST /droplets, then poll for IP
- [ ] Implement `deleteVM()` — DELETE /droplets/{id}, idempotent
- [ ] Implement `getVM()` — GET /droplets/{id}, map to VMInstance
- [ ] Implement `listVMs()` — GET /droplets with tag filter, map to VMInstance[]
- [ ] Implement `powerOff()` — POST shutdown action, fallback to power_off
- [ ] Implement `powerOn()` — POST power_on action
- [ ] Implement `validateToken()` — GET /account
- [ ] Handle IP polling (create returns before IP assigned)
- [ ] Map DO status values to VMInstance status
- [ ] Define size mappings (verify slug availability)
- [ ] Define location list
- [ ] Write contract tests (reuse suite from infrastructure task)
- [ ] Write unit tests with mocked fetch
- [ ] > 90% coverage

## Testing Strategy

- Reuse provider contract test suite from infrastructure task
- Mock all HTTP calls via `providerFetch` mock
- Test IP polling logic (multiple poll cycles)
- Test idempotent delete (404 → success)
- Test tag-based filtering

## Related Files

- `packages/providers/src/types.ts` — Provider interface
- `packages/providers/src/hetzner.ts` — Reference implementation

## Success Criteria

- [ ] `DigitalOceanProvider` passes full contract test suite
- [ ] IP polling works reliably with configurable timeout
- [ ] Tag-based listing filters correctly
- [ ] All unit tests pass with >90% coverage
