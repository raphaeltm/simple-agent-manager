# Cross-Boundary Contract Tests for VM Agent ↔ API Worker

## Problem

5 critical VM agent ↔ API Worker HTTP contracts have zero or incomplete test coverage. Contract mismatches at these boundaries cause silent failures (e.g., wrong auth model → 401, wrong URL construction → 404, wrong payload shape → 400).

## Research Findings

### Existing Patterns
- `apps/api/tests/unit/node-agent-contract.test.ts` provides the model:
  - Schema validation tests using shared Zod schemas
  - Client function tests using `vi.doMock` + `vi.resetModules` + dynamic import to capture HTTP calls
  - JWT contract tests verifying token claims and audience/issuer

### Contract Details

**1. Attachment Transfer (CRITICAL — different auth model)**
- Caller: `workspace-steps.ts:handleAttachmentTransfer()` (TaskRunner DO)
- URL: `${protocol}://ws-${workspaceId}.${baseDomain}:${port}/workspaces/${workspaceId}/files/upload`
- Auth: Terminal JWT via `?token=` query param (NOT Bearer header)
- Content-Type: multipart/form-data (FormData with file blob)
- Key difference: uses `ws-*` subdomain routing instead of `{nodeId}.vm.*`

**2. Agent Activity Callback**
- Caller: VM agent `session_host_reporting.go:reportActivity()`
- URL: `/api/projects/${projectId}/acp-sessions/${sessionId}/activity`
- Auth: Callback JWT Bearer token
- Payload: `{ activity: "prompting"|"idle", nodeId: string }`
- Schema: `AcpSessionActivityReportSchema` (Valibot)
- Validates: nodeId matches existing session's assigned node

**3. Credential Sync Callback**
- Caller: VM agent `workspace_callbacks.go:SyncCredential()`
- URL: `/api/workspaces/${workspaceId}/agent-credential-sync`
- Auth: Callback JWT Bearer token (via `verifyWorkspaceCallbackAuth`)
- Payload: `{ agentType: string, credentialKind: string, credential: string }`
- Schema: `AgentCredentialSyncSchema` (Valibot)

**4. Send Prompt to Agent**
- Caller: `node-agent.ts:sendPromptToAgentOnNode()`
- URL: `${nodeBaseUrl}/workspaces/${workspaceId}/agent-sessions/${sessionId}/prompt`
- Auth: Node management JWT Bearer token
- Payload: `{ prompt: string }`

**5. Cancel/Stop Agent Session**
- Caller: `node-agent.ts:cancelAgentSessionOnNode()` and `stopAgentSessionOnNode()`
- URL: `.../agent-sessions/${sessionId}/cancel` and `.../agent-sessions/${sessionId}/stop`
- Auth: Node management JWT Bearer token
- Cancel returns `{ success, status }` instead of throwing — 409 (no active prompt) is expected

## Implementation Checklist

- [ ] Create test file `apps/api/tests/unit/vm-agent-cross-boundary-contract.test.ts`
- [ ] Contract 1: Attachment transfer URL construction (ws-* subdomain, not nodeId.vm.*)
- [ ] Contract 1: Attachment transfer auth mechanism (query param, not Bearer header)
- [ ] Contract 1: Attachment transfer FormData payload structure
- [ ] Contract 1: Attachment transfer timeout handling
- [ ] Contract 2: Agent activity callback payload matches Go sender
- [ ] Contract 2: Agent activity callback auth mechanism (Bearer callback JWT)
- [ ] Contract 2: Agent activity callback route URL matches Go URL construction
- [ ] Contract 3: Credential sync payload matches Go sender
- [ ] Contract 3: Credential sync auth mechanism (Bearer callback JWT)
- [ ] Contract 3: Credential sync route URL matches Go URL construction
- [ ] Contract 4: Send prompt payload structure
- [ ] Contract 4: Send prompt URL path and auth headers
- [ ] Contract 5: Cancel agent session error handling (409 not treated as failure)
- [ ] Contract 5: Stop agent session URL and method
- [ ] All tests pass locally

## Acceptance Criteria

- [ ] All 5 contracts have at least one test verifying URL construction, auth mechanism, and payload shape
- [ ] Attachment transfer test verifies the DIFFERENT auth model (query param vs Bearer header)
- [ ] Cancel agent session test verifies 409 handling (returns success=false, not throws)
- [ ] Tests follow existing pattern from node-agent-contract.test.ts
- [ ] CI passes (lint, typecheck, test)
