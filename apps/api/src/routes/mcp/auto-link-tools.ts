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

function linkedResourceId(
  name: string,
  kind: 'idea' | 'file',
  output: Record<string, unknown>,
  args: Record<string, unknown>
): unknown {
  if (name === 'create_idea') return output['ideaId'];
  if (name === 'upload_to_library') return output['fileId'];
  return kind === 'idea' ? args['ideaId'] : args['fileId'];
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
  const id = linkedResourceId(name, target[0], output, args);
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
