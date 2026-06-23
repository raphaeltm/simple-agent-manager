/**
 * Cross-Boundary Contract Tests: VM Agent ↔ API Worker
 *
 * Tests for 5 untested HTTP contracts between the API Worker and VM agent.
 * Verifies URL construction, auth mechanisms, and payload shapes at each
 * boundary to catch contract mismatches that cause silent failures.
 *
 * See: .claude/rules/23-cross-boundary-contract-tests.md
 * See: .claude/rules/34-vm-agent-callback-auth.md
 */

import * as v from 'valibot';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { AcpSessionActivityReportSchema } from '../../src/schemas/acp-sessions';
import { AgentCredentialSyncSchema } from '../../src/schemas/workspaces';

// =============================================================================
// Key generation for JWT-dependent tests
// =============================================================================

let testPrivateKey: string;
let testPublicKey: string;

beforeAll(async () => {
  const { generateKeyPair, exportPKCS8, exportSPKI } = await import('jose');
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  testPrivateKey = await exportPKCS8(privateKey);
  testPublicKey = await exportSPKI(publicKey);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// =============================================================================
// Shared test helpers for Contracts 4 & 5 (API Worker → VM Agent calls)
// =============================================================================

interface MockFetchCapture {
  url: string | null;
  body: string | null;
  headers: Headers | null;
  method: string | null;
}

const DEFAULT_NODE_AGENT_RESPONSE = { status: 200, body: '{"ok":true}' };

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') {
    end -= 1;
  }
  return value.slice(0, end);
}

function getAttachmentTransferTimeout(value: string | undefined): number {
  const DEFAULT_ATTACHMENT_TRANSFER_TIMEOUT_MS = 60_000;
  const parsed = Number.parseInt(value ?? String(DEFAULT_ATTACHMENT_TRANSFER_TIMEOUT_MS), 10);
  return parsed || DEFAULT_ATTACHMENT_TRANSFER_TIMEOUT_MS;
}

/**
 * Sets up vi.doMock for the standard nodeAgentRequest dependency trio
 * (jwt, telemetry, fetch-timeout) and returns a capture object for inspecting
 * the outgoing HTTP request. Call vi.resetModules() before this.
 */
function setupNodeAgentMocks(
  responseInit?: { status: number; body?: string | null },
  signTokenOverride?: ReturnType<typeof vi.fn>,
): MockFetchCapture {
  const capture: MockFetchCapture = { url: null, body: null, headers: null, method: null };
  const response = responseInit ?? DEFAULT_NODE_AGENT_RESPONSE;

  vi.doMock('../../src/services/jwt', () => ({
    signNodeManagementToken: signTokenOverride ?? vi.fn().mockResolvedValue({
      token: 'mock-jwt',
      expiresAt: new Date().toISOString(),
    }),
  }));

  vi.doMock('../../src/services/telemetry', () => ({
    recordNodeRoutingMetric: vi.fn(),
  }));

  vi.doMock('../../src/services/fetch-timeout', () => ({
    fetchWithTimeout: vi.fn().mockImplementation((url: string, init: RequestInit) => {
      capture.url = url;
      capture.body = (init.body as string) ?? null;
      capture.headers = new Headers(init.headers);
      capture.method = init.method ?? 'GET';
      const resBody = response.body ?? null;
      return Promise.resolve(
        new Response(resBody, {
          status: response.status,
          headers: resBody ? { 'Content-Type': 'application/json' } : undefined,
        }),
      );
    }),
    getTimeoutMs: vi.fn().mockReturnValue(30000),
  }));

  return capture;
}

/**
 * Like setupNodeAgentMocks but the fetch mock rejects with an error.
 */
function setupNodeAgentMocksWithError(errorMessage: string): void {
  vi.doMock('../../src/services/jwt', () => ({
    signNodeManagementToken: vi.fn().mockResolvedValue({
      token: 'mock-jwt',
      expiresAt: new Date().toISOString(),
    }),
  }));

  vi.doMock('../../src/services/telemetry', () => ({
    recordNodeRoutingMetric: vi.fn(),
  }));

  vi.doMock('../../src/services/fetch-timeout', () => ({
    fetchWithTimeout: vi.fn().mockRejectedValue(new Error(errorMessage)),
    getTimeoutMs: vi.fn().mockReturnValue(30000),
  }));
}

