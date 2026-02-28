/**
 * Node Agent Contract Tests
 *
 * Tests that the TypeScript HTTP client (node-agent.ts) sends correctly-shaped
 * payloads, that JWT tokens have correct claims, and that response/error
 * parsing follows the documented contract.
 */

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { generateKeyPair, exportPKCS8, exportSPKI } from 'jose';
import {
  CreateWorkspaceAgentRequestSchema,
  CreateWorkspaceAgentResponseSchema,
  DeleteWorkspaceAgentResponseSchema,
  HealthResponseSchema,
  CreateAgentSessionAgentRequestSchema,
  AgentSessionResponseSchema,
  WorkspaceReadyRequestSchema,
  WorkspaceReadyResponseSchema,
  ProvisioningFailedRequestSchema,
  ProvisioningFailedResponseSchema,
  PersistMessageBatchRequestSchema,
  PersistMessageBatchResponseSchema,
  ErrorResponseSchema,
  CallbackTokenClaimsSchema,
  NodeManagementTokenClaimsSchema,
  JWT_AUDIENCES,
  JWT_ALGORITHM,
  MAX_BATCH_SIZE,
} from '@simple-agent-manager/shared';

// =============================================================================
// Key generation for JWT tests
// =============================================================================

let testPrivateKey: string;
let testPublicKey: string;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  testPrivateKey = await exportPKCS8(privateKey);
  testPublicKey = await exportSPKI(publicKey);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// =============================================================================
// Schema Validation Tests: Control Plane -> VM Agent
// =============================================================================

