# Cross-Boundary Contract Tests

## Rule: Inter-Service Calls Require Contract Verification

When code in **service A** makes an HTTP call to **service B**, you MUST write a test that verifies the contract between them. Mocking service B in service A's tests is not sufficient — you must also verify that the mock matches what B actually expects.

### What to Verify

For every inter-service HTTP call, verify these three contracts:

| Contract                   | What to check                                              | Example failure                                                                                     |
| -------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **URL path**               | The path A constructs matches a route B registers          | TaskRunner called `/api/.../request-upload` but route was mounted at a different path → 404         |
| **Auth mechanism**         | The auth format A sends matches what B's middleware checks | TaskRunner sent `Authorization: Bearer` header but VM agent only checks `?token=` query param → 401 |
| **Request/response shape** | Content types, body structure, and expected fields match   | A sends JSON but B expects multipart; A expects field `url` but B returns `uploadUrl`               |

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

### Multiple Callers to the Same Boundary

When more than one lifecycle or route can invoke the same inter-service request,
they MUST share the request metadata resolver/builder or have behavioral tests
that enumerate every caller. Do not assume coverage of one caller proves another
caller forwards the same fields.

For every caller that supplies security- or identity-sensitive metadata:

- Exercise the real caller and shared resolver/builder; mock only the external
  service boundary.
- Assert the final outbound payload contains the required values.
- Include a missing-metadata case and verify the caller fails closed before the
  external request.
- Re-check deferred/replay paths separately from the primary dispatch path.

### Versioned Protocols and Durable Identities

When a cross-service protocol adds a version, idempotency/delivery ID, receipt,
or runtime identity, both implementations MUST consume the same serialized
contract fixture. The fixture must cover capability negotiation, new and
duplicate acceptance, conflicts/non-acceptance, lookup, and not-found behavior,
including status codes and timestamp units.

A caller-side adapter mock is not proof that the production HTTP path sends the
negotiated envelope. Add a test at the real request serializer that inspects the
final URL and JSON body. For replay decisions, test changed and unproven runtime
identity separately; only an explicit same-runtime non-acceptance receipt may
authorize automatic replay.

### Agent Startup Generated-Config Boundaries

When vm-agent generates an agent config file plus sibling process environment
variables (for example Codex `config.toml` plus `SAM_MCP_TOKEN`), tests MUST
exercise every supported runtime path through the real startup writer. Assert the
actual file content and the exact environment values together; testing the pure
generator alone is insufficient. Include a missing required secret case and prove
startup fails closed before launching the agent. If a wrapper has a separate
launch-only configuration channel (for example `CODEX_CONFIG` plus an ACP mode
selector such as `INITIAL_AGENT_MODE`), assert every exact value on every runtime
path too. Verify the wrapper does not apply a later turn/session policy that
overrides the generated config; a correct config file does not prove the wrapper
passes the same controls to child sessions or subagents. A runtime discriminator
such as an empty container ID must have a regression test that would fail if an
early return were moved back above the generated-config writer.

### Runtime Exit and Diagnostic Correlation Boundaries

Task lifecycle and diagnostic ingestion are also cross-service contracts. When a
runtime-owned exit can end an agent prompt or session, tests MUST prove the real
runtime path emits exactly one terminal callback and that the callback reaches
the control-plane task transition. Clearing local prompt state alone is not a
terminal outcome.

Intentional lifecycle writers such as user, parent-agent, or orchestrator stops
MUST use the canonical cancellation status, write the corresponding status
event, synchronize linked trigger executions, and run terminal cleanup. Test the
compare-and-set behavior so an intentional stop cannot overwrite a concurrent
fatal failure and hide the original cause.

When observability producers cannot supply task or session identifiers, start
the contract test with that least-correlated producer payload. Exercise the real
ingestion and enrichment boundary, then prove that:

- one authoritative candidate is enriched with its task and session identifiers;
- missing, cross-node, cross-session, stale, and ambiguous candidates remain
  uncorrelated;
- retries may add previously missing correlation but cannot rebind an incident
  to a different task or session.

### Why This Rule Exists

The R2 file upload feature shipped with two cross-boundary contract mismatches:

1. **Route path**: Upload route was registered at `/request-upload` relative to its mount point, but the mount point already included `/tasks`, so the full path was different from what the client expected → 404
2. **Auth format**: TaskRunner sent a Bearer token in the Authorization header, but the VM agent only reads tokens from the `?token=` query parameter → 401

Both passed unit tests because the tests mocked the other side of the boundary. Neither was caught until an agent actually ran the full flow on staging.