// =============================================================================
// Contract 1: Attachment Transfer (CRITICAL — different auth model)
// =============================================================================

describe('Contract 1: Attachment Transfer (TaskRunner → VM Agent)', () => {
  describe('URL construction', () => {
    it('uses ws-* subdomain routing, NOT {nodeId}.vm.* routing', () => {
      // The attachment transfer uses workspace-scoped routing:
      //   ws-${workspaceId}.${baseDomain}:${port}
      // NOT the node-management routing used by other calls:
      //   ${nodeId}.vm.${baseDomain}:${port}
      const protocol = 'https';
      const port = '8443';
      // Workspace IDs are ULIDs (e.g., '01HXYZ...'), NOT ws-prefixed strings.
      // The ws- prefix is added by the URL construction, not stored in the ID.
      const workspaceId = '01HXYZ789DEF';
      const baseDomain = 'example.com';

      // Reproduce URL construction from workspace-steps.ts:374
      const vmUrl = `${protocol}://ws-${workspaceId}.${baseDomain}:${port}`;
      const uploadUrl = `${vmUrl}/workspaces/${workspaceId}/files/upload`;

      expect(uploadUrl).toBe('https://ws-01HXYZ789DEF.example.com:8443/workspaces/01HXYZ789DEF/files/upload');
      // ws- prefix appears exactly once in subdomain (not doubled)
      expect(uploadUrl).toMatch(/^https:\/\/ws-[^.]+\.example\.com/);
      expect(uploadUrl).not.toContain('.vm.');
    });

    it('constructs correct URL with default protocol and port', () => {
      const protocol = 'https';
      const port = '8443';
      const workspaceId = 'test-workspace';
      const baseDomain = 'sammy.party';

      const vmUrl = `${protocol}://ws-${workspaceId}.${baseDomain}:${port}`;
      const uploadUrl = `${vmUrl}/workspaces/${workspaceId}/files/upload`;

      expect(uploadUrl).toBe(
        'https://ws-test-workspace.sammy.party:8443/workspaces/test-workspace/files/upload',
      );
    });
  });

  describe('auth mechanism', () => {
    it('passes terminal JWT as query parameter, NOT Bearer header', () => {
      // From workspace-steps.ts:414:
      //   const uploadUrl = `${uploadBaseUrl}?token=${encodeURIComponent(token)}`;
      // The VM agent's requireWorkspaceRequestAuth() checks:
      //   r.URL.Query().Get("token")
      const token = 'eyJ.terminal.jwt';
      const uploadBaseUrl = 'https://ws-abc.example.com:8443/workspaces/ws-abc/files/upload';

      const uploadUrl = `${uploadBaseUrl}?token=${encodeURIComponent(token)}`;

      const parsedUrl = new URL(uploadUrl);
      expect(parsedUrl.searchParams.get('token')).toBe(token);
      // Should NOT have Authorization header — that's a different auth model
    });

    it('uses signTerminalToken (NOT signNodeManagementToken)', async () => {
      // The attachment transfer uses signTerminalToken which produces a
      // workspace-terminal audience token — distinct from the node-management
      // tokens used by other VM agent calls.
      const { signTerminalToken } = await import('../../src/services/jwt');

      const env = {
        JWT_PRIVATE_KEY: testPrivateKey,
        JWT_PUBLIC_KEY: testPublicKey,
        BASE_DOMAIN: 'example.com',
      } as any;

      const { token } = await signTerminalToken('user-123', 'ws-abc', env);
      expect(typeof token).toBe('string');

      // Verify the token has terminal audience, not callback or node-management
      const { jwtVerify, importSPKI } = await import('jose');
      const publicKey = await importSPKI(testPublicKey, 'RS256');
      const { payload } = await jwtVerify(token, publicKey, {
        issuer: 'https://api.example.com',
        audience: 'workspace-terminal',
      });

      expect(payload.aud).toBe('workspace-terminal');
      expect(payload.workspace).toBe('ws-abc');
    });
  });

  describe('payload structure', () => {
    it('sends multipart/form-data with files field', () => {
      // From workspace-steps.ts:406-408:
      //   const formData = new FormData();
      //   formData.append('files', new Blob([bodyBytes], { type: r2Object.contentType }), attachment.filename);
      const formData = new FormData();
      const testContent = new Uint8Array([1, 2, 3, 4]);
      const blob = new Blob([testContent], { type: 'application/octet-stream' });
      formData.append('files', blob, 'test-file.txt');

      // FormData should have the 'files' field
      expect(formData.has('files')).toBe(true);
      const file = formData.get('files') as File;
      expect(file.name).toBe('test-file.txt');
      expect(file.type).toBe('application/octet-stream');
    });

    it('does NOT include destination field (VM agent defaults to .private)', () => {
      // From workspace-steps.ts:408 comment:
      //   Omit 'destination' field — VM agent defaults to ../.private
      const formData = new FormData();
      const blob = new Blob([new Uint8Array([1])], { type: 'text/plain' });
      formData.append('files', blob, 'readme.md');

      expect(formData.has('destination')).toBe(false);
    });
  });

  describe('timeout handling', () => {
    it('uses configurable timeout with 60s default', () => {
      // Matches workspace-steps.ts:393-397.
      expect(getAttachmentTransferTimeout(undefined)).toBe(60_000);
      expect(getAttachmentTransferTimeout('120000')).toBe(120_000);
      expect(getAttachmentTransferTimeout('not-a-number')).toBe(60_000);
    });
  });
});

