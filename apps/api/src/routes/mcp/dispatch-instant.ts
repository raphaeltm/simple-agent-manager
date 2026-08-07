import type { AgentProfileRuntime, TaskMode } from '@simple-agent-manager/shared';
import { isAgentProfileRuntime } from '@simple-agent-manager/shared';
import { type drizzle } from 'drizzle-orm/d1';

import type * as schema from '../../db/schema';
import type { TaskRunner } from '../../durable-objects/task-runner';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import {
  type AcceptedInstantSession,
  acceptInstantSession,
  type LaunchInstantSessionInput,
  markInstantLaunchFailed,
} from '../../services/instant-session';
import type { AgentSessionOverrides } from '../../services/node-agent';
import { markQueuedTaskFailed } from '../../services/task-failure';

type Db = ReturnType<typeof drizzle<typeof schema>>;

const VM_ONLY_FIELDS = [
  'vmSize',
  'provider',
  'vmLocation',
  'workspaceProfile',
  'devcontainerConfigName',
] as const;

export function parseDispatchRuntime(value: unknown): AgentProfileRuntime | undefined {
  return isAgentProfileRuntime(value) ? value : undefined;
}

export function getRuntimeValidationError(
  params: Record<string, unknown>,
  effectiveRuntime: AgentProfileRuntime | null
): string | null {
  if (effectiveRuntime !== 'cf-container') return null;

  const conflicts = VM_ONLY_FIELDS.filter((field) => params[field] !== undefined);
  if (conflicts.length === 0) return null;

  const fieldList = conflicts.join(', ');
  if (params.runtime === 'cf-container') {
    return `runtime "cf-container" cannot be combined with VM-only fields: ${fieldList}. Remove those fields or set runtime to "vm".`;
  }
  return `The selected skill/profile resolves to runtime "cf-container", which cannot be combined with explicit VM-only fields: ${fieldList}. Remove those fields or pass runtime: "vm" to force VM execution.`;
}

function appendSystemPrompt(prompt: string, systemPromptAppend: string | null | undefined): string {
  const suffix = systemPromptAppend?.trim();
  return suffix ? `${prompt}\n\n${suffix}` : prompt;
}

export interface LaunchDispatchedInstantInput {
  taskId: string;
  project: schema.Project;
  userId: string;
  fullDescription: string;
  agentType: string;
  agentProfileId?: string | null;
  skillId?: string | null;
  branch: string;
  taskMode: TaskMode;
  systemPromptAppend?: string | null;
  overrides?: AgentSessionOverrides;
}

export async function launchDispatchedInstantSession(
  db: Db,
  env: Env,
  input: LaunchDispatchedInstantInput
): Promise<void> {
  const launchInput: LaunchInstantSessionInput = {
    taskId: input.taskId,
    project: input.project,
    userId: input.userId,
    initialPrompt: appendSystemPrompt(input.fullDescription, input.systemPromptAppend),
    displayMessage: input.fullDescription,
    agentType: input.agentType,
    agentProfileId: input.agentProfileId ?? null,
    skillId: input.skillId ?? null,
    branch: input.branch,
    taskMode: input.taskMode,
    overrides: input.overrides,
  };

  // Phase 1: synchronous accept — persists the node record, workspace row,
  // chat session, and initial message. Failures here may predate any resource
  // creation, so only the queued task row is marked failed (the queued-status
  // guard makes this a no-op if a later path already marked it).
  let accepted: AcceptedInstantSession;
  try {
    accepted = await acceptInstantSession(db, env, launchInput);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log.error('mcp.dispatch_task.instant_launch_failed', {
      taskId: input.taskId,
      projectId: input.project.id,
      error: errorMsg,
    });
    try {
      await markQueuedTaskFailed(db, input.taskId, `Instant launch failed: ${errorMsg}`);
    } catch (persistErr) {
      log.error('mcp.dispatch_task.instant_failure_persist_failed', {
        taskId: input.taskId,
        error: persistErr instanceof Error ? persistErr.message : String(persistErr),
      });
    }
    throw err;
  }

  // Phase 2: durable handoff. The TaskRunner DO alarm runs the launch in a
  // job-owned context (rule 43) — the request-scoped waitUntil this replaces
  // was cancelled ~30s after the response, stranding slow launches in
  // `queued` with no error and no cleanup.
  try {
    const stub = env.TASK_RUNNER.get(
      env.TASK_RUNNER.idFromName(input.taskId)
    ) as unknown as TaskRunner;
    await stub.startInstantLaunch(launchInput, accepted);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log.error('mcp.dispatch_task.instant_handoff_failed', {
      taskId: input.taskId,
      projectId: input.project.id,
      error: errorMsg,
    });
    // Accept already created the node/workspace/session — tear it all down.
    await markInstantLaunchFailed(
      db,
      env,
      {
        taskId: input.taskId,
        projectId: accepted.projectId,
        chatSessionId: accepted.chatSessionId,
        workspaceId: accepted.workspaceId,
        nodeId: accepted.nodeId,
        containerId: accepted.containerId,
      },
      `Instant launch handoff failed: ${errorMsg}`
    );
    throw err;
  }
}
