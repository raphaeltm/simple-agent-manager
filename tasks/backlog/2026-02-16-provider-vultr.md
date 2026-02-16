# Vultr Provider Implementation

**Created**: 2026-02-16
**Status**: Backlog
**Priority**: Medium
**Estimated Effort**: Medium
**Branch**: `feat/multi-provider-support`
**Depends On**: `2026-02-16-provider-infrastructure.md`
**Note**: This provider's `ProviderConfig` variant and `CredentialProvider` union member must be added to `packages/shared` and `packages/providers` when implementing this task — they are NOT pre-defined.

## Context

Vultr has a clean REST API similar to DigitalOcean but with some important differences: base64-encoded user data, three separate status fields, no graceful shutdown, and integer-based OS IDs that can change between API versions.

## API Research

### Authentication

- **Method**: Bearer token in `Authorization` header
- **Header**: `Authorization: Bearer <api_key>`
- **Base URL**: `https://api.vultr.com/v2`

### VM Lifecycle

| Operation   | Method   | Endpoint                 |
| ----------- | -------- | ------------------------ |
| Create      | `POST`   | `/instances`             |
| Get         | `GET`    | `/instances/{id}`        |
| List        | `GET`    | `/instances?tag={tag}`   |
| Delete      | `DELETE` | `/instances/{id}`        |
| Halt (hard) | `POST`   | `/instances/{id}/halt`   |
| Reboot      | `POST`   | `/instances/{id}/reboot` |
| Start       | `POST`   | `/instances/{id}/start`  |

### Cloud-Init / User Data

- **Field**: `user_data` in create request body
- **Format**: MUST be base64-encoded
- **Limit**: Research needed (not clearly documented — test at implementation time)

### Tags / Labels

- Tags are an array of strings: `"tags": ["sam-managed", "node-abc123"]`
- Filter on list: `GET /instances?tag=sam-managed`
- One tag filter at a time

### Key Quirks

1. **Three status fields** — Vultr returns `status`, `power_status`, and `server_status` separately:
   - `status`: `pending`, `active`, `suspended`, `resizing`
   - `power_status`: `running`, `stopped`
   - `server_status`: `none`, `locked`, `installingbooting`, `ok`
   - Must combine all three to determine VMInstance status accurately.
2. **`main_ip` is `0.0.0.0` initially** — Like DO, must poll until IP is assigned.
3. **No graceful shutdown** — Only `halt` (hard power off). No ACPI shutdown signal. Consider sending `shutdown` command via SSH/cloud-init script if graceful stop is needed, or just accept hard halt.
4. **No `vc2-8c-16gb` plan** — Use `vhp-8c-16gb-amd` (high performance AMD) instead. Verify availability.
5. **OS IDs are integers** — e.g., Ubuntu 24.04 might be `2284`. These IDs can change. Query `GET /os` to resolve dynamically, or use `iso_id` / `app_id` alternatives.
6. **Delete returns 204** — Verify idempotency (does deleting non-existent instance return 204 or 404?).

### Size Mappings

| SAM Size | Vultr Plan        | vCPU | RAM  | Disk  |
| -------- | ----------------- | ---- | ---- | ----- |
| small    | `vc2-2c-4gb`      | 2    | 4GB  | 80GB  |
| medium   | `vc2-4c-8gb`      | 4    | 8GB  | 160GB |
| large    | `vhp-8c-16gb-amd` | 8    | 16GB | 320GB |

_Note: Verify plan slugs via `GET /plans` at implementation time._

### Region/Location Mappings

Key regions: `ewr` (NJ), `ord` (Chicago), `lax` (LA), `ams` (Amsterdam), `fra` (Frankfurt), `lhr` (London), `nrt` (Tokyo), `sgp` (Singapore), `syd` (Sydney)

Query available: `GET /regions`

### Validate Token

- `GET /account` — Returns 200 with account info if valid, 401 if not.

## Implementation Checklist

- [ ] Add `CredentialProvider` union member to `packages/shared/src/types.ts`
- [ ] Add `ProviderConfig` variant to `packages/providers/src/types.ts`
- [ ] Create `packages/providers/src/vultr.ts`
- [ ] Implement `VultrProvider` class
- [ ] Implement `createVM()` — POST /instances with base64 user_data, poll for IP
- [ ] Implement `deleteVM()` — DELETE /instances/{id}, idempotent
- [ ] Implement `getVM()` — GET /instances/{id}, map triple status to VMInstance
- [ ] Implement `listVMs()` — GET /instances with tag filter
- [ ] Implement `powerOff()` — POST /instances/{id}/halt
- [ ] Implement `powerOn()` — POST /instances/{id}/start
- [ ] Implement `validateToken()` — GET /account
- [ ] Resolve OS ID dynamically via `GET /os` (don't hardcode integer IDs)
- [ ] Map triple status fields to single VMInstance status
- [ ] Handle base64 encoding of user_data
- [ ] Handle IP polling (main_ip `0.0.0.0` initially)
- [ ] Define size mappings (verify plan availability)
- [ ] Define location list
- [ ] Write contract tests
- [ ] Write unit tests with mocked fetch
- [ ] > 90% coverage

## Testing Strategy

- Reuse provider contract test suite
- Test triple-status mapping (all combinations)
- Test base64 encoding of user_data
- Test OS ID dynamic resolution
- Test IP polling
- Test idempotent delete

## Related Files

- `packages/providers/src/types.ts` — Provider interface
- `packages/providers/src/hetzner.ts` — Reference implementation

## Success Criteria

- [ ] `VultrProvider` passes full contract test suite
- [ ] Triple status correctly mapped to VMInstance status
- [ ] User data properly base64-encoded
- [ ] OS IDs resolved dynamically (not hardcoded)
- [ ] All unit tests pass with >90% coverage
