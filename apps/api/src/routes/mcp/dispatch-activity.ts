import type { TaskMode } from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import type { McpTokenData } from './_helpers';

export async function recordDispatchActivityEvent(input: {
  env: Env;
  tokenData: McpTokenData;
  taskId: string;
  newDepth: number;
  taskTitle: string;
  branchName: string;
  executionRuntime: string;
  runtimeReason: string;
  agentProfileId?: string;
  skillId?: string;
  taskMode: TaskMode;
}): Promise<void> {
  try {
    const doId = input.env.PROJECT_DATA.idFromName(input.tokenData.projectId);
    const doStub = input.env.PROJECT_DATA.get(doId);
    await doStub.fetch(
      new Request('https://do/activity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'task.dispatched',
          actorType: 'agent',
          actorId: input.tokenData.workspaceId,
          metadata: {
            taskId: input.taskId,
            parentTaskId: input.tokenData.taskId,
            dispatchDepth: input.newDepth,
            title: input.taskTitle,
            branchName: input.branchName,
            runtime: input.executionRuntime,
            runtimeReason: input.runtimeReason,
            agentProfileId: input.agentProfileId,
            skillId: input.skillId,
            taskMode: input.taskMode,
          },
        }),
      })
    );
  } catch (err) {
    log.warn('mcp.dispatch_task.activity_event_failed', {
      taskId: input.taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
