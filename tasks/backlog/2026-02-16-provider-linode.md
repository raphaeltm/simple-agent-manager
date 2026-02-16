# Linode (Akamai) Provider Implementation

**Created**: 2026-02-16
**Status**: Backlog
**Priority**: Medium
**Estimated Effort**: Medium
**Branch**: `feat/multi-provider-support`
**Depends On**: `2026-02-16-provider-infrastructure.md`
**Note**: This provider's `ProviderConfig` variant and `CredentialProvider` union member must be added to `packages/shared` and `packages/providers` when implementing this task — they are NOT pre-defined.

## Context

Linode (now Akamai Cloud) has a straightforward REST API with Bearer token auth. Notable differences from other providers: user_data is nested under `metadata.user_data` and must be base64-encoded, `root_pass` is required when specifying an image, and filtering uses a custom `X-Filter` JSON header.

## API Research

### Authentication

- **Method**: Bearer token in `Authorization` header
- **Header**: `Authorization: Bearer <token>`
- **Base URL**: `https://api.linode.com/v4`

### VM Lifecycle

| Operation | Method   | Endpoint                                   |
| --------- | -------- | ------------------------------------------ |
| Create    | `POST`   | `/linode/instances`                        |
| Get       | `GET`    | `/linode/instances/{id}`                   |
| List      | `GET`    | `/linode/instances` (with X-Filter header) |
| Delete    | `DELETE` | `/linode/instances/{id}`                   |
| Shut Down | `POST`   | `/linode/instances/{id}/shutdown`          |
| Boot      | `POST`   | `/linode/instances/{id}/boot`              |

### Cloud-Init / User Data

- **Field**: `metadata.user_data` in create request body (nested object)
- **Format**: Base64-encoded
- **Note**: The `metadata` object must be present: `{ "metadata": { "user_data": "<base64>" } }`

### Tags / Labels

- Tags are an array of strings: `"tags": ["sam-managed", "node-abc123"]`
- Filtering uses the `X-Filter` header with JSON: `X-Filter: {"tags": {"$contains": "sam-managed"}}`
- Supports complex filter expressions (`$and`, `$or`, `$gt`, `$contains`, etc.)

### Key Quirks

1. **`root_pass` is required** — When creating a Linode with an `image`, you MUST provide `root_pass`. Generate a random password (we don't use it — access is via cloud-init bootstrap token).
2. **IP available immediately** — Unlike DO/Vultr, the public IP is included in the create response under `ipv4[0]`. No polling needed.
3. **No exact 8vCPU match** — `g6-standard-6` has 6 vCPUs, not 8. Next up is `g6-standard-8` with 8 vCPUs/16GB (verify naming and availability).
4. **X-Filter header** — Unique filtering approach. JSON in a header. Must be properly encoded.
5. **Status values**: `running`, `offline`, `booting`, `rebooting`, `shutting_down`, `provisioning`, `deleting`, `migrating`, `rebuilding`, `cloning`, `restoring`, `stopped`
6. **Rate limiting**: 800 requests/minute for most endpoints. Returns 429 with `Retry-After` header.

### Size Mappings

| SAM Size | Linode Type     | vCPU | RAM  | Disk  |
| -------- | --------------- | ---- | ---- | ----- |
| small    | `g6-standard-2` | 2    | 4GB  | 80GB  |
| medium   | `g6-standard-4` | 4    | 8GB  | 160GB |
| large    | `g6-standard-8` | 8    | 16GB | 320GB |

_Note: Verify type IDs via `GET /linode/types` at implementation time._

### Region/Location Mappings

Key regions: `us-east` (Newark), `us-central` (Dallas), `us-west` (Fremont), `eu-west` (London), `eu-central` (Frankfurt), `ap-south` (Singapore), `ap-northeast` (Tokyo), `ap-southeast` (Sydney)

Query available: `GET /regions`

### Validate Token

- `GET /profile` — Returns 200 with profile info if valid, 401 if not.

## Implementation Checklist

- [ ] Add `CredentialProvider` union member to `packages/shared/src/types.ts`
- [ ] Add `ProviderConfig` variant to `packages/providers/src/types.ts`
- [ ] Create `packages/providers/src/linode.ts`
- [ ] Implement `LinodeProvider` class
- [ ] Implement `createVM()` — POST with metadata.user_data (base64), generate random root_pass
- [ ] Implement `deleteVM()` — DELETE /linode/instances/{id}, idempotent
- [ ] Implement `getVM()` — GET /linode/instances/{id}, map to VMInstance
- [ ] Implement `listVMs()` — GET with X-Filter header for tag filtering
- [ ] Implement `powerOff()` — POST /linode/instances/{id}/shutdown
- [ ] Implement `powerOn()` — POST /linode/instances/{id}/boot
- [ ] Implement `validateToken()` — GET /profile
- [ ] Generate random root_pass for create (cryptographically random, not stored)
- [ ] Handle nested metadata.user_data structure
- [ ] Handle base64 encoding of user_data
- [ ] Implement X-Filter header construction
- [ ] Map Linode status values to VMInstance status
- [ ] Define size mappings
- [ ] Define location list
- [ ] Write contract tests
- [ ] Write unit tests with mocked fetch
- [ ] > 90% coverage

## Testing Strategy

- Reuse provider contract test suite
- Test X-Filter header JSON construction
- Test root_pass generation (randomness, meets Linode requirements)
- Test metadata.user_data nesting
- Test immediate IP extraction from create response
- Test status mapping (many values)

## Related Files

- `packages/providers/src/types.ts` — Provider interface
- `packages/providers/src/hetzner.ts` — Reference implementation

## Success Criteria

- [ ] `LinodeProvider` passes full contract test suite
- [ ] X-Filter tag filtering works correctly
- [ ] Random root_pass generated securely
- [ ] User data correctly base64-encoded in nested structure
- [ ] All unit tests pass with >90% coverage