describe('Contract schemas: Control Plane -> VM Agent', () => {
  describe('GET /health response', () => {
    it('validates a correct health response', () => {
      const response = {
        status: 'healthy',
        nodeId: 'node-abc123',
        activeWorkspaces: 2,
        workspaces: [
          { id: 'ws-1', status: 'running', sessions: 1 },
          { id: 'ws-2', status: 'creating', sessions: 0 },
        ],
        sessions: 3,
      };
      const result = HealthResponseSchema.safeParse(response);
      expect(result.success).toBe(true);
    });

    it('rejects health response with wrong status literal', () => {
      const response = {
        status: 'unhealthy',
        nodeId: 'node-abc',
        activeWorkspaces: 0,
        workspaces: [],
        sessions: 0,
      };
      const result = HealthResponseSchema.safeParse(response);
      expect(result.success).toBe(false);
    });

    it('rejects health response missing nodeId', () => {
      const response = {
        status: 'healthy',
        activeWorkspaces: 0,
        workspaces: [],
        sessions: 0,
      };
      const result = HealthResponseSchema.safeParse(response);
      expect(result.success).toBe(false);
    });
  });

  describe('POST /workspaces request', () => {
    it('validates a correct create workspace request', () => {
      const request = {
        workspaceId: 'ws-abc123',
        repository: 'owner/repo',
        branch: 'main',
        callbackToken: 'jwt-token-here',
        gitUserName: 'John Doe',
        gitUserEmail: 'john@example.com',
        githubId: '12345',
      };
      const result = CreateWorkspaceAgentRequestSchema.safeParse(request);
      expect(result.success).toBe(true);
    });

    it('validates request with optional fields omitted', () => {
      const request = {
        workspaceId: 'ws-abc123',
        repository: 'owner/repo',
        branch: 'main',
      };
      const result = CreateWorkspaceAgentRequestSchema.safeParse(request);
      expect(result.success).toBe(true);
    });

    it('validates request with null optional fields', () => {
      const request = {
        workspaceId: 'ws-abc123',
        repository: 'owner/repo',
        branch: 'main',
        gitUserName: null,
        gitUserEmail: null,
        githubId: null,
      };
      const result = CreateWorkspaceAgentRequestSchema.safeParse(request);
      expect(result.success).toBe(true);
    });

    it('rejects request with empty workspaceId', () => {
      const request = {
        workspaceId: '',
        repository: 'owner/repo',
        branch: 'main',
      };
      const result = CreateWorkspaceAgentRequestSchema.safeParse(request);
      expect(result.success).toBe(false);
    });

    it('rejects request missing workspaceId', () => {
      const request = {
        repository: 'owner/repo',
        branch: 'main',
      };
      const result = CreateWorkspaceAgentRequestSchema.safeParse(request);
      expect(result.success).toBe(false);
    });
  });

  describe('POST /workspaces response', () => {
    it('validates a correct create workspace response (202)', () => {
      const response = {
        workspaceId: 'ws-abc123',
        status: 'creating',
      };
      const result = CreateWorkspaceAgentResponseSchema.safeParse(response);
      expect(result.success).toBe(true);
    });

    it('rejects response with wrong status', () => {
      const response = {
        workspaceId: 'ws-abc123',
        status: 'running',
      };
      const result = CreateWorkspaceAgentResponseSchema.safeParse(response);
      expect(result.success).toBe(false);
    });
  });

  describe('DELETE /workspaces/:id response', () => {
    it('validates a correct delete response', () => {
      const response = { success: true };
      const result = DeleteWorkspaceAgentResponseSchema.safeParse(response);
      expect(result.success).toBe(true);
    });

    it('rejects response without success field', () => {
      const response = { deleted: true };
      const result = DeleteWorkspaceAgentResponseSchema.safeParse(response);
      expect(result.success).toBe(false);
    });
  });

  describe('POST /workspaces/:id/agent-sessions request', () => {
    it('validates a correct create agent session request', () => {
      const request = {
        sessionId: 'sess-abc123',
        label: 'My Session',
      };
      const result = CreateAgentSessionAgentRequestSchema.safeParse(request);
      expect(result.success).toBe(true);
    });

    it('validates request with null label', () => {
      const request = {
        sessionId: 'sess-abc123',
        label: null,
      };
      const result = CreateAgentSessionAgentRequestSchema.safeParse(request);
      expect(result.success).toBe(true);
    });

    it('rejects request with empty sessionId', () => {
      const request = {
        sessionId: '',
        label: 'My Session',
      };
      const result = CreateAgentSessionAgentRequestSchema.safeParse(request);
      expect(result.success).toBe(false);
    });
  });

  describe('Agent session response', () => {
    it('validates a complete agent session response', () => {
      const response = {
        id: 'sess-abc123',
        workspaceId: 'ws-abc123',
        status: 'running',
        label: 'My Session',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        stoppedAt: null,
        suspendedAt: null,
        errorMessage: null,
      };
      const result = AgentSessionResponseSchema.safeParse(response);
      expect(result.success).toBe(true);
    });

    it('validates a minimal agent session response', () => {
      const response = {
        id: 'sess-abc123',
        workspaceId: 'ws-abc123',
        status: 'running',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };
      const result = AgentSessionResponseSchema.safeParse(response);
      expect(result.success).toBe(true);
    });
  });
});

// =============================================================================
// Schema Validation Tests: VM Agent -> Control Plane (Callbacks)
// =============================================================================