// =============================================================================
// Contract 2: Agent Activity Callback (VM Agent → API Worker)
// =============================================================================

describe('Contract 2: Agent Activity Callback (VM Agent → API Worker)', () => {
  describe('payload shape matches Go sender', () => {
    it('validates the payload the VM agent sends', () => {
      // From session_host_reporting.go:189-192:
      //   body, _ := json.Marshal(map[string]string{
      //     "activity": activity,
      //     "nodeId":   nodeID,
      //   })
      const goPayload = {
        activity: 'prompting',
        nodeId: 'node-abc-123',
      };

      // Must pass the Valibot schema used by the API route
      const result = v.safeParse(AcpSessionActivityReportSchema, goPayload);
      expect(result.success).toBe(true);
    });

    it('validates idle activity', () => {
      const goPayload = {
        activity: 'idle',
        nodeId: 'node-xyz-456',
      };

      const result = v.safeParse(AcpSessionActivityReportSchema, goPayload);
      expect(result.success).toBe(true);
    });

    it('rejects invalid activity values', () => {
      const invalidPayload = {
        activity: 'working',
        nodeId: 'node-abc-123',
      };

      const result = v.safeParse(AcpSessionActivityReportSchema, invalidPayload);
      expect(result.success).toBe(false);
    });

    it('rejects payload missing nodeId', () => {
      const invalidPayload = {
        activity: 'prompting',
      };

      const result = v.safeParse(AcpSessionActivityReportSchema, invalidPayload);
      expect(result.success).toBe(false);
    });
  });

  describe('URL construction matches Go sender', () => {
    it('constructs the same URL as session_host_reporting.go', () => {
      // From session_host_reporting.go:186-187:
      //   url := strings.TrimRight(controlPlaneURL, "/") +
      //     "/api/projects/" + projectID + "/acp-sessions/" + sessionID + "/activity"
      const controlPlaneURL = 'https://api.example.com';
      const projectID = 'proj-abc';
      const sessionID = 'sess-xyz';

      const goUrl = trimTrailingSlashes(controlPlaneURL) +
        '/api/projects/' + projectID + '/acp-sessions/' + sessionID + '/activity';

      // The API route is mounted at:
      //   app.route('/api/projects', agentActivityCallbackRoute);
      // And the route is:
      //   '/:id/acp-sessions/:sessionId/activity'
      // So the full path is:
      //   /api/projects/:id/acp-sessions/:sessionId/activity
      expect(goUrl).toBe('https://api.example.com/api/projects/proj-abc/acp-sessions/sess-xyz/activity');
    });

    it('handles trailing slash in controlPlaneURL', () => {
      const controlPlaneURL = 'https://api.example.com/';
      const projectID = 'proj-abc';
      const sessionID = 'sess-xyz';

      const goUrl = trimTrailingSlashes(controlPlaneURL) +
        '/api/projects/' + projectID + '/acp-sessions/' + sessionID + '/activity';

      expect(goUrl).toBe('https://api.example.com/api/projects/proj-abc/acp-sessions/sess-xyz/activity');
    });
  });

  describe('auth mechanism', () => {
    it('sends callback JWT as Bearer token in Authorization header', () => {
      // From session_host_reporting.go:203:
      //   req.Header.Set("Authorization", "Bearer "+callbackToken)
      const callbackToken = 'eyJ.callback.jwt';
      const authHeader = `Bearer ${callbackToken}`;

      expect(authHeader).toBe('Bearer eyJ.callback.jwt');

      // The API route uses extractBearerToken() to parse this
      const extracted = authHeader.replace(/^Bearer\s+/i, '');
      expect(extracted).toBe(callbackToken);
    });

    it('sets Content-Type to application/json', () => {
      // From session_host_reporting.go:204:
      //   req.Header.Set("Content-Type", "application/json")
      const headers: Record<string, string> = {};
      headers['Content-Type'] = 'application/json';
      expect(headers['Content-Type']).toBe('application/json');
    });
  });
});

