import type { AgentProfileRuntime, TaskMode } from '@simple-agent-manager/shared';
import { isAgentProfileRuntime } from '@simple-agent-manager/shared';
import { type drizzle } from 'drizzle-orm/d1';

import type * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { launchInstantSession } from '../../services/instant-session';
import type { AgentSessionOverrides } from '../../services/node-agent';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export interface DispatchExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

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

export function launchDispatchedInstantSession(
  db: Db,
  env: Env,
  input: LaunchDispatchedInstantInput,
  execCtx?: DispatchExecutionContext
): Promise<void> {
  const launch = launchInstantSession(db, env, {
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
  }).then(() => undefined);

  if (!execCtx) return launch;

  execCtx.waitUntil(
    launch.catch((err) => {
      log.error('mcp.dispatch_task.instant_launch_failed', {
        taskId: input.taskId,
        projectId: input.project.id,
        error: err instanceof Error ? err.message : String(err),
      });
    })
  );
  return Promise.resolve();
}
