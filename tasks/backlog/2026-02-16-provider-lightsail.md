# AWS Lightsail Provider Implementation

**Created**: 2026-02-16
**Status**: Backlog
**Priority**: Medium
**Estimated Effort**: Large
**Branch**: `feat/multi-provider-support`
**Depends On**: `2026-02-16-provider-infrastructure.md`
**Note**: This provider's `ProviderConfig` variant and `CredentialProvider` union member must be added to `packages/shared` and `packages/providers` when implementing this task — they are NOT pre-defined.

## Context

AWS Lightsail provides simplified VPS hosting on AWS infrastructure. The main complexity is the AWS authentication model: JSON-RPC over POST with SigV4 request signing. This requires implementing HMAC-SHA256 signing using WebCrypto (no Node.js `crypto` module in Workers). Lightsail also lacks tag-based list filtering and has ephemeral public IPs that change on stop/start.

## API Research

### Authentication

- **Method**: AWS Signature Version 4 (SigV4)
- **Endpoint**: `https://lightsail.{region}.amazonaws.com/`
- **Protocol**: JSON-RPC over POST with `X-Amz-Target` header
- **Content-Type**: `application/x-amz-json-1.1`
- **Credential fields**: `accessKeyId`, `secretAccessKey`, `region`
- **Signing**: HMAC-SHA256 chain using WebCrypto API (Workers-compatible)

### SigV4 Signing (WebCrypto)

The signing process (must be implemented without Node.js SDK):

1. Create canonical request (method, URI, query, headers, payload hash)
2. Create string-to-sign (algorithm, date, scope, canonical request hash)
3. Derive signing key: `HMAC(HMAC(HMAC(HMAC("AWS4" + secret, date), region), "lightsail"), "aws4_request")`
4. Sign the string-to-sign with the derived key
5. Add `Authorization` header with credential scope and signature

All HMAC-SHA256 operations use `crypto.subtle.importKey()` and `crypto.subtle.sign()`.

### VM Lifecycle (JSON-RPC Actions)

| Operation          | X-Amz-Target                          |
| ------------------ | ------------------------------------- |
| Create             | `Lightsail_20161128.CreateInstances`  |
| Get                | `Lightsail_20161128.GetInstance`      |
| List               | `Lightsail_20161128.GetInstances`     |
| Delete             | `Lightsail_20161128.DeleteInstance`   |
| Stop               | `Lightsail_20161128.StopInstance`     |
| Start              | `Lightsail_20161128.StartInstance`    |
| Allocate Static IP | `Lightsail_20161128.AllocateStaticIp` |
| Attach Static IP   | `Lightsail_20161128.AttachStaticIp`   |
| Detach Static IP   | `Lightsail_20161128.DetachStaticIp`   |
| Release Static IP  | `Lightsail_20161128.ReleaseStaticIp`  |

All requests are `POST /` with the action in `X-Amz-Target` and JSON body.

### Cloud-Init / User Data

- **Field**: `userData` in CreateInstances request body
- **Format**: Plain text (not base64)
- **Limit**: 16KB — smaller than other providers. Our cloud-init must stay under this.

### Tags / Labels

- Tags are key-value pairs: `"tags": [{"key": "sam-managed", "value": "true"}, {"key": "node-id", "value": "abc123"}]`
- **No tag-based list filtering** — `GetInstances` returns ALL instances. Must filter client-side.
- Pagination via `pageToken` in response.

### Key Quirks

1. **SigV4 signing required** — Most complex auth of all providers. Must implement from scratch using WebCrypto. This is a significant chunk of work but is reusable.
2. **JSON-RPC style** — All operations are POST to `/` with `X-Amz-Target` header. Not RESTful.
3. **16KB user data limit** — Tightest limit. Must verify our cloud-init fits.
4. **Public IP changes on stop/start** — Lightsail instances get new IPs after restart. Must allocate a static IP and attach it to maintain a stable IP for DNS.
5. **Static IP lifecycle** — Allocate → Attach to instance → Detach on delete → Release. Static IPs cost money if not attached.
6. **Instance addressed by name, not ID** — `instanceName` is the primary identifier, not a numeric/UUID ID. Names must be unique per region.
7. **No tag-based filtering on list** — Must fetch all instances and filter client-side. Pagination adds complexity.
8. **Blueprint IDs for images** — e.g., `ubuntu_24_04` for Ubuntu 24.04. More stable than numeric IDs.
9. **Bundle IDs for sizes** — e.g., `medium_3_0` (2 vCPU, 4GB), `xlarge_3_0` (4 vCPU, 16GB). Pricing tiers, not exact specs.