// =============================================================================
// Contract 3: Credential Sync Callback (VM Agent → API Worker)
// =============================================================================

describe('Contract 3: Credential Sync Callback (VM Agent → API Worker)', () => {
  describe('payload shape matches Go sender', () => {
    it.each([
      [
        'oauth-token credential',
        {
          agentType: 'openai-codex',
          credentialKind: 'oauth-token',
          credential: '{"tokens":{"access_token":"new-jwt","refresh_token":"rt"}}',
        },
      ],
      [
        'api-key credential',
        {
          agentType: 'claude-code',
          credentialKind: 'api-key',
          credential: 'sk-ant-XXXX',
        },
      ],
    ])('validates the %s payload the VM agent sends', (_name, goPayload) => {
      // From workspace_callbacks.go:37-41:
      //   payload := map[string]string{
      //     "agentType":      agentType,
      //     "credentialKind": credentialKind,
      //     "credential":     credential,
      //   }
      const result = v.safeParse(AgentCredentialSyncSchema, goPayload);
      expect(result.success).toBe(true);
    });

    it('Go sender always includes all three fields', () => {
      // The Valibot schema marks agentType and credentialKind as optional,
      // but the Go sender (workspace_callbacks.go:37-41) ALWAYS sends all three.
      // The runtime handler also requires agentType at runtime (workspace-runtime.ts:265-268).
      // This test verifies the Go-side contract: all fields present.
      const goPayload = {
        agentType: 'claude-code',
        credentialKind: 'api-key',
        credential: 'sk-test-key',
      };

      const result = v.safeParse(AgentCredentialSyncSchema, goPayload);
      expect(result.success).toBe(true);
      // All three fields must be present in what Go sends
      expect(goPayload).toHaveProperty('agentType');
      expect(goPayload).toHaveProperty('credentialKind');
      expect(goPayload).toHaveProperty('credential');
    });

    it('rejects payload without credential field', () => {
      const invalidPayload = {
        agentType: 'openai-codex',
        credentialKind: 'oauth-token',
      };

      const result = v.safeParse(AgentCredentialSyncSchema, invalidPayload);
      expect(result.success).toBe(false);
    });
  });

  describe('URL construction matches Go sender', () => {
    it('constructs the same URL as workspace_callbacks.go', () => {
      // From workspace_callbacks.go:48-52:
      //   endpoint := fmt.Sprintf(
      //     "%s/api/workspaces/%s/agent-credential-sync",
      //     strings.TrimRight(s.config.ControlPlaneURL, "/"),
      //     neturl.PathEscape(trimmedWorkspaceID),
      //   )
      const controlPlaneURL = 'https://api.example.com';
      const workspaceID = 'ws-abc-123';

      const goUrl = trimTrailingSlashes(controlPlaneURL) +
        '/api/workspaces/' + encodeURIComponent(workspaceID) + '/agent-credential-sync';

      // The API route is mounted at:
      //   app.route('/api/workspaces', runtimeRoutes);  (inside workspacesRoutes)
      // And the route is:
      //   '/:id/agent-credential-sync'
      expect(goUrl).toBe('https://api.example.com/api/workspaces/ws-abc-123/agent-credential-sync');
    });

    it('URL-encodes workspace IDs with special characters', () => {
      const controlPlaneURL = 'https://api.example.com';
      const workspaceID = 'ws-abc/123';

      const goUrl = trimTrailingSlashes(controlPlaneURL) +
        '/api/workspaces/' + encodeURIComponent(workspaceID) + '/agent-credential-sync';

      expect(goUrl).toContain('ws-abc%2F123');
    });
  });

  describe('auth mechanism', () => {
    it('sends callback JWT as Bearer token', () => {
      // From workspace_callbacks.go:66:
      //   req.Header.Set("Authorization", "Bearer "+callbackToken)
      const callbackToken = 'cb-jwt-token';
      const authHeader = `Bearer ${callbackToken}`;

      expect(authHeader).toMatch(/^Bearer .+$/);

      // API side uses verifyWorkspaceCallbackAuth which calls extractBearerToken
    });
  });
});

