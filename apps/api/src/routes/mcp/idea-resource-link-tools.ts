import type { Env } from '../../env';
import { AppError } from '../../middleware/error';
import { recordLink, removeLink } from '../../operations/link-core';
import {
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
  type McpTokenData,
  sanitizeUserInput,
} from './_helpers';

type McpRequestId = string | number | null;

async function handle(
  unlink: boolean,
  requestId: McpRequestId,
  params: Record<string, unknown>,
  token: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  const ideaId = typeof params.ideaId === 'string' ? params.ideaId.trim() : '';
  const kind = params.kind;
  const id = typeof params.id === 'string' ? params.id.trim() : '';
  if (!ideaId || (kind !== 'file' && kind !== 'pr' && kind !== 'idea') || !id)
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'ideaId, kind (file|pr|idea), and id are required'
    );
  const relation = kind === 'idea' ? 'related' : 'linked';
  try {
    if (unlink)
      await removeLink(env, token.projectId, {
        sourceKind: 'idea',
        sourceId: ideaId,
        targetKind: kind,
        targetId: id,
        relation,
      });
    else
      await recordLink(env, token.projectId, {
        sourceKind: 'idea',
        sourceId: ideaId,
        targetKind: kind,
        targetId: id,
        relation,
        origin: 'explicit',
        context: typeof params.note === 'string' ? sanitizeUserInput(params.note) : null,
        actorKind: 'agent',
        actorId: token.agentSessionId ?? token.taskId ?? null,
      });
    return jsonRpcSuccess(requestId, {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            linked: !unlink,
            ideaId,
            kind,
            id,
            relation,
          }),
        },
      ],
    });
  } catch (error) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      error instanceof AppError && error.statusCode < 500 ? error.message : 'Unable to update link'
    );
  }
}
export const handleLinkToIdea = (
  requestId: McpRequestId,
  params: Record<string, unknown>,
  token: McpTokenData,
  env: Env
) => handle(false, requestId, params, token, env);
export const handleUnlinkFromIdea = (
  requestId: McpRequestId,
  params: Record<string, unknown>,
  token: McpTokenData,
  env: Env
) => handle(true, requestId, params, token, env);