describe('Contract schemas: VM Agent -> Control Plane', () => {
  describe('POST /api/workspaces/:id/ready', () => {
    it('validates ready request with running status', () => {
      const request = { status: 'running' };
      const result = WorkspaceReadyRequestSchema.safeParse(request);
      expect(result.success).toBe(true);
    });

    it('validates ready request with recovery status', () => {
      const request = { status: 'recovery' };
      const result = WorkspaceReadyRequestSchema.safeParse(request);
      expect(result.success).toBe(true);
    });

    it('validates ready request with omitted status (defaults)', () => {
      const request = {};
      const result = WorkspaceReadyRequestSchema.safeParse(request);
      expect(result.success).toBe(true);
    });

    it('rejects ready request with invalid status', () => {
      const request = { status: 'error' };
      const result = WorkspaceReadyRequestSchema.safeParse(request);
      expect(result.success).toBe(false);
    });

    it('validates ready response (success)', () => {
      const response = { success: true };
      const result = WorkspaceReadyResponseSchema.safeParse(response);
      expect(result.success).toBe(true);
    });

    it('validates ready response (failure with reason)', () => {
      const response = { success: false, reason: 'workspace_not_running' };
      const result = WorkspaceReadyResponseSchema.safeParse(response);
      expect(result.success).toBe(true);
    });
  });

  describe('POST /api/workspaces/:id/provisioning-failed', () => {
    it('validates provisioning-failed request with error message', () => {
      const request = { errorMessage: 'devcontainer up failed' };
      const result = ProvisioningFailedRequestSchema.safeParse(request);
      expect(result.success).toBe(true);
    });

    it('validates provisioning-failed request without error message', () => {
      const request = {};
      const result = ProvisioningFailedRequestSchema.safeParse(request);
      expect(result.success).toBe(true);
    });

    it('validates provisioning-failed response (success)', () => {
      const response = { success: true };
      const result = ProvisioningFailedResponseSchema.safeParse(response);
      expect(result.success).toBe(true);
    });

    it('validates provisioning-failed response (failure with reason)', () => {
      const response = { success: false, reason: 'workspace_not_creating' };
      const result = ProvisioningFailedResponseSchema.safeParse(response);
      expect(result.success).toBe(true);
    });
  });

  describe('POST /api/workspaces/:id/messages', () => {
    it('validates a correct message batch request', () => {
      const request = {
        messages: [
          {
            messageId: 'msg-001',
            sessionId: 'sess-abc',
            role: 'user',
            content: 'Hello, world!',
            timestamp: '2024-01-01T00:00:00Z',
          },
          {
            messageId: 'msg-002',
            sessionId: 'sess-abc',
            role: 'assistant',
            content: 'Hi there!',
            toolMetadata: '{"tool":"bash","target":"ls","status":"success"}',
            timestamp: '2024-01-01T00:00:01Z',
          },
        ],
      };
      const result = PersistMessageBatchRequestSchema.safeParse(request);
      expect(result.success).toBe(true);
    });

    it('validates a single-message batch', () => {
      const request = {
        messages: [
          {
            messageId: 'msg-001',
            sessionId: 'sess-abc',
            role: 'system',
            content: 'System prompt',
            timestamp: '2024-01-01T00:00:00Z',
          },
        ],
      };
      const result = PersistMessageBatchRequestSchema.safeParse(request);
      expect(result.success).toBe(true);
    });

    it('rejects empty messages array', () => {
      const request = { messages: [] };
      const result = PersistMessageBatchRequestSchema.safeParse(request);
      expect(result.success).toBe(false);
    });

    it('rejects batch exceeding MAX_BATCH_SIZE', () => {
      const messages = Array.from({ length: MAX_BATCH_SIZE + 1 }, (_, i) => ({
        messageId: `msg-${i}`,
        sessionId: 'sess-abc',
        role: 'user' as const,
        content: `Message ${i}`,
        timestamp: '2024-01-01T00:00:00Z',
      }));
      const request = { messages };
      const result = PersistMessageBatchRequestSchema.safeParse(request);
      expect(result.success).toBe(false);
    });

    it('rejects message with invalid role', () => {
      const request = {
        messages: [
          {
            messageId: 'msg-001',
            sessionId: 'sess-abc',
            role: 'admin',
            content: 'Hello',
            timestamp: '2024-01-01T00:00:00Z',
          },
        ],
      };
      const result = PersistMessageBatchRequestSchema.safeParse(request);
      expect(result.success).toBe(false);
    });

    it('rejects message with empty content', () => {
      const request = {
        messages: [
          {
            messageId: 'msg-001',
            sessionId: 'sess-abc',
            role: 'user',
            content: '',
            timestamp: '2024-01-01T00:00:00Z',
          },
        ],
      };
      const result = PersistMessageBatchRequestSchema.safeParse(request);
      expect(result.success).toBe(false);
    });

    it('rejects message with missing messageId', () => {
      const request = {
        messages: [
          {
            sessionId: 'sess-abc',
            role: 'user',
            content: 'Hello',
            timestamp: '2024-01-01T00:00:00Z',
          },
        ],
      };
      const result = PersistMessageBatchRequestSchema.safeParse(request);
      expect(result.success).toBe(false);
    });

    it('validates message batch response', () => {
      const response = { persisted: 3, duplicates: 1 };
      const result = PersistMessageBatchResponseSchema.safeParse(response);
      expect(result.success).toBe(true);
    });

    it('rejects response with negative persisted count', () => {
      const response = { persisted: -1, duplicates: 0 };
      const result = PersistMessageBatchResponseSchema.safeParse(response);
      expect(result.success).toBe(false);
    });
  });
});

