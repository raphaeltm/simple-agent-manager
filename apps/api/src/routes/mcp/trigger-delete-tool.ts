import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { type JsonRpcResponse, jsonRpcSuccess, type McpTokenData } from './_helpers';
import { resolveOwnedTrigger } from './trigger-tool-shared';

export async function handleDeleteTrigger(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  const ownedTrigger = await resolveOwnedTrigger(requestId, params, tokenData, env, 'delete');
  if (!ownedTrigger.ok) return ownedTrigger.response;
  const { triggerId } = ownedTrigger;

  await env.DATABASE.prepare('DELETE FROM github_trigger_configs WHERE trigger_id = ?')
    .bind(triggerId)
    .run();
  await env.DATABASE.prepare('DELETE FROM trigger_executions WHERE trigger_id = ?')
    .bind(triggerId)
    .run();
  await env.DATABASE.prepare('DELETE FROM triggers WHERE id = ? AND project_id = ?')
    .bind(triggerId, tokenData.projectId)
    .run();

  log.info('mcp.delete_trigger', {
    triggerId,
    projectId: tokenData.projectId,
    userId: tokenData.userId,
  });

  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: JSON.stringify({ success: true, triggerId }) }],
  });
}
