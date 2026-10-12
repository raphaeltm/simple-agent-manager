import type { TaskMode } from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { recomputeMissionSchedulerStates } from '../../services/scheduler-state-sync';
import type { McpTokenData } from './_helpers';
import { recordMcpActivityEvent } from './activity-events';

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
  await recordMcpActivityEvent(input.env, input.tokenData, {
    eventType: 'task.dispatched',
    taskId: input.taskId,
    payload: {
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
    failureLogEvent: 'mcp.dispatch_task.activity_event_failed',
  });
}

/** Mission recomputation remains best effort after dispatch activity publication. */
export async function recomputeDispatchMissionSchedulerState(
  env: Env,
  resolvedMissionId: string,
  taskId: string
): Promise<void> {
  try {
    await recomputeMissionSchedulerStates(env.DATABASE, resolvedMissionId);
  } catch (err) {
    log.warn('mcp.dispatch_task.scheduler_state_recompute_failed', {
      taskId,
      missionId: resolvedMissionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
