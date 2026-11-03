/**
 * Operations-project debugger tool handlers. Every handler except `ops_get_access_status`
 * must start with `requireOperationsAccess` and record its call with `recordOperationsAudit`
 * (`services/operations-access.ts`). Tool results that echo node, log or user content are
 * untrusted data and must be marked as such.
 */
import type { Env } from '../../env';
import { getOperationsAccessStatus, recordOperationsAudit } from '../../services/operations-access';
import { type JsonRpcResponse, jsonRpcSuccess, type McpTokenData } from './_helpers';

export async function handleOpsGetAccessStatus(
  requestId: string | number | null,
  _params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  const status = await getOperationsAccessStatus(env, tokenData);
  if (status.operationsProject && tokenData.taskId) {
    await recordOperationsAudit(env, {
      actorUserId: tokenData.userId,
      taskId: tokenData.taskId,
      tool: 'ops_get_access_status',
      targetType: 'installation',
      outcome: status.capabilities.read ? 'allowed' : 'denied',
      detail: {
        mode: status.mode,
        read: status.capabilities.read,
        act: status.capabilities.act,
        denial: status.denials.read?.reason ?? status.denials.act?.reason ?? null,
      },
    });
  }
  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: JSON.stringify(status) }],
  });
}
