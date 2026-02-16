# OVH Provider Implementation

**Created**: 2026-02-16
**Status**: Backlog
**Priority**: Low
**Estimated Effort**: Large
**Branch**: `feat/multi-provider-support`
**Depends On**: `2026-02-16-provider-infrastructure.md`
**Note**: This provider's `ProviderConfig` variant and `CredentialProvider` union member must be added to `packages/shared` and `packages/providers` when implementing this task — they are NOT pre-defined.

## Context

OVH is a European cloud provider with the most unusual API authentication of all our target providers: a custom signature scheme using SHA1 hashing with 4 separate credentials and server time synchronization. OVH also lacks instance tags entirely, requiring name-prefix conventions and database mapping for VM identification. This is the most complex provider to implement relative to its user base, hence the low priority.

## API Research

### Authentication

- **Method**: Custom OVH signature scheme
- **Credentials (4 fields)**:
  - `appKey` (Application Key — identifies the application)
  - `appSecret` (Application Secret — signs requests)
  - `consumerKey` (Consumer Key — authenticates the specific user/permissions)
  - `projectId` (Public Cloud project UUID)
- **Signature**: `$1$` + SHA1(`appSecret` + `consumerKey` + `METHOD` + `URL` + `BODY` + `TIMESTAMP`)
- **Required headers**:
  ```
  X-Ovh-Application: {appKey}
  X-Ovh-Consumer: {consumerKey}
  X-Ovh-Timestamp: {timestamp}
  X-Ovh-Signature: {signature}
  ```
- **Base URL**: `https://eu.api.ovh.com/v1/cloud/project/{projectId}` (EU) or `https://ca.api.ovh.com/v1/...` (CA) or `https://us.api.ovh.com/v1/...` (US)
- **Time sync**: Must call `GET /auth/time` to get OVH server timestamp. Local clock drift will cause auth failures.

### VM Lifecycle

| Operation        | Method   | Endpoint                  |
| ---------------- | -------- | ------------------------- |
| Create           | `POST`   | `/instance`               |
| Get              | `GET`    | `/instance/{id}`          |
| List             | `GET`    | `/instance`               |
| Delete           | `DELETE` | `/instance/{id}`          |
| Stop (shelve)    | `POST`   | `/instance/{id}/shelve`   |
| Start (unshelve) | `POST`   | `/instance/{id}/unshelve` |

_Note: OVH uses `shelve`/`unshelve` instead of stop/start for cost savings. Regular `stop` exists but instance still incurs charges._

### Cloud-Init / User Data

- **Field**: `userData` in create request body
- **Format**: Plain text
- **Limit**: Research needed at implementation time

### Tags / Labels

- **OVH has NO instance tags.** This is a significant limitation.
- **Workaround options**:
  1. **Name prefix convention**: Name instances `sam-{nodeId}-{timestamp}` and filter by prefix on list
  2. **Database mapping**: Store OVH instance ID → SAM node ID mapping in our database
  3. **Both**: Use name prefix for quick filtering + DB for authoritative mapping
- The `listVMs()` with labels will NOT work natively. Must implement client-side filtering by name prefix.

### Key Quirks

1. **Custom signature scheme** — Not Bearer token, not Basic auth, not SigV4. Completely custom. Must implement SHA1 HMAC equivalent using the concatenation pattern.
2. **4 separate credentials** — Most credentials of any provider. UX complexity for users entering these in Settings.
3. **Time synchronization** — Must call `GET /auth/time` before signing to get OVH server timestamp. Cache for ~30 seconds. Clock drift causes signature failures.
4. **No instance tags** — Must use name-based identification. `listVMs(labels)` must be adapted.
5. **Region-specific IDs** — Image IDs (flavor, image) are UUIDs that differ per region. Must query dynamically:
   - `GET /image?osType=linux&region={region}` to find Ubuntu image UUID
   - `GET /flavor?region={region}` to find plan UUID
