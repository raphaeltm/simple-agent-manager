import { eq } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { ulid } from '../lib/ulid';
import { buildAgentStartPromptPayload } from './agent-bootstrap-prompt';
import {
  generateMcpToken,
  type McpInstructionContextType,
  type McpTaskMode,
  revokeMcpToken,
  storeMcpToken,
} from './mcp-token';
import {
  type AgentSessionOverrides,
  createAgentSessionOnNode,
  startAgentSessionOnNode,
} from './node-agent';
import * as projectDataService from './project-data';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export interface SamAwareAgentStartInput {
  nodeId: string;
  workspaceId: string;
  projectId: string;
  userId: string;
  chatSessionId?: string | null;
  agentSessionId?: string | null;
  label: string | null;
  agentType: string;
  visibleInitialPrompt: string;
  promptKind: McpInstructionContextType;
  taskContext?: {
    taskId: string;
    taskMode: McpTaskMode;
    outputBranch?: string | null;
  } | null;
  overrides?: AgentSessionOverrides;
  existingMcpToken?: string | null;
  actor: {
    type: 'system' | 'user';
    id: string | null;
    reasonPrefix: string;
  };
  runPhase?: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
}

export interface SamAwareAgentStartResult {
  agentSessionId: string;
  acpSessionId: string | null;
  mcpToken: string;
  agentStarted: boolean;
}

async function runMaybePhased<T>(
  input: SamAwareAgentStartInput,
  name: string,
  fn: () => Promise<T>
): Promise<T> {
  return input.runPhase ? input.runPhase(name, fn) : fn();
}

async function ensureAgentSessionRow(
  db: Db,
  input: SamAwareAgentStartInput,
  agentSessionId: string
): Promise<void> {
  const existing = await db
    .select({ id: schema.agentSessions.id })
    .from(schema.agentSessions)
    .where(eq(schema.agentSessions.id, agentSessionId))
    .limit(1);

  if (existing[0]) return;

  const now = new Date().toISOString();
  await db.insert(schema.agentSessions).values({
    id: agentSessionId,
    workspaceId: input.workspaceId,
    userId: input.userId,
    status: 'running',
    label: input.label,
    agentType: input.agentType,
    createdAt: now,
    updatedAt: now,
  });
}

export async function startSamAwareAgentSession(
  db: Db,
  env: Env,
  input: SamAwareAgentStartInput
): Promise<SamAwareAgentStartResult> {
  const agentSessionId = input.agentSessionId || ulid();
  const generatedMcpToken = !input.existingMcpToken;
  const mcpToken = input.existingMcpToken || generateMcpToken();

  try {
    await runMaybePhased(input, 'create_agent_session_row', () =>
      ensureAgentSessionRow(db, input, agentSessionId)
    );

    if (generatedMcpToken) {
      await runMaybePhased(input, 'store_mcp_token', () =>
        storeMcpToken(
          env.KV,
          mcpToken,
          {
            taskId: input.taskContext?.taskId ?? '',
            contextType: input.promptKind,
            taskMode: input.taskContext?.taskMode ?? (input.promptKind === 'conversation' ? 'conversation' : undefined),
            projectId: input.projectId,
            userId: input.userId,
            workspaceId: input.workspaceId,
            chatSessionId: input.chatSessionId ?? undefined,
            agentSessionId,
            createdAt: new Date().toISOString(),
          },
          env
        )
      );
    }

    await runMaybePhased(input, 'create_vm_agent_session', () =>
      createAgentSessionOnNode(
        input.nodeId,
        input.workspaceId,
        agentSessionId,
        input.label,
        env,
        input.userId,
        input.chatSessionId ?? undefined,
        input.projectId,
        {
          url: `https://api.${env.BASE_DOMAIN}/mcp`,
          token: mcpToken,
        }
      )
    )

    let acpSessionId: string | null = null;
    try {
      acpSessionId = await runMaybePhased(input, 'create_acp_session', () =>
        ensureAcpSessionWithEnv(env, input, agentSessionId)
      );
    } catch (err) {
      log.error('agent_session_bootstrap.acp_session_create_failed', {
        projectId: input.projectId,
        chatSessionId: input.chatSessionId,
        agentSessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const initialPrompt = buildAgentStartPromptPayload({
      message: input.visibleInitialPrompt,
      contextType: input.promptKind,
    });

    await runMaybePhased(input, 'start_acp_session', () =>
      startAgentSessionOnNode(
        input.nodeId,
        input.workspaceId,
        agentSessionId,
        input.agentType,
        initialPrompt,
        env,
        input.userId,
        {
          url: `https://api.${env.BASE_DOMAIN}/mcp`,
          token: mcpToken,
        },
        input.overrides,
        input.taskContext
          ? {
              projectId: input.projectId,
              taskId: input.taskContext.taskId,
              taskMode: input.taskContext.taskMode,
            }
          : undefined
      )
    );

    const runningAcpSessionId = acpSessionId;
    if (runningAcpSessionId) {
      await runMaybePhased(input, 'mark_acp_session_running', () =>
        projectDataService.transitionAcpSession(env, input.projectId, runningAcpSessionId, 'running', {
          actorType: input.actor.type,
          actorId: input.actor.id,
          reason: `${input.actor.reasonPrefix} started`,
          acpSdkSessionId: agentSessionId,
        })
      );
    }

    return {
      agentSessionId,
      acpSessionId,
      mcpToken,
      agentStarted: true,
    };
  } catch (err) {
    if (generatedMcpToken) {
      await revokeMcpToken(env.KV, mcpToken).catch(() => {});
    }
    await db
      .update(schema.agentSessions)
      .set({
        status: 'error',
        errorMessage: err instanceof Error ? err.message : 'Failed to start agent session',
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.agentSessions.id, agentSessionId))
      .catch(() => {});
    throw err;
  }
}

async function ensureAcpSessionWithEnv(
  env: Env,
  input: SamAwareAgentStartInput,
  agentSessionId: string
): Promise<string | null> {
  if (!input.chatSessionId) return null;

  const existing = await projectDataService.getAcpSession(env, input.projectId, agentSessionId).catch(() => null);
  if (existing?.id) return existing.id;

  const acpSession = await projectDataService.createAcpSession(
    env,
    input.projectId,
    input.chatSessionId,
    null,
    input.agentType,
    null,
    0,
    agentSessionId
  );

  await projectDataService.transitionAcpSession(env, input.projectId, acpSession.id, 'assigned', {
    actorType: input.actor.type,
    actorId: input.actor.id,
    reason: `${input.actor.reasonPrefix} assigned`,
    workspaceId: input.workspaceId,
    nodeId: input.nodeId,
  });

  return acpSession.id;
}
