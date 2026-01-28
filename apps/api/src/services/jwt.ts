import { SignJWT, importPKCS8, exportJWK, importSPKI } from 'jose';
import type { Env } from '../index';

const KEY_ID = 'key-2026-01';
const ISSUER = 'https://api.workspaces.example.com';
const AUDIENCE = 'workspace-terminal';

/**
 * Sign a terminal access token for a user and workspace.
 */
export async function signTerminalToken(
  userId: string,
  workspaceId: string,
  env: Env
): Promise<{ token: string; expiresAt: string }> {
  const privateKey = await importPKCS8(env.JWT_PRIVATE_KEY, 'RS256');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  const token = await new SignJWT({
    workspace: workspaceId,
  })
    .setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
    .setIssuer(ISSUER)
    .setSubject(userId)
    .setAudience(AUDIENCE)
    .setExpirationTime(expiresAt)
    .setIssuedAt()
    .sign(privateKey);

  return {
    token,
    expiresAt: expiresAt.toISOString(),
  };
}

/**
 * Sign a callback token for VM-to-API authentication.
 * Used by VM agent to call back to control plane (heartbeat, ready, etc.)
 */
export async function signCallbackToken(
  workspaceId: string,
  env: Env
): Promise<string> {
  const privateKey = await importPKCS8(env.JWT_PRIVATE_KEY, 'RS256');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

  const token = await new SignJWT({
    workspace: workspaceId,
    type: 'callback',
  })
    .setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
    .setIssuer(ISSUER)
    .setSubject(workspaceId)
    .setAudience('workspace-callback')
    .setExpirationTime(expiresAt)
    .setIssuedAt()
    .sign(privateKey);

  return token;
}

/**
 * Get the JWKS (JSON Web Key Set) for JWT validation.
 */
export async function getJWKS(env: Env) {
  const publicKey = await importSPKI(env.JWT_PUBLIC_KEY, 'RS256');
  const jwk = await exportJWK(publicKey);

  return {
    keys: [
      {
        ...jwk,
        kid: KEY_ID,
        use: 'sig',
        alg: 'RS256',
      },
    ],
  };
}
