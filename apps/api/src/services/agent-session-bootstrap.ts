import { eq } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { ulid } from '../lib/ulid';
import { buildSamBootstrapInstructions } from './agent-bootstrap-prompt';
import { buildSessionMcpServers } from './mcp-connection-resolution';
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
  type GuardedNodeAgentMutationOptions,
  restoreAgentSessionOnNode,
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
  agentProfileId?: string | null;
  skillId?: string | null;
  visibleInitialPrompt: string;
  /** Strictly load the saved harness snapshot instead of creating a fresh session. */
  restoreSnapshotChatSessionId?: string | null;
  promptKind: McpInstructionContextType;
  taskContext?: {
    taskId: string;
    taskMode: McpTaskMode;
    outputBranch?: string | null;
  } | null;
  overrides?: AgentSessionOverrides;
  existingMcpToken?: string | null;
  onAgentSessionId?: (agentSessionId: string) => Promise<void>;
  onMcpToken?: (mcpToken: string) => Promise<void>;
  /** Optional fail-closed gate run immediately before each durable/external mutation. */
  beforeExternalMutation?: () => Promise<void>;
  /** Internal recovery lineage revalidated inside Cloudflare Container requests. */
  sourceTaskGuard?: GuardedNodeAgentMutationOptions['sourceTaskGuard'];
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
  await input.beforeExternalMutation?.();
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

  if (existing[0]) {
    await db
      .update(schema.agentSessions)
      .set({
        status: 'running',
        errorMessage: null,
        agentProfileId: input.agentProfileId ?? undefined,
        skillId: input.skillId ?? undefined,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.agentSessions.id, agentSessionId));
    return;
  }

  const now = new Date().toISOString();
  await db.insert(schema.agentSessions).values({
    id: agentSessionId,
    workspaceId: input.workspaceId,
    userId: input.userId,
    status: 'running',
    label: input.label,
    agentType: input.agentType,
    agentProfileId: input.agentProfileId ?? null,
    skillId: input.skillId ?? null,
    createdAt: now,
    updatedAt: now,
  });
}

function shouldStartFreshAfterSnapshotRestore(restored: unknown): boolean {
  const restoreRecord =
    restored && typeof restored === 'object' ? (restored as Record<string, unknown>) : null;
  const status = restoreRecord?.status;
  if (status === 'restored') return false;
  if (status === 'degraded') return true;
  throw new Error(`Strict session restore failed (${String(status ?? 'unknown')})`);
}

