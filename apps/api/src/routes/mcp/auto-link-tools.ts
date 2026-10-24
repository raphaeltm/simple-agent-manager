import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { expectJsonRecord } from '../../lib/runtime-validation';
import { recordAutoLink } from '../../operations/link-core';
import { type JsonRpcResponse, type McpTokenData, resolveSessionId } from './_helpers';

const RELATIONS = {
  create_idea: ['idea', 'created'],
  update_idea: ['idea', 'edited'],
  get_idea: ['idea', 'read'],
  upload_to_library: ['file', 'uploaded'],
  replace_library_file: ['file', 'replaced'],
  download_library_file: ['file', 'viewed'],
  display_from_library: ['file', 'viewed'],
} as const;
export function isAutoLinkTool(name: string): boolean {
  return name in RELATIONS;
}

/** Schedule after a successful real tool result, never on searches or failed calls. */
export function scheduleToolAutoLink(
  name: string,
  response: JsonRpcResponse,
  args: Record<string, unknown>,
  token: McpTokenData,
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void } | null
): void {
  const target = RELATIONS[name as keyof typeof RELATIONS];
  if (!target || response.error || !ctx) return;
  const result = response.result as
    { content?: Array<{ type?: string; text?: string }> } | undefined;
  let output: Record<string, unknown> = {};
  try {
    const content = result?.content?.find((c) => c.type === 'text')?.text;
    if (content) output = expectJsonRecord(JSON.parse(content) as unknown, 'auto link tool output');
  } catch {
    /* A successful tool may return prose. Inputs still identify existing resources. */
  }
  if (output['error']) return;
  const id =
    target[0] === 'idea'
      ? name === 'create_idea'
        ? output['ideaId']
        : args['ideaId']
      : name === 'upload_to_library'
        ? output['fileId']
        : args['fileId'];
  if (typeof id !== 'string' || !id) return;
  ctx.waitUntil(
    (async () => {
      try {
        const sessionId = await resolveSessionId(env, token.workspaceId);
        if (!sessionId) return;
        await recordAutoLink(env, token.projectId, {
          sourceKind: 'session',
          sourceId: sessionId,
          targetKind: target[0],
          targetId: id,
          relation: target[1],
          origin: 'auto',
          context: null,
          actorKind: 'agent',
          actorId: token.agentSessionId ?? token.taskId ?? null,
        });
      } catch (error) {
        log.warn('resource_links.auto_failed', {
          projectId: token.projectId,
          workspaceId: token.workspaceId,
          tool: name,
          error: String(error),
        });
      }
    })()
  );
}