### Size Mappings

| SAM Size | Lightsail Bundle | vCPU | RAM  | Disk  |
| -------- | ---------------- | ---- | ---- | ----- |
| small    | `medium_3_0`     | 2    | 4GB  | 80GB  |
| medium   | `xlarge_3_0`     | 4    | 16GB | 160GB |
| large    | `2xlarge_3_0`    | 8    | 32GB | 320GB |

_Note: Lightsail bundles don't have exact 8GB RAM tier. Verify via GetBundles at implementation time._

### Region/Location Mappings

Key regions: `us-east-1` (Virginia), `us-east-2` (Ohio), `us-west-2` (Oregon), `eu-west-1` (Ireland), `eu-west-2` (London), `eu-central-1` (Frankfurt), `ap-southeast-1` (Singapore), `ap-northeast-1` (Tokyo), `ap-southeast-2` (Sydney)

### Validate Token

- Use `GetInstances` or `GetRegions` — returns data if valid, `AuthFailure` error if not.

## Implementation Checklist

- [ ] Add `CredentialProvider` union member to `packages/shared/src/types.ts`
- [ ] Add `ProviderConfig` variant to `packages/providers/src/types.ts`
- [ ] Create `packages/providers/src/lightsail.ts`
- [ ] Implement AWS SigV4 signing using WebCrypto (HMAC-SHA256, SHA-256)
- [ ] Create reusable `awsSign()` helper (could be extracted to shared util)
- [ ] Implement `LightsailProvider` class
- [ ] Implement `createVM()` — CreateInstances + AllocateStaticIp + AttachStaticIp
- [ ] Implement `deleteVM()` — DetachStaticIp + ReleaseStaticIp + DeleteInstance, idempotent
- [ ] Implement `getVM()` — GetInstance, map to VMInstance
- [ ] Implement `listVMs()` — GetInstances with client-side tag filtering + pagination
- [ ] Implement `powerOff()` — StopInstance
- [ ] Implement `powerOn()` — StartInstance
- [ ] Implement `validateToken()` — GetRegions or similar lightweight call
- [ ] Handle static IP lifecycle (allocate, attach, detach, release)
- [ ] Handle instance-by-name addressing
- [ ] Handle client-side tag filtering with pagination
- [ ] Verify cloud-init fits within 16KB limit
- [ ] Define size mappings (verify bundle IDs)
- [ ] Define location list
- [ ] Write SigV4 signing unit tests (compare against known test vectors)
- [ ] Write contract tests
- [ ] Write unit tests with mocked fetch
- [ ] > 90% coverage

## Testing Strategy

- **SigV4 tests**: AWS publishes test vectors for SigV4 signing. Use these to validate our WebCrypto implementation.
- Reuse provider contract test suite
- Test static IP lifecycle (allocate → attach → detach → release)
- Test client-side tag filtering across paginated results
- Test 16KB user data limit enforcement
- Test instance-by-name addressing

## Related Files

- `packages/providers/src/types.ts` — Provider interface
- `packages/providers/src/hetzner.ts` — Reference implementation
- `apps/api/src/services/fetch-timeout.ts` — Existing fetch helper pattern

## Success Criteria

- [ ] SigV4 signing passes AWS test vectors
- [ ] `LightsailProvider` passes full contract test suite
- [ ] Static IP lifecycle managed correctly (no leaked IPs)
- [ ] Client-side tag filtering handles pagination
- [ ] Cloud-init stays under 16KB
- [ ] All unit tests pass with >90% coverage