async function createAcpSessionWithLogging(
  env: Env,
  input: SamAwareAgentStartInput,
  agentSessionId: string
): Promise<string | null> {
  try {
    return await runMaybePhased(input, 'create_acp_session', () =>
      ensureAcpSessionWithEnv(env, input, agentSessionId)
    );
  } catch (err) {
    log.error('agent_session_bootstrap.acp_session_create_failed', {
      projectId: input.projectId,
      chatSessionId: input.chatSessionId,
      agentSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function prepareAcpSessionForFreshStart(
  env: Env,
  input: SamAwareAgentStartInput,
  agentSessionId: string
): Promise<string> {
  try {
    const session = await runMaybePhased(input, 'prepare_acp_session_fresh_start', () =>
      projectDataService.prepareAcpSessionForFreshStart(env, input.projectId, agentSessionId, {
        actorType: input.actor.type,
        actorId: input.actor.id,
        reason: `${input.actor.reasonPrefix} prepared fresh start after degraded snapshot restore`,
        workspaceId: input.workspaceId,
        nodeId: input.nodeId,
        metadata: {
          chatSessionId: input.chatSessionId ?? null,
          restoreSnapshotChatSessionId: input.restoreSnapshotChatSessionId ?? null,
        },
      })
    );
    return session.id;
  } catch (err) {
    log.error('agent_session_bootstrap.acp_session_prepare_fresh_start_failed', {
      projectId: input.projectId,
      chatSessionId: input.chatSessionId,
      agentSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

async function transitionAcpSessionToRunning(
  env: Env,
  input: SamAwareAgentStartInput,
  acpSessionId: string,
  agentSessionId: string,
  allowSnapshotRestoreRecovery: boolean
): Promise<void> {
  const transition = () =>
    projectDataService.transitionAcpSession(env, input.projectId, acpSessionId, 'running', {
      actorType: input.actor.type,
      actorId: input.actor.id,
      reason: `${input.actor.reasonPrefix} started`,
      acpSdkSessionId: agentSessionId,
    });

  try {
    await runMaybePhased(input, 'mark_acp_session_running', transition);
    return;
  } catch (err) {
    if (!allowSnapshotRestoreRecovery) throw err;
    const existing = await projectDataService
      .getAcpSession(env, input.projectId, acpSessionId)
      .catch(() => null);
    if (existing?.status !== 'failed') throw err;
    log.warn('agent_session_bootstrap.acp_session_failed_before_restore_running_retry', {
      projectId: input.projectId,
      chatSessionId: input.chatSessionId,
      agentSessionId,
      acpSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    await prepareAcpSessionForFreshStart(env, input, agentSessionId);
    await runMaybePhased(input, 'mark_acp_session_running_after_restore_repair', transition);
  }
}

export async function startSamAwareAgentSession(
  db: Db,
  env: Env,
  input: SamAwareAgentStartInput
): Promise<SamAwareAgentStartResult> {
  const agentSessionId = input.agentSessionId || ulid();
  const generatedMcpToken = !input.existingMcpToken;
  const mcpToken = input.existingMcpToken || generateMcpToken();
  const guardedMutationOptions =
    input.sourceTaskGuard || input.beforeExternalMutation
      ? {
          sourceTaskGuard: input.sourceTaskGuard,
          beforeExternalMutation: input.beforeExternalMutation,
        }
      : undefined;

  try {
    await runMaybePhased(input, 'create_agent_session_row', () =>
      ensureAgentSessionRow(db, input, agentSessionId)
    );
    await input.onAgentSessionId?.(agentSessionId);

    if (generatedMcpToken) {
      await runMaybePhased(input, 'store_mcp_token', () =>
        storeMcpToken(
          env.KV,
          mcpToken,
          {
            taskId: input.taskContext?.taskId ?? '',
            contextType: input.promptKind,
            taskMode:
              input.taskContext?.taskMode ??
              (input.promptKind === 'conversation' ? 'conversation' : undefined),
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
      await input.onMcpToken?.(mcpToken);
    }

    // Resolved once and reused by both the create and start calls below. This is the single
    // injection point shared by BOTH runtimes — the VM path (task-runner/agent-session-step)
    // and the cf-container Instant path (instant-session.ts) both funnel through here, so a
    // change made once applies to both (rule 61).
    const sessionMcpServers = await buildSessionMcpServers(
      db,
      { baseDomain: env.BASE_DOMAIN, encryptionKey: getCredentialEncryptionKey(env) },
      { userId: input.userId, projectId: input.projectId },
      mcpToken
    );

    await runMaybePhased(input, 'create_vm_agent_session', () => {
      const args = [
        input.nodeId,
        input.workspaceId,
        agentSessionId,
        input.label,
        env,
        input.userId,
        input.chatSessionId ?? undefined,
        input.projectId,
        sessionMcpServers,
      ] as const;
      return guardedMutationOptions
        ? createAgentSessionOnNode(...args, guardedMutationOptions)
        : createAgentSessionOnNode(...args);
    });

    let acpSessionId = await createAcpSessionWithLogging(env, input, agentSessionId);

    let shouldStartFreshSession = true;
    const restoreSnapshotChatSessionId = input.restoreSnapshotChatSessionId;
    if (restoreSnapshotChatSessionId) {
      const restored = await runMaybePhased(input, 'restore_acp_session', () => {
        const args = [
          input.nodeId,
          input.workspaceId,
          agentSessionId,
          env,
          input.userId,
          {
            chatSessionId: restoreSnapshotChatSessionId,
            runtime: 'vm',
            agentType: input.agentType,
          },
        ] as const;
        return guardedMutationOptions
          ? restoreAgentSessionOnNode(...args, guardedMutationOptions)
          : restoreAgentSessionOnNode(...args);
      });
      shouldStartFreshSession = shouldStartFreshAfterSnapshotRestore(restored);
      if (shouldStartFreshSession) {
        log.warn('agent_session_bootstrap.snapshot_restore_degraded_starting_fresh', {
          projectId: input.projectId,
          chatSessionId: input.chatSessionId,
          restoreSnapshotChatSessionId,
          workspaceId: input.workspaceId,
          agentSessionId,
        });
        if (!acpSessionId) {
          acpSessionId = await createAcpSessionWithLogging(env, input, agentSessionId);
        }
        if (acpSessionId) {
          acpSessionId = await prepareAcpSessionForFreshStart(env, input, agentSessionId);
        }
      }
    }

    if (shouldStartFreshSession) {
      const injectedInstructions = buildSamBootstrapInstructions({ contextType: input.promptKind });
      await runMaybePhased(input, 'start_acp_session', () => {
        const args = [
          input.nodeId,
          input.workspaceId,
          agentSessionId,
          input.agentType,
          input.visibleInitialPrompt,
          env,
          input.userId,
          sessionMcpServers,
          input.overrides,
          input.taskContext
            ? {
                projectId: input.projectId,
                taskId: input.taskContext.taskId,
                taskMode: input.taskContext.taskMode,
              }
            : undefined,
          injectedInstructions,
        ] as const;
        return guardedMutationOptions
          ? startAgentSessionOnNode(...args, guardedMutationOptions)
          : startAgentSessionOnNode(...args);
      });
    }

    const runningAcpSessionId = acpSessionId;
    if (runningAcpSessionId) {
      await transitionAcpSessionToRunning(
        env,
        input,
        runningAcpSessionId,
        agentSessionId,
        Boolean(restoreSnapshotChatSessionId)
      );
    }
    if (restoreSnapshotChatSessionId) {
      await runMaybePhased(input, 'reset_agent_session_row_after_snapshot_restore', () =>
        ensureAgentSessionRow(db, input, agentSessionId)
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

  const existing = await projectDataService
    .getAcpSession(env, input.projectId, agentSessionId)
    .catch(() => null);
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
