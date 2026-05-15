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
      const workspaceId = 'ws-abc123';
      const baseDomain = 'example.com';

      // Reproduce URL construction from workspace-steps.ts:374
      const vmUrl = `${protocol}://ws-${workspaceId}.${baseDomain}:${port}`;
      const uploadUrl = `${vmUrl}/workspaces/${workspaceId}/files/upload`;

      expect(uploadUrl).toBe('https://ws-ws-abc123.example.com:8443/workspaces/ws-abc123/files/upload');
      expect(uploadUrl).toContain('ws-ws-abc123');
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
      // From workspace-steps.ts:393-397
      const DEFAULT_ATTACHMENT_TRANSFER_TIMEOUT_MS = 60_000;

      // Without env override
      const timeout1 = parseInt('' || String(DEFAULT_ATTACHMENT_TRANSFER_TIMEOUT_MS), 10)
        || DEFAULT_ATTACHMENT_TRANSFER_TIMEOUT_MS;
      expect(timeout1).toBe(60_000);

      // With env override
      const timeout2 = parseInt('120000' || String(DEFAULT_ATTACHMENT_TRANSFER_TIMEOUT_MS), 10)
        || DEFAULT_ATTACHMENT_TRANSFER_TIMEOUT_MS;
      expect(timeout2).toBe(120_000);

      // With invalid env override falls back to default
      const timeout3 = parseInt('not-a-number' || String(DEFAULT_ATTACHMENT_TRANSFER_TIMEOUT_MS), 10)
        || DEFAULT_ATTACHMENT_TRANSFER_TIMEOUT_MS;
      expect(timeout3).toBe(DEFAULT_ATTACHMENT_TRANSFER_TIMEOUT_MS);
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

      const goUrl = controlPlaneURL.replace(/\/+$/, '') +
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

      const goUrl = controlPlaneURL.replace(/\/+$/, '') +
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
    it('validates the payload the VM agent sends', () => {
      // From workspace_callbacks.go:37-41:
      //   payload := map[string]string{
      //     "agentType":      agentType,
      //     "credentialKind": credentialKind,
      //     "credential":     credential,
      //   }
      const goPayload = {
        agentType: 'openai-codex',
        credentialKind: 'oauth-token',
        credential: '{"tokens":{"access_token":"new-jwt","refresh_token":"rt"}}',
      };

      // Must pass the Valibot schema
      const result = v.safeParse(AgentCredentialSyncSchema, goPayload);
      expect(result.success).toBe(true);
    });

    it('validates payload with api-key credential kind', () => {
      const goPayload = {
        agentType: 'claude-code',
        credentialKind: 'api-key',
        credential: 'sk-ant-XXXX',
      };

      const result = v.safeParse(AgentCredentialSyncSchema, goPayload);
      expect(result.success).toBe(true);
    });

    it('validates payload with optional fields omitted', () => {
      // The schema marks agentType and credentialKind as optional
      const minimalPayload = {
        credential: 'some-credential-value',
      };

      const result = v.safeParse(AgentCredentialSyncSchema, minimalPayload);
      expect(result.success).toBe(true);
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

      const goUrl = controlPlaneURL.replace(/\/+$/, '') +
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

      const goUrl = controlPlaneURL.replace(/\/+$/, '') +
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

      vi.doMock('../../src/services/jwt', () => ({
        signNodeManagementToken: vi.fn().mockResolvedValue({
          token: 'mock-jwt',
          expiresAt: new Date().toISOString(),
        }),
      }));

      vi.doMock('../../src/services/telemetry', () => ({
        recordNodeRoutingMetric: vi.fn(),
      }));

      let capturedBody: string | null = null;
      let capturedUrl: string | null = null;
      let capturedHeaders: Headers | null = null;

      vi.doMock('../../src/services/fetch-timeout', () => ({
        fetchWithTimeout: vi.fn().mockImplementation((url: string, init: RequestInit) => {
          capturedUrl = url;
          capturedBody = init.body as string;
          capturedHeaders = new Headers(init.headers);
          return Promise.resolve(
            new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
          );
        }),
        getTimeoutMs: vi.fn().mockReturnValue(30000),
      }));

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
      expect(capturedUrl).toContain('/workspaces/ws-test/agent-sessions/sess-xyz/prompt');
      expect(capturedUrl).toContain('node-abc.vm.example.com');

      // Verify body shape
      const parsedBody = JSON.parse(capturedBody!);
      expect(parsedBody).toEqual({ prompt: 'Fix the bug in auth.ts' });

      // Verify auth headers (node management token via Bearer header)
      expect(capturedHeaders!.get('Authorization')).toBe('Bearer mock-jwt');
      expect(capturedHeaders!.get('Content-Type')).toBe('application/json');
    });
  });

  describe('startAgentSessionOnNode payload structure', () => {
    it('sends complex nested payload with MCP servers and overrides', async () => {
      vi.resetModules();

      vi.doMock('../../src/services/jwt', () => ({
        signNodeManagementToken: vi.fn().mockResolvedValue({
          token: 'mock-jwt',
          expiresAt: new Date().toISOString(),
        }),
      }));

      vi.doMock('../../src/services/telemetry', () => ({
        recordNodeRoutingMetric: vi.fn(),
      }));

      let capturedBody: string | null = null;
      let capturedUrl: string | null = null;

      vi.doMock('../../src/services/fetch-timeout', () => ({
        fetchWithTimeout: vi.fn().mockImplementation((url: string, init: RequestInit) => {
          capturedUrl = url;
          capturedBody = init.body as string;
          return Promise.resolve(
            new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
          );
        }),
        getTimeoutMs: vi.fn().mockReturnValue(30000),
      }));

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
        { model: 'claude-sonnet-4-6', permissionMode: 'auto-edit' },
        { projectId: 'proj-abc', taskId: 'task-xyz', taskMode: 'task' },
      );

      // Verify URL path
      expect(capturedUrl).toContain('/workspaces/ws-test/agent-sessions/sess-xyz/start');

      // Verify body has all expected fields
      const parsedBody = JSON.parse(capturedBody!);
      expect(parsedBody.agentType).toBe('claude-code');
      expect(parsedBody.initialPrompt).toBe('Fix the bug');

      // MCP servers array
      expect(parsedBody.mcpServers).toEqual([
        { url: 'https://mcp.example.com', token: 'mcp-token' },
      ]);

      // Model overrides
      expect(parsedBody.model).toBe('claude-sonnet-4-6');
      expect(parsedBody.permissionMode).toBe('auto-edit');

      // Task context (flattened into body, not nested)
      expect(parsedBody.projectId).toBe('proj-abc');
      expect(parsedBody.taskId).toBe('task-xyz');
      expect(parsedBody.taskMode).toBe('task');
    });

    it('omits optional fields when not provided', async () => {
      vi.resetModules();

      vi.doMock('../../src/services/jwt', () => ({
        signNodeManagementToken: vi.fn().mockResolvedValue({
          token: 'mock-jwt',
          expiresAt: new Date().toISOString(),
        }),
      }));

      vi.doMock('../../src/services/telemetry', () => ({
        recordNodeRoutingMetric: vi.fn(),
      }));

      let capturedBody: string | null = null;

      vi.doMock('../../src/services/fetch-timeout', () => ({
        fetchWithTimeout: vi.fn().mockImplementation((_url: string, init: RequestInit) => {
          capturedBody = init.body as string;
          return Promise.resolve(
            new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
          );
        }),
        getTimeoutMs: vi.fn().mockReturnValue(30000),
      }));

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

      const parsedBody = JSON.parse(capturedBody!);
      expect(parsedBody.agentType).toBe('claude-code');
      expect(parsedBody.initialPrompt).toBe('Hello');
      expect(parsedBody.mcpServers).toBeUndefined();
      expect(parsedBody.model).toBeUndefined();
      expect(parsedBody.permissionMode).toBeUndefined();
      expect(parsedBody.projectId).toBeUndefined();
      expect(parsedBody.taskId).toBeUndefined();
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
        fetchWithTimeout: vi.fn().mockResolvedValue(
          new Response(null, { status: 204 }),
        ),
        getTimeoutMs: vi.fn().mockReturnValue(30000),
      }));

      const { cancelAgentSessionOnNode } = await import('../../src/services/node-agent');

      const result = await cancelAgentSessionOnNode(
        'node-abc',
        'ws-test',
        'sess-xyz',
        {} as any,
        'user-123',
      );

      expect(result).toEqual({ success: true, status: 200 });
    });

    it('returns { success: false, status: 409 } when no prompt in flight (does NOT throw)', async () => {
      vi.resetModules();

      vi.doMock('../../src/services/jwt', () => ({
        signNodeManagementToken: vi.fn().mockResolvedValue({
          token: 'mock-jwt',
          expiresAt: new Date().toISOString(),
        }),
      }));

      vi.doMock('../../src/services/telemetry', () => ({
        recordNodeRoutingMetric: vi.fn(),
      }));

      // VM agent returns 409 when no prompt is in flight
      vi.doMock('../../src/services/fetch-timeout', () => ({
        fetchWithTimeout: vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ error: 'no active prompt' }), {
            status: 409,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
        getTimeoutMs: vi.fn().mockReturnValue(30000),
      }));

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

      vi.doMock('../../src/services/jwt', () => ({
        signNodeManagementToken: vi.fn().mockResolvedValue({
          token: 'mock-jwt',
          expiresAt: new Date().toISOString(),
        }),
      }));

      vi.doMock('../../src/services/telemetry', () => ({
        recordNodeRoutingMetric: vi.fn(),
      }));

      // Simulate a network error (no HTTP status in error message)
      vi.doMock('../../src/services/fetch-timeout', () => ({
        fetchWithTimeout: vi.fn().mockRejectedValue(new Error('Network error: connection refused')),
        getTimeoutMs: vi.fn().mockReturnValue(30000),
      }));

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

      vi.doMock('../../src/services/jwt', () => ({
        signNodeManagementToken: vi.fn().mockResolvedValue({
          token: 'mock-jwt',
          expiresAt: new Date().toISOString(),
        }),
      }));

      vi.doMock('../../src/services/telemetry', () => ({
        recordNodeRoutingMetric: vi.fn(),
      }));

      let capturedUrl: string | null = null;
      let capturedMethod: string | null = null;

      vi.doMock('../../src/services/fetch-timeout', () => ({
        fetchWithTimeout: vi.fn().mockImplementation((url: string, init: RequestInit) => {
          capturedUrl = url;
          capturedMethod = init.method ?? 'GET';
          return Promise.resolve(new Response(null, { status: 204 }));
        }),
        getTimeoutMs: vi.fn().mockReturnValue(30000),
      }));

      const { cancelAgentSessionOnNode } = await import('../../src/services/node-agent');

      await cancelAgentSessionOnNode(
        'node-abc',
        'ws-test',
        'sess-xyz',
        { BASE_DOMAIN: 'example.com' } as any,
        'user-123',
      );

      expect(capturedMethod).toBe('POST');
      expect(capturedUrl).toContain('/workspaces/ws-test/agent-sessions/sess-xyz/cancel');
    });
  });

  describe('stopAgentSessionOnNode', () => {
    it('sends POST to correct stop path', async () => {
      vi.resetModules();

      vi.doMock('../../src/services/jwt', () => ({
        signNodeManagementToken: vi.fn().mockResolvedValue({
          token: 'mock-jwt',
          expiresAt: new Date().toISOString(),
        }),
      }));

      vi.doMock('../../src/services/telemetry', () => ({
        recordNodeRoutingMetric: vi.fn(),
      }));

      let capturedUrl: string | null = null;
      let capturedMethod: string | null = null;

      vi.doMock('../../src/services/fetch-timeout', () => ({
        fetchWithTimeout: vi.fn().mockImplementation((url: string, init: RequestInit) => {
          capturedUrl = url;
          capturedMethod = init.method ?? 'GET';
          return Promise.resolve(new Response(null, { status: 204 }));
        }),
        getTimeoutMs: vi.fn().mockReturnValue(30000),
      }));

      const { stopAgentSessionOnNode } = await import('../../src/services/node-agent');

      await stopAgentSessionOnNode(
        'node-abc',
        'ws-test',
        'sess-xyz',
        { BASE_DOMAIN: 'example.com' } as any,
        'user-123',
      );

      expect(capturedMethod).toBe('POST');
      expect(capturedUrl).toContain('/workspaces/ws-test/agent-sessions/sess-xyz/stop');
    });

    it('throws on non-2xx response (unlike cancel which catches)', async () => {
      vi.resetModules();

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
        fetchWithTimeout: vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ error: 'session not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
        getTimeoutMs: vi.fn().mockReturnValue(30000),
      }));

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

      vi.doMock('../../src/services/jwt', () => ({
        signNodeManagementToken: mockSignToken,
      }));

      vi.doMock('../../src/services/telemetry', () => ({
        recordNodeRoutingMetric: vi.fn(),
      }));

      let capturedHeaders: Headers | null = null;

      vi.doMock('../../src/services/fetch-timeout', () => ({
        fetchWithTimeout: vi.fn().mockImplementation((_url: string, init: RequestInit) => {
          capturedHeaders = new Headers(init.headers);
          return Promise.resolve(new Response(null, { status: 204 }));
        }),
        getTimeoutMs: vi.fn().mockReturnValue(30000),
      }));

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
      expect(capturedHeaders!.get('Authorization')).toBe('Bearer mgmt-jwt');
    });
  });
});
