# UpCloud Provider Implementation

**Created**: 2026-02-16
**Status**: Backlog
**Priority**: Medium
**Estimated Effort**: Medium
**Branch**: `feat/multi-provider-support`
**Depends On**: `2026-02-16-provider-infrastructure.md`
**Note**: UpCloud's `ProviderConfig` variant (`{ provider: 'upcloud'; username: string; password: string }`) and `CredentialProvider` union member (`'upcloud'`) already exist after the infrastructure task. No type changes needed.

## Context

UpCloud is a European cloud provider with a clean REST API. The main differentiator is HTTP Basic auth (username:password) instead of Bearer token. This is the first multi-field credential provider in our stack.

## API Research

### Authentication

- **Method**: HTTP Basic Authentication
- **Header**: `Authorization: Basic <base64(username:password)>`
- **Base URL**: `https://api.upcloud.com/1.3`
- **Credential fields**: `username` (account username), `password` (account password or sub-account password)

### VM Lifecycle

| Operation | Method   | Endpoint                                                             |
| --------- | -------- | -------------------------------------------------------------------- |
| Create    | `POST`   | `/server`                                                            |
| Get       | `GET`    | `/server/{uuid}`                                                     |
| List      | `GET`    | `/server`                                                            |
| Delete    | `DELETE` | `/server/{uuid}?storages=1` (also delete attached storage)           |
| Stop      | `POST`   | `/server/{uuid}/stop` body: `{"stop_server": {"stop_type": "soft"}}` |
| Start     | `POST`   | `/server/{uuid}/start`                                               |

### Cloud-Init / User Data

- **Field**: `user_data` in create request body under `server.storage_devices.storage_device[0]`
- **Details**: Research exact placement at implementation time — UpCloud's user_data injection may be at the server level or storage template level

### Tags / Labels

- UpCloud supports server tags: `"tags": {"tag": ["sam-managed"]}` (nested structure)
- List servers by tag: `GET /server/tag/{tag}`
- Tags must be created first: `POST /tag` with `{"tag": {"name": "sam-managed"}}`

### Key Quirks

1. **HTTP Basic auth** — First provider not using Bearer token. The `providerFetch` helper needs to support Basic auth.
2. **Template UUIDs for images** — Instead of slug names, UpCloud uses UUIDs for OS templates (e.g., Ubuntu 24.04 LTS). Query `GET /storage/template` to find the UUID. These can change.
3. **Plan names** — Format like `2xCPU-4GB`. No slug-based lookup. Query `GET /plan` for available plans.
4. **Zones** — Format like `de-fra1`, `fi-hel1`, `us-chi1`, `sg-sin1`. Query `GET /zone`.
5. **Storage is separate** — Creating a server requires defining storage devices explicitly. The OS template is cloned into a new storage device attached to the server.
6. **Nested JSON responses** — UpCloud wraps responses: `{"server": {...}}`, `{"servers": {"server": [...]}}`. Need careful unwrapping.
7. **Firewall** — UpCloud has per-server firewall rules. May need to open ports (22 for SSH, or whatever the bootstrap callback needs).

### Size Mappings

| SAM Size | UpCloud Plan | vCPU | RAM  | Disk  |
| -------- | ------------ | ---- | ---- | ----- |
| small    | `2xCPU-4GB`  | 2    | 4GB  | 80GB  |
| medium   | `4xCPU-8GB`  | 4    | 8GB  | 160GB |
| large    | `8xCPU-16GB` | 8    | 16GB | 320GB |

_Note: Verify plan names via `GET /plan` at implementation time._

### Region/Location Mappings

Key zones: `de-fra1` (Frankfurt), `fi-hel1` (Helsinki), `fi-hel2`, `nl-ams1` (Amsterdam), `us-chi1` (Chicago), `us-nyc1` (NYC), `us-sjo1` (San Jose), `sg-sin1` (Singapore), `au-syd1` (Sydney), `uk-lon1` (London)

### Validate Token

- `GET /account` — Returns 200 with account details if credentials valid, 401 if not.

## Implementation Checklist

- [ ] Create `packages/providers/src/upcloud.ts`
- [ ] Implement `UpCloudProvider` class
- [ ] Implement HTTP Basic auth in provider (base64 encode username:password)
- [ ] Implement `createVM()` — POST /server with storage device and user_data
- [ ] Implement `deleteVM()` — DELETE /server/{uuid}?storages=1, idempotent
- [ ] Implement `getVM()` — GET /server/{uuid}, unwrap nested response
- [ ] Implement `listVMs()` — GET /server/tag/{tag}
- [ ] Implement `powerOff()` — POST /server/{uuid}/stop with soft stop
- [ ] Implement `powerOn()` — POST /server/{uuid}/start
- [ ] Implement `validateToken()` — GET /account
- [ ] Resolve template UUID dynamically (query /storage/template)
- [ ] Handle nested JSON response unwrapping
- [ ] Handle storage device creation with server
- [ ] Ensure tag pre-creation if needed
- [ ] Define size mappings (verify plan names)
- [ ] Define location list
- [ ] Write contract tests
- [ ] Write unit tests with mocked fetch
- [ ] > 90% coverage

## Testing Strategy

- Reuse provider contract test suite
- Test Basic auth header construction
- Test nested JSON unwrapping
- Test storage device creation in create payload
- Test template UUID resolution
- Test tag-based list filtering

## Related Files

- `packages/providers/src/types.ts` — Provider interface
- `packages/providers/src/hetzner.ts` — Reference implementation

## Success Criteria

- [ ] `UpCloudProvider` passes full contract test suite
- [ ] HTTP Basic auth works correctly
- [ ] Storage devices properly created with server
- [ ] Template UUIDs resolved dynamically
- [ ] All unit tests pass with >90% coverage
