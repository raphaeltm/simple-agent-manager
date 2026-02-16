# GCP Compute Engine Provider Implementation

**Created**: 2026-02-16
**Status**: Backlog
**Priority**: Medium
**Estimated Effort**: Large
**Branch**: `feat/multi-provider-support`
**Depends On**: `2026-02-16-provider-infrastructure.md`
**Note**: This provider's `ProviderConfig` variant and `CredentialProvider` union member must be added to `packages/shared` and `packages/providers` when implementing this task — they are NOT pre-defined.

## Context

GCP Compute Engine requires OAuth2 authentication via service account JWTs (signed with RSA-SHA256 using WebCrypto), async operations that must be polled, and verbose instance creation payloads with explicit boot disk and network interface configuration. This is one of the most complex providers to implement but covers a huge user base.

## API Research

### Authentication

- **Method**: OAuth2 Bearer token obtained via service account JWT
- **Flow**:
  1. Parse service account JSON (`client_email`, `private_key`)
  2. Create JWT: `{"iss": email, "scope": "https://www.googleapis.com/auth/compute", "aud": "https://oauth2.googleapis.com/token", "iat": now, "exp": now+3600}`
  3. Sign JWT with RSA-SHA256 using WebCrypto (`crypto.subtle.sign("RSASSA-PKCS1-v1_5", ...)`)
  4. Exchange JWT for access token: `POST https://oauth2.googleapis.com/token` with `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<signed_jwt>`
  5. Use access token: `Authorization: Bearer <access_token>`
- **Token lifetime**: 1 hour. Must cache and refresh.
- **Credential fields**: `serviceAccountJson` (full JSON key file), `projectId`, `zone`
- **Base URL**: `https://compute.googleapis.com/compute/v1/projects/{project}`

### VM Lifecycle

| Operation | Method   | Endpoint                                          |
| --------- | -------- | ------------------------------------------------- |
| Create    | `POST`   | `/zones/{zone}/instances`                         |
| Get       | `GET`    | `/zones/{zone}/instances/{name}`                  |
| List      | `GET`    | `/zones/{zone}/instances?filter=labels.key=value` |
| Delete    | `DELETE` | `/zones/{zone}/instances/{name}`                  |
| Stop      | `POST`   | `/zones/{zone}/instances/{name}/stop`             |
| Start     | `POST`   | `/zones/{zone}/instances/{name}/start`            |

### Cloud-Init / User Data

- **Method**: Set via instance metadata key `user-data`
- **Field**: `metadata.items[{key: "user-data", value: "<cloud-init>"}]` in create request
- **Format**: Plain text
- **Limit**: Total metadata size 512KB (individual values 256KB)

### Labels (Tags)

- GCP uses key-value **labels**: `"labels": {"sam-managed": "true", "node-id": "abc123"}`
- Filter on list: `?filter=labels.sam-managed=true`
- Label keys: lowercase letters, numbers, hyphens, underscores. Max 63 chars.
- Label values: same constraints, can be empty.

### Key Quirks

1. **Service account JWT signing** — Must parse PEM private key, import into WebCrypto as PKCS8, sign with RSASSA-PKCS1-v1_5 SHA-256. Significant crypto work.
2. **Token caching** — Access tokens are valid for 1 hour. Provider must cache the token and refresh when expired.
3. **Async operations** — All mutating operations return an `Operation` resource, not the instance. Must poll `GET /zones/{zone}/operations/{op}` until `status: "DONE"`.
4. **Verbose create payload** — Must specify:
   - `machineType` as full URL: `zones/{zone}/machineTypes/{type}`
   - Boot disk with `initializeParams.sourceImage` as full URL
   - Network interface with `accessConfigs` for external IP
   - Metadata for cloud-init
