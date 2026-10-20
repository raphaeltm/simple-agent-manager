import type { Env } from '../env';
import { errors } from '../middleware/error';
import { nodeAgentRequest } from './node-agent';

/** Old runtimes fail closed on the new endpoint; no fallback to legacy cancel. */
export async function guardedChatInterrupt(
  env: Env,
  nodeId: string,
  workspaceId: string,
  agentSessionId: string,
  userId: string,
  expectedPromptStartedAt: number,
  beforeExternalMutation?: () => Promise<void>
) {
  let result: unknown;
  try {
    result = await nodeAgentRequest(
      nodeId,
      env,
      `/workspaces/${workspaceId}/agent-sessions/${agentSessionId}/cancel-guarded`,
      {
        method: 'POST',
        userId,
        workspaceId,
        beforeExternalMutation,
        noWakeContainer: true,
        recoverContainerOnTimeout: false,
        body: JSON.stringify({ expectedPromptStartedAt }),
      }
    );
  } catch (error) {
    const text = error instanceof Error ? error.message : '';
    if (/failed:\s*404/.test(text))
      throw errors.conflict(
        'Guarded interruption unsupported or runtime unavailable; no fallback was attempted'
      );
    if (/failed:\s*412/.test(text))
      throw errors.conflict('Prompt turn changed; no interruption was applied');
    throw errors.internal(
      'Guarded interruption outcome unconfirmed; inspect status and reuse the same requestKey'
    );
  }
  if (
    !result ||
    typeof result !== 'object' ||
    !('status' in result) ||
    !['cancelled', 'idle'].includes(String(result.status))
  )
    throw new Error('Unconfirmed guarded cancellation');
  return {
    success: result.status === 'cancelled',
    status: result.status === 'cancelled' ? 200 : 409,
  };
}