// =============================================================================
// Error Response Format Tests
// =============================================================================

describe('Standardized error response format', () => {
  it('validates error with just error field', () => {
    const response = { error: 'not found' };
    const result = ErrorResponseSchema.safeParse(response);
    expect(result.success).toBe(true);
  });

  it('validates error with error and message fields', () => {
    const response = { error: 'invalid_request', message: 'workspaceId is required' };
    const result = ErrorResponseSchema.safeParse(response);
    expect(result.success).toBe(true);
  });

  it('rejects error response without error field', () => {
    const response = { message: 'something went wrong' };
    const result = ErrorResponseSchema.safeParse(response);
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// JWT Contract Tests
// =============================================================================

describe('JWT Token Contract', () => {
  describe('signCallbackToken', () => {
    it('produces a token with correct claims', async () => {
      const { signCallbackToken } = await import('../../src/services/jwt');
      const { jwtVerify, importSPKI } = await import('jose');

      const env = {
        JWT_PRIVATE_KEY: testPrivateKey,
        JWT_PUBLIC_KEY: testPublicKey,
        BASE_DOMAIN: 'example.com',
      } as any;

      const token = await signCallbackToken('ws-test-123', env);
      expect(typeof token).toBe('string');

      // Verify and extract claims
      const publicKey = await importSPKI(testPublicKey, JWT_ALGORITHM);
      const { payload, protectedHeader } = await jwtVerify(token, publicKey, {
        issuer: 'https://api.example.com',
        audience: JWT_AUDIENCES.callback,
      });

      // Validate header
      expect(protectedHeader.alg).toBe(JWT_ALGORITHM);
      expect(protectedHeader.kid).toMatch(/^key-\d{4}-\d{2}$/);

      // Validate claims against schema
      const claimsResult = CallbackTokenClaimsSchema.safeParse(payload);
      expect(claimsResult.success).toBe(true);

      // Validate specific claim values
      expect(payload.workspace).toBe('ws-test-123');
      expect(payload.type).toBe('callback');
      expect(payload.sub).toBe('ws-test-123');
      expect(payload.aud).toBe(JWT_AUDIENCES.callback);
      expect(payload.iss).toBe('https://api.example.com');
      expect(typeof payload.exp).toBe('number');
      expect(typeof payload.iat).toBe('number');

      // Token should expire in the future (default 24h)
      const expiry = (payload.exp as number) - (payload.iat as number);
      expect(expiry).toBeGreaterThan(0);
      expect(expiry).toBeLessThanOrEqual(24 * 60 * 60 + 1);
    });
  });

  describe('signNodeManagementToken', () => {
    it('produces a token with correct claims for workspace-scoped request', async () => {
      const { signNodeManagementToken } = await import('../../src/services/jwt');
      const { jwtVerify, importSPKI } = await import('jose');

      const env = {
        JWT_PRIVATE_KEY: testPrivateKey,
        JWT_PUBLIC_KEY: testPublicKey,
        BASE_DOMAIN: 'example.com',
      } as any;

      const { token, expiresAt } = await signNodeManagementToken(
        'user-123',
        'node-abc',
        'ws-xyz',
        env
      );
      expect(typeof token).toBe('string');
      expect(typeof expiresAt).toBe('string');

      const publicKey = await importSPKI(testPublicKey, JWT_ALGORITHM);
      const { payload, protectedHeader } = await jwtVerify(token, publicKey, {
        issuer: 'https://api.example.com',
        audience: JWT_AUDIENCES.nodeManagement,
      });

      expect(protectedHeader.alg).toBe(JWT_ALGORITHM);

      const claimsResult = NodeManagementTokenClaimsSchema.safeParse(payload);
      expect(claimsResult.success).toBe(true);

      expect(payload.type).toBe('node-management');
      expect(payload.node).toBe('node-abc');
      expect(payload.workspace).toBe('ws-xyz');
      expect(payload.sub).toBe('user-123');
      expect(payload.aud).toBe(JWT_AUDIENCES.nodeManagement);
    });

    it('produces a token without workspace claim when null', async () => {
      const { signNodeManagementToken } = await import('../../src/services/jwt');
      const { jwtVerify, importSPKI } = await import('jose');

      const env = {
        JWT_PRIVATE_KEY: testPrivateKey,
        JWT_PUBLIC_KEY: testPublicKey,
        BASE_DOMAIN: 'example.com',
      } as any;

      const { token } = await signNodeManagementToken('user-123', 'node-abc', null, env);

      const publicKey = await importSPKI(testPublicKey, JWT_ALGORITHM);
      const { payload } = await jwtVerify(token, publicKey, {
        issuer: 'https://api.example.com',
        audience: JWT_AUDIENCES.nodeManagement,
      });

      expect(payload.type).toBe('node-management');
      expect(payload.node).toBe('node-abc');
      expect(payload.workspace).toBeUndefined();
    });
  });

  describe('verifyCallbackToken', () => {
    it('verifies a valid callback token', async () => {
      const { signCallbackToken, verifyCallbackToken } = await import('../../src/services/jwt');

      const env = {
        JWT_PRIVATE_KEY: testPrivateKey,
        JWT_PUBLIC_KEY: testPublicKey,
        BASE_DOMAIN: 'example.com',
      } as any;

      const token = await signCallbackToken('ws-verify-test', env);
      const payload = await verifyCallbackToken(token, env);

      expect(payload.workspace).toBe('ws-verify-test');
      expect(payload.type).toBe('callback');
    });

    it('rejects an expired callback token', async () => {
      const { SignJWT, importPKCS8 } = await import('jose');
      const { verifyCallbackToken } = await import('../../src/services/jwt');

      const privateKey = await importPKCS8(testPrivateKey, JWT_ALGORITHM);

      const expiredToken = await new SignJWT({
        workspace: 'ws-expired',
        type: 'callback',
      })
        .setProtectedHeader({ alg: JWT_ALGORITHM, kid: 'key-2024-01' })
        .setIssuer('https://api.example.com')
        .setSubject('ws-expired')
        .setAudience(JWT_AUDIENCES.callback)
        .setExpirationTime(new Date(Date.now() - 60_000))
        .setIssuedAt(new Date(Date.now() - 120_000))
        .sign(privateKey);

      const env = {
        JWT_PRIVATE_KEY: testPrivateKey,
        JWT_PUBLIC_KEY: testPublicKey,
        BASE_DOMAIN: 'example.com',
      } as any;

      await expect(verifyCallbackToken(expiredToken, env)).rejects.toThrow();
    });

    it('rejects a token with wrong audience', async () => {
      const { SignJWT, importPKCS8 } = await import('jose');
      const { verifyCallbackToken } = await import('../../src/services/jwt');

      const privateKey = await importPKCS8(testPrivateKey, JWT_ALGORITHM);

      const wrongAudienceToken = await new SignJWT({
        workspace: 'ws-wrong-aud',
        type: 'callback',
      })
        .setProtectedHeader({ alg: JWT_ALGORITHM, kid: 'key-2024-01' })
        .setIssuer('https://api.example.com')
        .setSubject('ws-wrong-aud')
        .setAudience(JWT_AUDIENCES.terminal)
        .setExpirationTime('1h')
        .setIssuedAt()
        .sign(privateKey);

      const env = {
        JWT_PRIVATE_KEY: testPrivateKey,
        JWT_PUBLIC_KEY: testPublicKey,
        BASE_DOMAIN: 'example.com',
      } as any;

      await expect(verifyCallbackToken(wrongAudienceToken, env)).rejects.toThrow();
    });

    it('rejects a token with wrong type claim', async () => {
      const { SignJWT, importPKCS8 } = await import('jose');
      const { verifyCallbackToken } = await import('../../src/services/jwt');

      const privateKey = await importPKCS8(testPrivateKey, JWT_ALGORITHM);

      const wrongTypeToken = await new SignJWT({
        workspace: 'ws-wrong-type',
        type: 'terminal',
      })
        .setProtectedHeader({ alg: JWT_ALGORITHM, kid: 'key-2024-01' })
        .setIssuer('https://api.example.com')
        .setSubject('ws-wrong-type')
        .setAudience(JWT_AUDIENCES.callback)
        .setExpirationTime('1h')
        .setIssuedAt()
        .sign(privateKey);

      const env = {
        JWT_PRIVATE_KEY: testPrivateKey,
        JWT_PUBLIC_KEY: testPublicKey,
        BASE_DOMAIN: 'example.com',
      } as any;

      await expect(verifyCallbackToken(wrongTypeToken, env)).rejects.toThrow('Invalid token type');
    });

    it('rejects a token missing workspace claim', async () => {
      const { SignJWT, importPKCS8 } = await import('jose');
      const { verifyCallbackToken } = await import('../../src/services/jwt');

      const privateKey = await importPKCS8(testPrivateKey, JWT_ALGORITHM);

      const noWorkspaceToken = await new SignJWT({
        type: 'callback',
      })
        .setProtectedHeader({ alg: JWT_ALGORITHM, kid: 'key-2024-01' })
        .setIssuer('https://api.example.com')
        .setSubject('some-subject')
        .setAudience(JWT_AUDIENCES.callback)
        .setExpirationTime('1h')
        .setIssuedAt()
        .sign(privateKey);

      const env = {
        JWT_PRIVATE_KEY: testPrivateKey,
        JWT_PUBLIC_KEY: testPublicKey,
        BASE_DOMAIN: 'example.com',
      } as any;

      await expect(verifyCallbackToken(noWorkspaceToken, env)).rejects.toThrow(
        'Missing workspace claim'
      );
    });
  });
});

// =============================================================================
// Node Agent Client Function Contract Tests
// =============================================================================

describe('Node Agent client functions send correct payloads', () => {
  it('createWorkspaceOnNode sends correct JSON body', async () => {
    // Mock the JWT signing
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
    let capturedHeaders: Headers | null = null;
    let capturedUrl: string | null = null;

    vi.doMock('../../src/services/fetch-timeout', () => ({
      fetchWithTimeout: vi.fn().mockImplementation((url: string, init: RequestInit) => {
        capturedUrl = url;
        capturedHeaders = new Headers(init.headers);
        capturedBody = init.body as string;
        return Promise.resolve(
          new Response(JSON.stringify({ workspaceId: 'ws-test', status: 'creating' }), {
            status: 202,
            headers: { 'Content-Type': 'application/json' },
          })
        );
      }),
      getTimeoutMs: vi.fn().mockReturnValue(30000),
    }));

    // Dynamic import to pick up mocks
    const { createWorkspaceOnNode } = await import('../../src/services/node-agent');

    const env = {
      BASE_DOMAIN: 'example.com',
      NODE_AGENT_REQUEST_TIMEOUT_MS: '30000',
    } as any;

    await createWorkspaceOnNode('node-abc', env, 'user-123', {
      workspaceId: 'ws-test',
      repository: 'owner/repo',
      branch: 'main',
      callbackToken: 'cb-token',
      gitUserName: 'Test User',
      gitUserEmail: 'test@example.com',
      githubId: '42',
    });

    // Verify URL
    expect(capturedUrl).toContain('/workspaces');
    expect(capturedUrl).toContain('vm-node-abc.example.com');

    // Verify body shape matches contract
    const parsedBody = JSON.parse(capturedBody!);
    const result = CreateWorkspaceAgentRequestSchema.safeParse(parsedBody);
    expect(result.success).toBe(true);
    expect(parsedBody.workspaceId).toBe('ws-test');
    expect(parsedBody.repository).toBe('owner/repo');
    expect(parsedBody.branch).toBe('main');
    expect(parsedBody.callbackToken).toBe('cb-token');

    // Verify auth header
    expect(capturedHeaders!.get('Authorization')).toBe('Bearer mock-jwt');
    expect(capturedHeaders!.get('Content-Type')).toBe('application/json');
  });

  it('deleteWorkspaceOnNode sends DELETE with correct path', async () => {
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

    let capturedMethod: string | null = null;
    let capturedUrl: string | null = null;

    vi.doMock('../../src/services/fetch-timeout', () => ({
      fetchWithTimeout: vi.fn().mockImplementation((url: string, init: RequestInit) => {
        capturedUrl = url;
        capturedMethod = init.method ?? 'GET';
        return Promise.resolve(
          new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        );
      }),
      getTimeoutMs: vi.fn().mockReturnValue(30000),
    }));

    const { deleteWorkspaceOnNode } = await import('../../src/services/node-agent');

    await deleteWorkspaceOnNode('node-abc', 'ws-delete-me', {} as any, 'user-123');

    expect(capturedMethod).toBe('DELETE');
    expect(capturedUrl).toContain('/workspaces/ws-delete-me');
  });

  it('createAgentSessionOnNode sends correct JSON body', async () => {
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
          new Response(
            JSON.stringify({
              id: 'sess-new',
              workspaceId: 'ws-test',
              status: 'running',
              createdAt: '2024-01-01T00:00:00Z',
              updatedAt: '2024-01-01T00:00:00Z',
            }),
            {
              status: 201,
              headers: { 'Content-Type': 'application/json' },
            }
          )
        );
      }),
      getTimeoutMs: vi.fn().mockReturnValue(30000),
    }));

    const { createAgentSessionOnNode } = await import('../../src/services/node-agent');

    await createAgentSessionOnNode('node-abc', 'ws-test', 'sess-new', 'Test Session', {} as any, 'user-123');

    const parsedBody = JSON.parse(capturedBody!);
    const result = CreateAgentSessionAgentRequestSchema.safeParse(parsedBody);
    expect(result.success).toBe(true);
    expect(parsedBody.sessionId).toBe('sess-new');
    expect(parsedBody.label).toBe('Test Session');
  });

  it('node agent request throws on non-ok response', async () => {
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
        new Response(JSON.stringify({ error: 'workspace not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        })
      ),
      getTimeoutMs: vi.fn().mockReturnValue(30000),
    }));

    const { deleteWorkspaceOnNode } = await import('../../src/services/node-agent');

    await expect(
      deleteWorkspaceOnNode('node-abc', 'ws-missing', {} as any, 'user-123')
    ).rejects.toThrow('Node Agent request failed: 404');
  });

  it('node agent request throws on timeout', async () => {
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
      fetchWithTimeout: vi.fn().mockRejectedValue(
        new Error('Request timed out after 30000ms: http://vm-node-abc.example.com:8080/workspaces/ws-test')
      ),
      getTimeoutMs: vi.fn().mockReturnValue(30000),
    }));

    const { deleteWorkspaceOnNode } = await import('../../src/services/node-agent');

    await expect(
      deleteWorkspaceOnNode('node-abc', 'ws-test', {} as any, 'user-123')
    ).rejects.toThrow('Request timed out');
  });
});
