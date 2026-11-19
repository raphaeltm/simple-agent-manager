/** Fresh Instant continuation after bounded snapshot failure; backups stay retained. */
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { buildSamBootstrapInstructions } from './agent-bootstrap-prompt';
import type { SessionRuntimeContract } from './session-runtime-contract';
import { sleptFallbackRecord } from './session-sleep-episode';
import { sessionRecoveryInitialPrompt } from './session-sleep-fallback-messages';

export async function instantTranscriptFallbackStart(
  env: Env,
  input: {
    workspaceId: string;
    nodeId: string;
    projectId: string;
    userId: string;
    chatSessionId: string;
    agentSessionId: string;
    startedAt: number;
    contract: SessionRuntimeContract | null;
    mcpServers: unknown;
  }
): Promise<Record<string, unknown> | null> {
  const snapshot = await drizzle(env.DATABASE, { schema })
    .select()
    .from(schema.sessionSnapshots)
    .where(
      and(
        eq(schema.sessionSnapshots.workspaceId, input.workspaceId),
        eq(schema.sessionSnapshots.nodeId, input.nodeId),
        eq(schema.sessionSnapshots.projectId, input.projectId),
        eq(schema.sessionSnapshots.userId, input.userId),
        eq(schema.sessionSnapshots.chatSessionId, input.chatSessionId),
        eq(schema.sessionSnapshots.agentSessionId, input.agentSessionId),
        eq(schema.sessionSnapshots.runtime, 'cf-container'),
        eq(schema.sessionSnapshots.sleepStatus, 'sleeping')
      )
    )
    .get();
  const record = snapshot ? sleptFallbackRecord(snapshot) : null;
  if (
    !record ||
    record.recoveryPoint ||
    !snapshot?.sleepingAt ||
    !Number.isFinite(Date.parse(snapshot.expiresAt)) ||
    Date.parse(snapshot.expiresAt) <= Date.now()
  )
    return null;
  const contract = input.contract;
  if (!contract) throw new Error('Transcript continuation runtime contract unavailable');
  return {
    ...contract,
    ...contract.taskContext,
    protocolVersion: 1,
    deliveryId: `sleep-fallback-${input.agentSessionId}-${input.startedAt}`,
    initialPrompt: sessionRecoveryInitialPrompt(record),
    injectedInstructions: buildSamBootstrapInstructions({
      contextType: contract.taskContext ? 'task' : 'conversation',
    }),
    mcpServers: input.mcpServers,
  };
}
