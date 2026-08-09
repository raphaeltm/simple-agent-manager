import type { drizzle } from 'drizzle-orm/d1';

import type * as schema from '../db/schema';
import type { Env } from '../env';
import { enrichMessageWithMentions } from '../services/mention-enrichment';
import { getCfContainerWakeTimeoutMs, sendPromptToAgentOnNode } from '../services/node-agent';
import { resolveLiveAgentSessionForChat } from './chat-workspace-resolver';

type ChatDb = ReturnType<typeof drizzle<typeof schema>>;

export interface PreparedLiveAgentPrompt {
  nodeId: string;
  workspaceId: string;
  agentSessionId: string;
  userId: string;
  enrichedMessage: string;
  requestTimeoutMs?: number;
}

/** Resolve all fallible prerequisites before a mutating prompt is dispatched. */
export async function preparePromptForLiveAgent(
  env: Env,
  db: ChatDb,
  input: {
    projectId: string;
    sessionId: string;
    userId: string;
    content: string;
    enrichedMessage?: string;
  }
): Promise<PreparedLiveAgentPrompt> {
  const { projectId, sessionId, userId, content } = input;
  const { workspace, agentSession } = await resolveLiveAgentSessionForChat(db, {
    projectId,
    sessionId,
    userId,
  });
  const enrichedMessage =
    input.enrichedMessage ??
    (await enrichMessageWithMentions(content, db, projectId, userId, env)).enrichedMessage;
  return {
    nodeId: workspace.nodeId,
    workspaceId: workspace.id,
    agentSessionId: agentSession.id,
    userId,
    enrichedMessage,
    requestTimeoutMs:
      workspace.nodeRuntime === 'cf-container' && workspace.nodeStatus !== 'running'
        ? getCfContainerWakeTimeoutMs(env)
        : undefined,
  };
}

/** Dispatch a prepared prompt. Any thrown error has an ambiguous delivery outcome. */
export function sendPreparedPromptToLiveAgent(
  env: Env,
  prepared: PreparedLiveAgentPrompt,
  messageId?: string
): Promise<unknown> {
  return sendPromptToAgentOnNode(
    prepared.nodeId,
    prepared.workspaceId,
    prepared.agentSessionId,
    prepared.enrichedMessage,
    env,
    prepared.userId,
    messageId,
    prepared.requestTimeoutMs === undefined
      ? undefined
      : { requestTimeoutMs: prepared.requestTimeoutMs }
  );
}

/** Forward a user-authored message to the live agent behind a chat session. */
export async function forwardPromptToLiveAgent(
  env: Env,
  db: ChatDb,
  input: {
    projectId: string;
    sessionId: string;
    userId: string;
    content: string;
    enrichedMessage?: string;
  }
): Promise<unknown> {
  const prepared = await preparePromptForLiveAgent(env, db, input);
  return sendPreparedPromptToLiveAgent(env, prepared);
}
