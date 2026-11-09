/**
 * Move an agent session's SAM MCP token to its workspace's current runtime.
 *
 * A VM restart or rebuild rotates the workspace's credential generation, which revokes
 * every MCP token issued to the previous runtime (`mcp-token-lifecycle.ts`). The VM agent
 * keeps each agent session's MCP server list across a restart, so after installing the new
 * runtime's callback token it exchanges each persisted SAM MCP token here.
 *
 * Two proofs are required: the current-generation workspace callback token (which only the
 * new runtime holds) and the retired MCP token. A copy of the old MCP token alone cannot be
 * exchanged, and the exchange revokes it. The replacement keeps the old token's context and
 * `createdAt`, so it carries the same tool permissions and the same hard lifetime.
 */
import type { Env } from '../env';
import { log } from '../lib/logger';
import { errors } from '../middleware/error';
import {
  assertWorkspaceCallbackIdentityCurrent,
  assertWorkspaceCallbackResourceById,
} from '../routes/workspaces/_helpers';
import { verifyCallbackToken } from './jwt';
import { generateMcpToken, revokeMcpToken, storeMcpToken, validateMcpToken } from './mcp-token';

export async function rotateWorkspaceMcpToken(
  env: Env,
  input: { workspaceId: string; workspaceToken: string; mcpToken: string }
): Promise<{ token: string }> {
  const { workspaceId } = input;
  const payload = await verifyCallbackToken(input.workspaceToken, env, {
    expectedScope: 'workspace',
  });
  if (payload.scope !== 'workspace' || payload.workspace !== workspaceId) {
    throw errors.forbidden('Callback token does not match workspace');
  }
  const workspace = await assertWorkspaceCallbackResourceById(
    env,
    workspaceId,
    'mcp_token_rotation'
  );
  // The verifier compared against an earlier read; a runtime replaced since then must not
  // receive a token for the newer generation.
  if (workspace.callbackGeneration !== payload.callbackGeneration) {
    throw errors.gone('Workspace callback identity changed; callback resource is gone');
  }

  const data = await validateMcpToken(env.KV, input.mcpToken, env);
  if (!data) throw errors.notFound('MCP token');
  if (
    data.workspaceId !== workspaceId ||
    data.userId !== workspace.userId ||
    data.projectId !== workspace.projectId
  ) {
    log.warn('mcp_token.rotation_rejected', {
      workspaceId,
      tokenWorkspaceId: data.workspaceId || null,
      tokenProjectId: data.projectId,
      workspaceProjectId: workspace.projectId,
      reason: 'identity_mismatch',
      action: 'rejected',
    });
    throw errors.forbidden('MCP token does not belong to this workspace');
  }
  if ((data.callbackGeneration ?? null) === workspace.callbackGeneration) {
    return { token: input.mcpToken };
  }

  const token = generateMcpToken();
  await storeMcpToken(
    env.KV,
    token,
    { ...data, callbackGeneration: workspace.callbackGeneration, lastRefreshedAt: undefined },
    env
  );
  try {
    // Rule 49: a deletion or another replacement that won meanwhile suppresses the token.
    await assertWorkspaceCallbackIdentityCurrent(env, workspace, 'mcp_token_rotation');
  } catch (err) {
    await revokeMcpToken(env.KV, token).catch(() => {});
    throw err;
  }
  await revokeMcpToken(env.KV, input.mcpToken);
  log.info('mcp_token.rotated', {
    workspaceId,
    projectId: data.projectId,
    agentSessionId: data.agentSessionId ?? null,
    fromGeneration: data.callbackGeneration ?? null,
    toGeneration: workspace.callbackGeneration,
  });
  return { token };
}