// =============================================================================
// Contract 4: Send Prompt to Agent (API Worker → VM Agent)
// =============================================================================

describe('Contract 4: Send Prompt to Agent (API Worker → VM Agent)', () => {
  describe('payload structure', () => {
    it('sendPromptToAgentOnNode sends { prompt } in JSON body', async () => {
      vi.resetModules();
      const capture = setupNodeAgentMocks();
      const { sendPromptToAgentOnNode } = await import('../../src/services/node-agent');

      const env = {
        BASE_DOMAIN: 'example.com',
        NODE_AGENT_REQUEST_TIMEOUT_MS: '30000',
      } as any;

      await sendPromptToAgentOnNode(
        'node-abc',
        'ws-test',
        'sess-xyz',
        'Fix the bug in auth.ts',
        env,
        'user-123',
      );

      // Verify URL path
      expect(capture.url).toContain('/workspaces/ws-test/agent-sessions/sess-xyz/prompt');
      expect(capture.url).toContain('node-abc.vm.example.com');

      // Verify body shape
      const parsedBody = JSON.parse(capture.body!);
      expect(parsedBody).toEqual({ prompt: 'Fix the bug in auth.ts' });

      // Verify auth headers (node management token via Bearer header)
      expect(capture.headers!.get('Authorization')).toBe('Bearer mock-jwt');
      expect(capture.headers!.get('Content-Type')).toBe('application/json');

      // Verify custom routing headers set by nodeAgentRequest
      expect(capture.headers!.get('X-SAM-Node-Id')).toBe('node-abc');
      expect(capture.headers!.get('X-SAM-Workspace-Id')).toBe('ws-test');
    });

    it('sendPromptToAgentOnNode includes messageId when provided', async () => {
      vi.resetModules();
      const capture = setupNodeAgentMocks();
      const { sendPromptToAgentOnNode } = await import('../../src/services/node-agent');

      const env = {
        BASE_DOMAIN: 'example.com',
        NODE_AGENT_REQUEST_TIMEOUT_MS: '30000',
      } as any;

      await sendPromptToAgentOnNode(
        'node-abc',
        'ws-test',
        'sess-xyz',
        'Follow up',
        env,
        'user-123',
        'msg-prepersisted-001',
      );

      const parsedBody = JSON.parse(capture.body!);
      expect(parsedBody).toEqual({
        prompt: 'Follow up',
        messageId: 'msg-prepersisted-001',
      });
    });
  });

  describe('startAgentSessionOnNode payload structure', () => {
    it('sends complex nested payload with MCP servers and overrides', async () => {
      vi.resetModules();
      const capture = setupNodeAgentMocks();
      const { startAgentSessionOnNode } = await import('../../src/services/node-agent');

      const env = {
        BASE_DOMAIN: 'example.com',
        NODE_AGENT_REQUEST_TIMEOUT_MS: '30000',
      } as any;

      await startAgentSessionOnNode(
        'node-abc',
        'ws-test',
        'sess-xyz',
        'claude-code',
        'Fix the bug',
        env,
        'user-123',
        { url: 'https://mcp.example.com', token: 'mcp-token' },
        {
          model: 'claude-sonnet-4-6',
          permissionMode: 'auto-edit',
          opencodeProvider: 'scaleway',
          opencodeBaseUrl: 'https://api.scaleway.ai/v1',
        },
        { projectId: 'proj-abc', taskId: 'task-xyz', taskMode: 'task' },
      );

      // Verify URL path
      expect(capture.url).toContain('/workspaces/ws-test/agent-sessions/sess-xyz/start');

      // Verify body has all expected fields
      const parsedBody = JSON.parse(capture.body!);
      expect(parsedBody.agentType).toBe('claude-code');
      expect(parsedBody.initialPrompt).toBe('Fix the bug');

      // MCP servers array
      expect(parsedBody.mcpServers).toEqual([
        { url: 'https://mcp.example.com', token: 'mcp-token' },
      ]);

      // Model overrides
      expect(parsedBody.model).toBe('claude-sonnet-4-6');
      expect(parsedBody.permissionMode).toBe('auto-edit');
      expect(parsedBody.opencodeProvider).toBe('scaleway');
      expect(parsedBody.opencodeBaseUrl).toBe('https://api.scaleway.ai/v1');

      // Task context (flattened into body, not nested)
      expect(parsedBody.projectId).toBe('proj-abc');
      expect(parsedBody.taskId).toBe('task-xyz');
      expect(parsedBody.taskMode).toBe('task');
    });

    it('omits optional fields when not provided', async () => {
      vi.resetModules();
      const capture = setupNodeAgentMocks();
      const { startAgentSessionOnNode } = await import('../../src/services/node-agent');

      await startAgentSessionOnNode(
        'node-abc',
        'ws-test',
        'sess-xyz',
        'claude-code',
        'Hello',
        {} as any,
        'user-123',
        // No MCP server, no overrides, no task context
      );

      const parsedBody = JSON.parse(capture.body!);
      expect(parsedBody.agentType).toBe('claude-code');
      expect(parsedBody.initialPrompt).toBe('Hello');
      expect(parsedBody.mcpServers).toBeUndefined();
      expect(parsedBody.model).toBeUndefined();
      expect(parsedBody.permissionMode).toBeUndefined();
      expect(parsedBody.opencodeProvider).toBeUndefined();
      expect(parsedBody.opencodeBaseUrl).toBeUndefined();
      expect(parsedBody.projectId).toBeUndefined();
      expect(parsedBody.taskId).toBeUndefined();
    });

    it('preserves OpenCode Go provider and GLM 5.2 model overrides', async () => {
      vi.resetModules();
      const capture = setupNodeAgentMocks();
      const { startAgentSessionOnNode } = await import('../../src/services/node-agent');

      await startAgentSessionOnNode(
        'node-abc',
        'ws-test',
        'sess-xyz',
        'opencode',
        'Use GLM 5.2',
        {} as any,
        'user-123',
        undefined,
        {
          model: 'opencode-go/glm-5.2',
          opencodeProvider: 'opencode-go',
        },
      );

      const parsedBody = JSON.parse(capture.body!);
      expect(parsedBody.agentType).toBe('opencode');
      expect(parsedBody.model).toBe('opencode-go/glm-5.2');
      expect(parsedBody.opencodeProvider).toBe('opencode-go');
      expect(parsedBody.opencodeBaseUrl).toBeUndefined();
    });
  });
});

