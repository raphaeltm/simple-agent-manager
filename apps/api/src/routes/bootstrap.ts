/**
 * Bootstrap Token Redemption Routes
 *
 * Endpoint for VMs to redeem one-time bootstrap tokens and receive credentials.
 * No authentication required - the token itself is the auth mechanism.
 */

import { Hono } from 'hono';
import type { Env } from '../index';
import type { BootstrapResponse } from '@simple-agent-manager/shared';
import { redeemBootstrapToken } from '../services/bootstrap';
import { decrypt } from '../services/encryption';

export const bootstrapRoutes = new Hono<{ Bindings: Env }>();

/**
 * POST /api/bootstrap/:token
 *
 * Redeem a bootstrap token and receive decrypted credentials.
 * Token is single-use and auto-expires after 5 minutes.
 *
 * @returns BootstrapResponse with decrypted credentials
 * @returns 401 if token is invalid or expired
 */
bootstrapRoutes.post('/:token', async (c) => {
  const token = c.req.param('token');

  // Attempt to redeem token (get + delete)
  const tokenData = await redeemBootstrapToken(c.env.KV, token);

  if (!tokenData) {
    return c.json(
      {
        error: 'INVALID_TOKEN',
        message: 'Bootstrap token is invalid or has expired',
      },
      401
    );
  }

  // Decrypt the Hetzner token
  const hetznerToken = await decrypt(
    tokenData.encryptedHetznerToken,
    tokenData.hetznerTokenIv,
    c.env.ENCRYPTION_KEY
  );

  // Decrypt GitHub token if present
  let githubToken: string | null = null;
  if (tokenData.encryptedGithubToken && tokenData.githubTokenIv) {
    githubToken = await decrypt(
      tokenData.encryptedGithubToken,
      tokenData.githubTokenIv,
      c.env.ENCRYPTION_KEY
    );
  }

  const response: BootstrapResponse = {
    workspaceId: tokenData.workspaceId,
    hetznerToken,
    callbackToken: tokenData.callbackToken,
    githubToken,
    controlPlaneUrl: `https://api.${c.env.BASE_DOMAIN}`,
  };

  return c.json(response);
});