6. **Shelve vs Stop** — `shelve` deallocates resources (cheaper), `stop` keeps them allocated. For our use case, `shelve` is better for cost but `unshelve` may take longer.
7. **Multiple API endpoints** — EU (`eu.api.ovh.com`), CA (`ca.api.ovh.com`), US (`us.api.ovh.com`). User must specify or we detect from credentials.
8. **Status values**: `ACTIVE`, `BUILD`, `DELETED`, `ERROR`, `HARD_REBOOT`, `MIGRATING`, `PASSWORD`, `PAUSED`, `REBOOT`, `REBUILD`, `RESCUE`, `RESIZE`, `REVERT_RESIZE`, `SHELVED`, `SHELVED_OFFLOADED`, `SHUTOFF`, `SOFT_DELETED`, `STOPPED`, `SUSPENDED`, `UNKNOWN`, `VERIFY_RESIZE`

### Size Mappings

| SAM Size | OVH Flavor Name | vCPU | RAM  | Disk  | Notes                 |
| -------- | --------------- | ---- | ---- | ----- | --------------------- |
| small    | `b3-8`          | 2    | 8GB  | 50GB  | Query UUID per region |
| medium   | `b3-16`         | 4    | 16GB | 100GB | Query UUID per region |
| large    | `b3-32`         | 8    | 32GB | 200GB | Query UUID per region |

_Note: OVH flavor names and UUIDs vary by region. Must query `GET /flavor?region={region}` to get exact IDs._

### Region/Location Mappings

Key regions: `GRA7`, `GRA11` (Gravelines, France), `SBG5` (Strasbourg), `BHS5` (Beauharnois, Canada), `DE1` (Frankfurt), `UK1` (London), `WAW1` (Warsaw), `SGP1` (Singapore), `SYD1` (Sydney)

### Validate Token

- `GET /auth/time` verifies the API endpoint is reachable
- `GET /instance` with signed request — returns data if all 4 credentials are valid, appropriate error otherwise

## Implementation Checklist

- [ ] Add `CredentialProvider` union member to `packages/shared/src/types.ts`
- [ ] Add `ProviderConfig` variant to `packages/providers/src/types.ts`
- [ ] Create `packages/providers/src/ovh.ts`
- [ ] Implement OVH signature scheme (SHA1 hash of concatenated fields)
- [ ] Implement time synchronization (`GET /auth/time` with caching)
- [ ] Implement signed request helper (adds all 4 X-Ovh-\* headers)
- [ ] Implement `OvhProvider` class
- [ ] Implement `createVM()` — POST /instance with userData, dynamic flavor/image UUIDs
- [ ] Implement `deleteVM()` — DELETE /instance/{id}, idempotent
- [ ] Implement `getVM()` — GET /instance/{id}, map to VMInstance
- [ ] Implement `listVMs()` — GET /instance, client-side filter by name prefix
- [ ] Implement `powerOff()` — POST /instance/{id}/shelve (or stop)
- [ ] Implement `powerOn()` — POST /instance/{id}/unshelve (or start)
- [ ] Implement `validateToken()` — Signed GET /instance
- [ ] Handle name-prefix convention for instance identification (no tags)
- [ ] Resolve image UUIDs dynamically per region
- [ ] Resolve flavor UUIDs dynamically per region
- [ ] Handle multiple API endpoints (EU/CA/US)
- [ ] Handle time drift in signing
- [ ] Map OVH status values to VMInstance status
- [ ] Define location list
- [ ] Write signature scheme unit tests
- [ ] Write time sync tests
- [ ] Write contract tests
- [ ] Write unit tests with mocked fetch
- [ ] > 90% coverage

## Testing Strategy

- Test OVH signature generation against known values
- Test time synchronization caching
- Test name-prefix filtering (substitute for tags)
- Test dynamic UUID resolution for images/flavors
- Reuse provider contract test suite (adapted for no-tag constraint)
- Test multiple API endpoint selection

## Open Questions

1. **Shelve vs Stop** — Which is better for SAM's use case? Shelve saves money but unshelve is slower.
2. **API endpoint selection** — Should users specify EU/CA/US, or should we detect from the region?
3. **Tag workaround** — Is name-prefix sufficient, or do we need a DB mapping table?

## Related Files

- `packages/providers/src/types.ts` — Provider interface
- `packages/providers/src/hetzner.ts` — Reference implementation

## Success Criteria

- [ ] OVH signature scheme works correctly with time sync
- [ ] `OvhProvider` passes full contract test suite (with tag adaptation)
- [ ] Dynamic image/flavor UUID resolution works per region
- [ ] Name-prefix identification substitutes for missing tags
- [ ] All 4 credentials validated
- [ ] All unit tests pass with >90% coverage
