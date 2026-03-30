# Cross-Boundary Contract Tests

## Rule: Inter-Service Calls Require Contract Verification

When code in **service A** makes an HTTP call to **service B**, you MUST write a test that verifies the contract between them. Mocking service B in service A's tests is not sufficient — you must also verify that the mock matches what B actually expects.

### What to Verify

For every inter-service HTTP call, verify these three contracts:

| Contract | What to check | Example failure |
|----------|--------------|-----------------|
| **URL path** | The path A constructs matches a route B registers | TaskRunner called `/api/.../request-upload` but route was mounted at a different path → 404 |
| **Auth mechanism** | The auth format A sends matches what B's middleware checks | TaskRunner sent `Authorization: Bearer` header but VM agent only checks `?token=` query param → 401 |
| **Request/response shape** | Content types, body structure, and expected fields match | A sends JSON but B expects multipart; A expects field `url` but B returns `uploadUrl` |

### When This Applies

This rule applies whenever:
- API Worker calls VM agent (e.g., attachment transfer, file proxy, session management)
- Task Runner DO calls VM agent (e.g., agent session creation, file upload)
- Web UI calls API Worker (covered by TypeScript types, but verify runtime behavior)
- Any service calls an external API (R2 S3 API, GitHub API, cloud provider APIs)

### How to Write Contract Tests

**Option A: Shared route constants** (preferred for URL paths)

Define route paths in a shared location and import them in both the caller and the handler:

```typescript
// packages/shared/src/routes.ts
export const VM_AGENT_ROUTES = {
  fileUpload: (workspaceId: string) => `/workspaces/${workspaceId}/files/upload`,
} as const;
```

Both the caller (TaskRunner) and handler (VM agent route registration) import from the same source.

**Option B: Contract test file**

Write a test that asserts both sides of the contract:

```typescript
// tests/contracts/task-runner-to-vm-agent.test.ts
test('attachment transfer uses correct auth mechanism', () => {
  // Verify caller sends token as query param
  const url = buildAttachmentTransferUrl(workspaceId, token);
  expect(new URL(url).searchParams.get('token')).toBe(token);

  // Verify handler checks query param (not just header)
  // This can reference the VM agent's auth middleware pattern
});
```

**Option C: Integration test with real HTTP**

For critical paths, test with a real HTTP server:

```typescript
test('TaskRunner can upload file to VM agent endpoint', async () => {
  const server = createTestVMAgent(); // lightweight mock that uses real route handlers
  const response = await taskRunnerUploadAttachment(server.url, workspaceId, token, fileBuffer);
  expect(response.status).toBe(200);
});
```

### Quick Check Before PR

When your PR includes code that calls another service over HTTP:
- [ ] URL path verified against the target service's route registration
- [ ] Auth mechanism verified against the target service's middleware
- [ ] Request content type and body shape verified against the target service's handler
- [ ] At least one test exercises the cross-boundary call (contract test or integration test)

### Why This Rule Exists

The R2 file upload feature shipped with two cross-boundary contract mismatches:
1. **Route path**: Upload route was registered at `/request-upload` relative to its mount point, but the mount point already included `/tasks`, so the full path was different from what the client expected → 404
2. **Auth format**: TaskRunner sent a Bearer token in the Authorization header, but the VM agent only reads tokens from the `?token=` query parameter → 401

Both passed unit tests because the tests mocked the other side of the boundary. Neither was caught until an agent actually ran the full flow on staging.
