import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { Context } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import type { AcpActivityCallbackReport } from './acp-activity-admission';
import { hibernateAgentSessionOnNode } from './node-agent';
import type * as projectDataService from './project-data';
import { markVmAgentContainerActiveWorkEndedBestEffort } from './vm-agent-container';

type ExistingAcpSession = NonNullable<Awaited<ReturnType<typeof projectDataService.getAcpSession>>>;

export async function markTerminalContainerWorkEnded(input: {
  c: Context<{ Bindings: Env }>;
  projectId: string;
  sessionId: string;
  body: AcpActivityCallbackReport;
  existing: ExistingAcpSession;
  beforeSideEffect: () => Promise<void>;
  harnessWorkKeepsRuntimeActive: boolean;
}): Promise<void> {
  const shouldEndContainerWork =
    (input.body.activity === 'idle' && !input.harnessWorkKeepsRuntimeActive) ||
    input.body.activity === 'error';
  if (!shouldEndContainerWork) return;

  let idleSnapshotQueued = false;
  if (
    input.body.activity === 'idle' &&
    input.existing.workspaceId &&
    input.existing.nodeId &&
    input.existing.acpSdkSessionId
  ) {
    const db = drizzle(input.c.env.DATABASE, { schema });
    const workspace = await db
      .select({
        id: schema.workspaces.id,
        userId: schema.workspaces.userId,
        chatSessionId: schema.workspaces.chatSessionId,
        runtime: schema.nodes.runtime,
        sleepingAt: schema.sessionSnapshots.sleepingAt,
        sleepStatus: schema.sessionSnapshots.sleepStatus,
      })
      .from(schema.workspaces)
      .leftJoin(schema.nodes, eq(schema.nodes.id, schema.workspaces.nodeId))
      .leftJoin(
        schema.sessionSnapshots,
        eq(schema.sessionSnapshots.chatSessionId, schema.workspaces.chatSessionId)
      )
      .where(eq(schema.workspaces.id, input.existing.workspaceId))
      .get();
    if (
      workspace?.runtime &&
      workspace.chatSessionId &&
      !workspace.sleepingAt &&
      workspace.sleepStatus !== 'stopping' &&
      workspace.sleepStatus !== 'sleeping'
    ) {
      await input.beforeSideEffect();
      await hibernateAgentSessionOnNode(
        input.existing.nodeId,
        input.existing.workspaceId,
        input.existing.acpSdkSessionId,
        input.c.env,
        workspace.userId,
        {
          chatSessionId: workspace.chatSessionId,
          runtime: workspace.runtime,
          agentType: input.body.agentType ?? input.existing.agentType ?? undefined,
          background: true,
        }
      )
        .then(() => {
          idleSnapshotQueued = true;
        })
        .catch((err) => {
          log.warn('acp_activity.session_snapshot_failed', {
            projectId: input.projectId,
            sessionId: input.sessionId,
            workspaceId: input.existing.workspaceId,
            nodeId: input.existing.nodeId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }
  }
  if (!idleSnapshotQueued) {
    await input.beforeSideEffect();
    await markVmAgentContainerActiveWorkEndedBestEffort(
      input.c.env,
      input.existing.nodeId,
      `agent_activity_${input.body.activity}`
    );
  }
}
