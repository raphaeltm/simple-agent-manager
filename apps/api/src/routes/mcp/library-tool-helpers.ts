/**
 * Helpers shared by the library MCP tool handlers (`library-tools.ts`, `library-replace-tool.ts`).
 */
import type { Env } from '../../env';
import { INVALID_PARAMS, jsonRpcError, type JsonRpcResponse, type McpTokenData } from './_helpers';

export function getEncryptionKey(env: Env): string {
  const key = env.LIBRARY_ENCRYPTION_KEY ?? env.ENCRYPTION_KEY;
  if (!key) {
    throw new Error('Encryption key not configured');
  }
  return key;
}

export function requireWorkspaceId(
  requestId: string | number | null,
  tokenData: McpTokenData
): JsonRpcResponse | null {
  if (!tokenData.workspaceId) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'No active workspace — this tool requires a workspace context'
    );
  }
  return null;
}
