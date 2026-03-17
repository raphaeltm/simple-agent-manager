/**
 * Unit tests for port proxy token injection and behavior.
 *
 * Verifies that:
 * 1. The workspace proxy injects a JWT token for port-forwarded requests
 * 2. The signTerminalToken function works with the 'port-proxy' subject
 * 3. Port proxy requests are rewritten correctly
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { jwtVerify, importSPKI } from 'jose';

// Test RSA key pair (same as vitest.workers.config.ts)
const TEST_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCV93x2EyxEBk7u
pFMTLatfONe6gGOnr6XV2z9FsfAN+8nVtHNykTXb+MxUPR7rn8im7CIQLkjQRRca
ieyya6tpusK5x08Qo4L/SzXW+XsKjf81k9cBwm84N3VVKSzbexUtz4uJWKWi+1sC
FKWoCR+DWgWvhPw3jg/rt32N/hTKbMjEbMx224VmV+Dka2qVFLiqKW46o9astLcq
gX/orE/y9wivDPzMQTM3IfRUwJHlJu0WIb70oLyptbXXAOBmGFJMdbEvpWItRODf
diJ3Pw9ngW97Er4AIfT2Wx0KnUchG8BFA2nfgrxI8M396nM8uSs8ezDaoCgYoktm
CcuIIOb1AgMBAAECggEACmF5v5CfMUxAfXtpdrvkD3DXWgUWIN7jO1T0YcYp6EXk
GENn9GfB0yq7Nh+O+t9yG7/fscAKcUQ/D6q5dDZIxMZVQVffDLdM05Aot2tIjZf7
sQE9UlVbrogEOrNhdAXmlue1cHnu6UO97nxwZRvQjx6Voysw7EWMq5PlgIU0ejiH
YjE52VQNadxQhZ8DqphOahcOt20deZ41cwN1bKlY4DnLuahVfkIZ9tA66+IY5ob2
TuAl1plxQfadUNkVOusMbLjjv4ol/aqxccyhxr3IA/kM3UYiFxNohKIEJFsUuzGt
WZxdIquRaH+FQtnhCUypkURcdzLrUisTQVgjVm97lwKBgQDGxjDwUkaefCMbv3FH
AyVIaA8oMXRpERawEHmcS+egzfkdC4yC50Eh4fgYuSihnIKMYuJ4kJInarmfeZFD
8EZdMqHckSNpxQcgYCII42gaXh/BjjZ+lQYmDKXyApTyfHwP/vZ/nkZjaJrEEWIg
f4i+iN3B7KtIlZ1LuRF99d6BfwKBgQDBJCY+lYGIUBui+p+bbHdv5bK7uVg7xBim
HLdr+LUioHQeSc0Z5mCjGWRV40KSCWP4iZNCvLHKPX8a0z3kEkKErLpwLPlZSB8a
gWmC4p1FIFhn2P8od6LtaWGbMg+palXm/uDw990depEF3j9dMmnoQvt9rtEJxhgF
NeDCzYzpiwKBgQDCfp7YJ8lNve2kcvhmIZ/Tb26VR36+Z6gpcpVr56GnaKM+VlSQ
qbLDcpYNqu8k4z2iHAe5LMy1oOosLwmCzpIrEyXp6mIaVl2YwjfLNqhgVIUCISMV
TMANbwbY/Mm9Uy0ZgcK0MKxzDKGTA+deISwuM0G5RNh8V1joBRgmhfPIBQKBgHnE
NrBiRaYRCzt3UsUEX1CWulaMBcq4WOnxVNqnlFteWZb25G4dxnNNgOp9Ou0jKnn5
EnSSzmw41TeuUmjF8lX/KBOs5w+Y3rMxP7oa8Rgxykq+ji+PLZMMS1My/pjKx5m4
u0xwmGELcv8GHWC+dfLOuAuG+Zd14pL2YtuuB9b9AoGAIeYQNLMHNyEK/Kh4Vsza
9rzbR0oXLqIe3PJOKqxpA4gSBdXbsizc7bkhhTHPDTpUo30Pke5f03O/RoawLT63
r3SA1x5MVCsiVcqybvqtMIyy1zc/oKSUyuYh44Sjpii7Q9DJlCeMupyA3TSVb0Qa
O+hP/5ZHDz4epkJVLKvwE2Y=
-----END PRIVATE KEY-----`;

const TEST_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAlfd8dhMsRAZO7qRTEy2r
XzjXuoBjp6+l1ds/RbHwDfvJ1bRzcpE12/jMVD0e65/IpuwiEC5I0EUXGonssmur
abrCucdPEKOC/0s11vl7Co3/NZPXAcJvODd1VSks23sVLc+LiVilovtbAhSlqAkf
g1oFr4T8N44P67d9jf4UymzIxGzMdtuFZlfg5GtqlRS4qiluOqPWrLS3KoF/6KxP
8vcIrwz8zEEzNyH0VMCR5SbtFiG+9KC8qbW11wDgZhhSTHWxL6ViLUTg33Yidz8P
Z4FvexK+ACH09lsdCp1HIRvARQNp34K8SPDN/epzPLkrPHsw2qAoGKJLZgnLiCDm
9QIDAQAB
-----END PUBLIC KEY-----`;

describe('port proxy token injection', () => {
  describe('signTerminalToken for port-proxy subject', () => {
    it('generates a valid JWT with workspace claim for port-proxy user', async () => {
      const { signTerminalToken } = await import('../../src/services/jwt');

      const workspaceId = 'test-workspace-001';
      const env = {
        JWT_PRIVATE_KEY: TEST_PRIVATE_KEY,
        JWT_PUBLIC_KEY: TEST_PUBLIC_KEY,
        BASE_DOMAIN: 'test.example.com',
      } as any;

      const { token, expiresAt } = await signTerminalToken('port-proxy', workspaceId, env);

      expect(token).toBeTruthy();
      expect(expiresAt).toBeTruthy();

      // Verify the token is valid and has the correct claims
      const publicKey = await importSPKI(TEST_PUBLIC_KEY, 'RS256');
      const { payload } = await jwtVerify(token, publicKey, {
        issuer: 'https://api.test.example.com',
        audience: 'workspace-terminal',
      });

      expect(payload.sub).toBe('port-proxy');
      expect(payload.workspace).toBe(workspaceId);
    });

    it('generates a token that the VM agent would accept for the workspace', async () => {
      const { signTerminalToken } = await import('../../src/services/jwt');

      const workspaceId = 'ws-with-port-proxy';
      const env = {
        JWT_PRIVATE_KEY: TEST_PRIVATE_KEY,
        JWT_PUBLIC_KEY: TEST_PUBLIC_KEY,
        BASE_DOMAIN: 'test.example.com',
      } as any;

      const { token } = await signTerminalToken('port-proxy', workspaceId, env);

      // Verify workspace claim matches — this is what ValidateWorkspaceToken checks
      const publicKey = await importSPKI(TEST_PUBLIC_KEY, 'RS256');
      const { payload } = await jwtVerify(token, publicKey, {
        issuer: 'https://api.test.example.com',
        audience: 'workspace-terminal',
      });

      expect(payload.workspace).toBe(workspaceId);
      // Token should expire in the future
      expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });
  });

  describe('worker proxy source contract', () => {
    const file = readFileSync(resolve(process.cwd(), 'src/index.ts'), 'utf8');

    it('injects JWT token for port-forwarded requests', () => {
      expect(file).toContain("signTerminalToken('port-proxy', workspaceId, c.env)");
      expect(file).toContain("vmUrl.searchParams.set('token', token)");
    });

    it('only injects token for port proxy requests, not regular workspace requests', () => {
      // The token injection should be inside the targetPort !== null block
      const portBlock = file.slice(
        file.indexOf('if (targetPort !== null)'),
        file.indexOf('// Strip client-supplied routing headers')
      );
      expect(portBlock).toContain('signTerminalToken');
      // The main proxy fetch should NOT have signTerminalToken outside the port block
      const afterStrip = file.slice(
        file.indexOf('// Strip client-supplied routing headers')
      );
      expect(afterStrip).not.toContain('signTerminalToken');
    });

    it('handles token generation errors gracefully', () => {
      expect(file).toContain('TOKEN_ERROR');
      expect(file).toContain('port_proxy_token_error');
    });
  });
});
