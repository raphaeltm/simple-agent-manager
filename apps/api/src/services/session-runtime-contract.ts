import {
  AcpInteractionRuntimeConfigSchema,
  AGENT_EFFORT_LEVELS,
  DEFAULT_AGENT_PERMISSION_MODE,
} from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';
import * as v from 'valibot';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { buildAcpInteractionRuntimeConfig } from './acp-interaction-runtime-config';
import type { AgentSessionOverrides } from './node-agent';
import { resolveProjectAgentDefault } from './project-agent-defaults';

type Db = ReturnType<typeof drizzle<typeof schema>>;
const nullableSetting = v.nullable(v.string());
export const SessionRuntimeContractSchema = v.object({
  version: v.literal(1),
  agentType: v.string(),
  model: nullableSetting,
  effort: v.nullable(v.picklist(AGENT_EFFORT_LEVELS)),
  permissionMode: v.picklist(['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions']),
  opencodeProvider: nullableSetting,
  opencodeBaseUrl: nullableSetting,
  settingsResolved: v.literal(true),
  acpInteractions: AcpInteractionRuntimeConfigSchema,
  promptKind: v.picklist(['task', 'conversation', 'trial', 'direct-workspace']),
  taskContext: v.nullable(
    v.object({
      projectId: v.string(),
      taskId: v.string(),
      taskMode: v.picklist(['task', 'conversation']),
    })
  ),
});
export type SessionRuntimeContract = v.InferOutput<typeof SessionRuntimeContractSchema>;

/** NULL means a pre-contract session. Malformed/newer records must never downgrade permissions. */
export function parseSessionRuntimeContract(
  json: string | null | undefined
): SessionRuntimeContract | null {
  if (json == null) return null;
  return v.parse(SessionRuntimeContractSchema, JSON.parse(json));
}

export async function resolveSessionRuntimeContract(
  db: Db,
  env: Env,
  input: {
    userId: string;
    projectId: string;
    agentType: string;
    overrides?: AgentSessionOverrides;
    promptKind: 'task' | 'conversation' | 'trial' | 'direct-workspace';
    taskContext?: { taskId: string; taskMode: 'task' | 'conversation' } | null;
  }
): Promise<SessionRuntimeContract> {
  const [project, user] = await Promise.all([
    db
      .select({ agentDefaults: schema.projects.agentDefaults })
      .from(schema.projects)
      .where(eq(schema.projects.id, input.projectId))
      .get(),
    db
      .select()
      .from(schema.agentSettings)
      .where(
        and(
          eq(schema.agentSettings.userId, input.userId),
          eq(schema.agentSettings.agentType, input.agentType)
        )
      )
      .get(),
  ]);
  const defaults = resolveProjectAgentDefault(project?.agentDefaults ?? null, input.agentType);
  return v.parse(SessionRuntimeContractSchema, {
    version: 1,
    agentType: input.agentType,
    settingsResolved: true,
    model: input.overrides?.model ?? defaults.model ?? user?.model ?? null,
    effort: input.overrides?.effort ?? null,
    permissionMode:
      input.overrides?.permissionMode ??
      defaults.permissionMode ??
      user?.permissionMode ??
      DEFAULT_AGENT_PERMISSION_MODE,
    opencodeProvider: input.overrides?.opencodeProvider ?? user?.opencodeProvider ?? null,
    opencodeBaseUrl: input.overrides?.opencodeBaseUrl ?? user?.opencodeBaseUrl ?? null,
    promptKind: input.promptKind,
    taskContext: input.taskContext ? { ...input.taskContext, projectId: input.projectId } : null,
    acpInteractions: buildAcpInteractionRuntimeConfig(
      env,
      input.taskContext?.taskMode ?? input.promptKind
    ),
  });
}

export async function loadSnapshotRuntimeContract(
  db: Db,
  projectId: string,
  userId: string,
  chatSessionId: string
) {
  const row = await db
    .select({ runtimeContractJson: schema.sessionSnapshots.runtimeContractJson })
    .from(schema.sessionSnapshots)
    .where(
      and(
        eq(schema.sessionSnapshots.chatSessionId, chatSessionId),
        eq(schema.sessionSnapshots.projectId, projectId),
        eq(schema.sessionSnapshots.userId, userId)
      )
    )
    .get();
  const contract = parseSessionRuntimeContract(row?.runtimeContractJson);
  if (contract?.taskContext && contract.taskContext.projectId !== projectId)
    throw new Error('Session runtime contract project mismatch');
  return contract;
}

/** Optional advertisement is required before restore: old hosts ignore unknown request fields. */
export function assertSessionRuntimeContractCapability(capabilities: unknown): void {
  v.parse(
    v.object({
      sessionRuntimeContract: v.object({ supported: v.literal(true), version: v.literal(1) }),
    }),
    capabilities
  );
}
