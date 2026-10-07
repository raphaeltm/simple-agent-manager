import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { buildSessionMcpServers } from './mcp-connection-resolution';
import { generateMcpToken, revokeMcpToken, storeMcpToken } from './mcp-token';
import type { SessionRuntimeContract } from './session-runtime-contract';

/** Credentials are refreshed at wake, never retained in the saved runtime contract. */
export async function prepareSessionRestoreMcp(
  env: Env,
  input: {
    userId: string;
    projectId: string;
    workspaceId: string;
    chatSessionId: string;
    agentSessionId: string;
    runtimeContract: SessionRuntimeContract | null;
  }
) {
  const contract = input.runtimeContract;
  if (contract?.taskContext && contract.taskContext.projectId !== input.projectId) {
    throw new Error('Session runtime contract project mismatch');
  }
  const token = generateMcpToken();
  const revoke = () => revokeMcpToken(env.KV, token);
  try {
    await storeMcpToken(
      env.KV,
      token,
      {
        taskId: contract?.taskContext?.taskId ?? '',
        contextType: contract?.promptKind ?? 'conversation',
        taskMode: contract?.taskContext?.taskMode ?? 'conversation',
        projectId: input.projectId,
        userId: input.userId,
        workspaceId: input.workspaceId,
        chatSessionId: input.chatSessionId,
        agentSessionId: input.agentSessionId,
        createdAt: new Date().toISOString(),
      },
      env
    );
    const mcpServers = await buildSessionMcpServers(
      drizzle(env.DATABASE, { schema }),
      { baseDomain: env.BASE_DOMAIN, encryptionKey: getCredentialEncryptionKey(env) },
      { userId: input.userId, projectId: input.projectId },
      token
    );
    return { mcpServers, revoke };
  } catch (error) {
    await revoke().catch(() => undefined);
    throw error;
  }
}