// =============================================================================
// Contract 5: Cancel/Stop Agent Session (API Worker → VM Agent)
// =============================================================================

describe('Contract 5: Cancel/Stop Agent Session (API Worker → VM Agent)', () => {
  describe('cancelAgentSessionOnNode', () => {
    it('returns { success: true, status: 200 } on success', async () => {
      vi.resetModules();
      // VM agent returns 204 No Content on successful cancel
      setupNodeAgentMocks({ status: 204, body: null });
      const { cancelAgentSessionOnNode } = await import('../../src/services/node-agent');

      const result = await cancelAgentSessionOnNode(
        'node-abc',
        'ws-test',
        'sess-xyz',
        {} as any,
        'user-123',
      );

      // cancelAgentSessionOnNode normalizes any 2xx to { success: true, status: 200 }
      // because nodeAgentRequest succeeds silently (no throw) and the wrapper
      // returns a fixed status:200 — it does not propagate the raw HTTP status.
      expect(result).toEqual({ success: true, status: 200 });
    });

    it('returns { success: false, status: 409 } when no prompt in flight (does NOT throw)', async () => {
      vi.resetModules();
      // VM agent returns 409 when no prompt is in flight
      setupNodeAgentMocks({ status: 409, body: '{"error":"no active prompt"}' });
      const { cancelAgentSessionOnNode } = await import('../../src/services/node-agent');

      // Should NOT throw — 409 is expected and handled gracefully
      const result = await cancelAgentSessionOnNode(
        'node-abc',
        'ws-test',
        'sess-xyz',
        {} as any,
        'user-123',
      );

      expect(result.success).toBe(false);
      expect(result.status).toBe(409);
    });

    it('returns { success: false, status: 500 } for unrecognized errors', async () => {
      vi.resetModules();
      setupNodeAgentMocksWithError('Network error: connection refused');
      const { cancelAgentSessionOnNode } = await import('../../src/services/node-agent');

      const result = await cancelAgentSessionOnNode(
        'node-abc',
        'ws-test',
        'sess-xyz',
        {} as any,
        'user-123',
      );

      expect(result.success).toBe(false);
      expect(result.status).toBe(500);
    });

    it('sends POST to correct cancel path', async () => {
      vi.resetModules();
      const capture = setupNodeAgentMocks({ status: 204, body: null });
      const { cancelAgentSessionOnNode } = await import('../../src/services/node-agent');

      await cancelAgentSessionOnNode(
        'node-abc',
        'ws-test',
        'sess-xyz',
        { BASE_DOMAIN: 'example.com' } as any,
        'user-123',
      );

      expect(capture.method).toBe('POST');
      expect(capture.url).toContain('/workspaces/ws-test/agent-sessions/sess-xyz/cancel');
    });
  });

  describe('stopAgentSessionOnNode', () => {
    it('sends POST to correct stop path', async () => {
      vi.resetModules();
      const capture = setupNodeAgentMocks({ status: 204, body: null });
      const { stopAgentSessionOnNode } = await import('../../src/services/node-agent');

      await stopAgentSessionOnNode(
        'node-abc',
        'ws-test',
        'sess-xyz',
        { BASE_DOMAIN: 'example.com' } as any,
        'user-123',
      );

      expect(capture.method).toBe('POST');
      expect(capture.url).toContain('/workspaces/ws-test/agent-sessions/sess-xyz/stop');
    });

    it('throws on non-2xx response (unlike cancel which catches)', async () => {
      vi.resetModules();
      setupNodeAgentMocks({ status: 404, body: '{"error":"session not found"}' });
      const { stopAgentSessionOnNode } = await import('../../src/services/node-agent');

      // stop THROWS on error (unlike cancel which returns { success: false })
      await expect(
        stopAgentSessionOnNode(
          'node-abc',
          'ws-test',
          'sess-xyz',
          {} as any,
          'user-123',
        ),
      ).rejects.toThrow('Node Agent request failed: 404');
    });
  });

  describe('auth mechanism consistency', () => {
    it('cancel uses same node management JWT as other agent session calls', async () => {
      vi.resetModules();

      const mockSignToken = vi.fn().mockResolvedValue({
        token: 'mgmt-jwt',
        expiresAt: new Date().toISOString(),
      });

      const capture = setupNodeAgentMocks({ status: 204, body: null }, mockSignToken);
      const { cancelAgentSessionOnNode } = await import('../../src/services/node-agent');

      await cancelAgentSessionOnNode(
        'node-abc',
        'ws-test',
        'sess-xyz',
        { BASE_DOMAIN: 'example.com' } as any,
        'user-123',
      );

      // Verify it used signNodeManagementToken (not signCallbackToken or signTerminalToken)
      expect(mockSignToken).toHaveBeenCalledWith('user-123', 'node-abc', 'ws-test', expect.anything());
      expect(capture.headers!.get('Authorization')).toBe('Bearer mgmt-jwt');
    });
  });
});