5. **Instance addressed by name** — Like Lightsail, instances are identified by name, not numeric ID. Names must be unique per zone.
6. **External IP requires accessConfigs** — Without `"accessConfigs": [{"type": "ONE_TO_ONE_NAT"}]` on the network interface, the instance has no public IP.
7. **Image URLs** — Full URL format: `projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64`
8. **Delete returns operation** — Must wait for operation to complete to confirm deletion.
9. **Status values**: `PROVISIONING`, `STAGING`, `RUNNING`, `STOPPING`, `STOPPED`, `SUSPENDING`, `SUSPENDED`, `REPAIRING`, `TERMINATED`

### Size Mappings

| SAM Size | GCP Machine Type | vCPU | RAM  | Notes                            |
| -------- | ---------------- | ---- | ---- | -------------------------------- |
| small    | `e2-standard-2`  | 2    | 8GB  | (GCP min standard is 2 vCPU/8GB) |
| medium   | `e2-standard-4`  | 4    | 16GB |                                  |
| large    | `e2-standard-8`  | 8    | 32GB |                                  |

_Note: GCP standard types have more RAM per vCPU than other providers. Custom machine types could be used for exact sizing but add complexity._

### Region/Location Mappings

Key zones: `us-central1-a`, `us-east1-b`, `us-west1-a`, `europe-west1-b` (Belgium), `europe-west3-a` (Frankfurt), `europe-west2-a` (London), `asia-southeast1-a` (Singapore), `asia-northeast1-a` (Tokyo), `australia-southeast1-a` (Sydney)

### Validate Token

- After obtaining access token, `GET /zones/{zone}/instances?maxResults=1` — Returns data if valid, 401/403 if not.
- Or validate during token exchange (JWT → access token fails if credentials invalid).

## Implementation Checklist

- [ ] Add `CredentialProvider` union member to `packages/shared/src/types.ts`
- [ ] Add `ProviderConfig` variant to `packages/providers/src/types.ts`
- [ ] Create `packages/providers/src/gcp.ts`
- [ ] Implement service account JWT creation and RSA-SHA256 signing via WebCrypto
- [ ] Implement OAuth2 token exchange (JWT → access token)
- [ ] Implement token caching with expiry-based refresh
- [ ] Implement `GcpProvider` class
- [ ] Implement `createVM()` — POST instance with boot disk, network, metadata, then poll operation
- [ ] Implement `deleteVM()` — DELETE instance, poll operation, idempotent
- [ ] Implement `getVM()` — GET instance, map to VMInstance
- [ ] Implement `listVMs()` — GET instances with label filter
- [ ] Implement `powerOff()` — POST stop, poll operation
- [ ] Implement `powerOn()` — POST start, poll operation
- [ ] Implement `validateToken()` — Token exchange or lightweight API call
- [ ] Implement operation polling helper (poll until `status: "DONE"`)
- [ ] Handle full URL construction for machineType, sourceImage
- [ ] Handle external IP via accessConfigs
- [ ] Handle metadata items array for cloud-init
- [ ] Parse PEM private key from service account JSON
- [ ] Map GCP status values to VMInstance status
- [ ] Define size mappings
- [ ] Define location list
- [ ] Write JWT signing unit tests
- [ ] Write token caching tests
- [ ] Write operation polling tests
- [ ] Write contract tests
- [ ] Write unit tests with mocked fetch
- [ ] > 90% coverage

## Testing Strategy

- Test JWT creation and signing (verify against known outputs)
- Test PEM key parsing and WebCrypto import
- Test token caching and refresh logic
- Test operation polling (multiple poll cycles, timeout, failure)
- Reuse provider contract test suite
- Test verbose create payload construction
- Test label-based filtering

## Related Files

- `packages/providers/src/types.ts` — Provider interface
- `packages/providers/src/hetzner.ts` — Reference implementation

## Success Criteria

- [ ] Service account JWT signing works via WebCrypto
- [ ] Token caching prevents unnecessary re-authentication
- [ ] `GcpProvider` passes full contract test suite
- [ ] Async operations polled correctly
- [ ] External IP assigned via accessConfigs
- [ ] All unit tests pass with >90% coverage
