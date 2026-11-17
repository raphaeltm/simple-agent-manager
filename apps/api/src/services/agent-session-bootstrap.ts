import { and, eq } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { maybeJsonRecord } from '../lib/runtime-validation';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { ulid } from '../lib/ulid';
import { buildSamBootstrapInstructions } from './agent-bootstrap-prompt';
import {
  createAcpSessionWithLogging,
  type FreshStartReason,
  prepareAcpSessionForFreshStart,
  runMaybePhased,
  transitionAcpSessionToRunning,
} from './agent-session-acp-lifecycle';
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
import {
  loadSnapshotRuntimeContract,
  parseSessionRuntimeContract,
  resolveSessionRuntimeContract,
} from './session-runtime-contract';
import { TRANSCRIPT_ONLY_SLEEP_FALLBACK_REASON } from './session-snapshot-restore-response';

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
  /** Untrusted archived data; separate from the visible user prompt and permissions. */
  historicalContext?: string | null;
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
  /**
   * Whether `visibleInitialPrompt` reached the agent. False only when a snapshot restore resumed
   * the saved agent session (LoadSession): that session never receives it, so a caller with nothing
   * queued must deliver the wake's first prompt itself (`services/restored-session-prompt.ts`).
   */
  initialPromptSent: boolean;
  /**
   * Outcome of the snapshot restore this start ran, if any. `degraded` covers every restore
   * failure the VM agent reports (HOME, WIP or git, not only the agent context) and a
   * transcript-only sleep fallback that had no files to restore, so only
   * `restored` proves the replacement holds the snapshot's files.
   */
  snapshotRestore?: 'restored' | 'degraded';
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

/**
 * What the VM agent's restore (`restoreSessionSnapshot` in
 * `packages/vm-agent/internal/server/session_snapshot_restore.go`) leaves the wake to do:
 * - `restored`: the saved agent session was loaded; do not start a new one.
 * - `degraded`: the files or the agent context could not all come back; start fresh.
 * - `transcript-replay` with `transcript_only_sleep_fallback`: the bounded sleep fallback saved
 *   no recovery point, so there was nothing to restore (`sessionSnapshotRestoreResponse`). The
 *   workspace is the fresh checkout create-workspace provisioned and the agent session is
 *   untouched, so start fresh from the transcript (policy a3780107). The recovery task already
 *   carries the transcript-only wake prompt (`sessionRecoveryInitialPrompt`).
 * Anything else fails the wake. That includes `transcript-replay` for a snapshot that vanished
 * after the wake claimed it (`snapshot_missing_or_unavailable`), which this does not cover.
 */
function snapshotRestoreOutcome(restored: unknown): 'restored' | FreshStartReason {
  const restoreRecord = maybeJsonRecord(restored);
  const status = restoreRecord?.status;
  if (status === 'restored') return 'restored';
  if (status === 'degraded') return 'degraded_restore';
  const reason = restoreRecord?.reason;
  if (status === 'transcript-replay' && reason === TRANSCRIPT_ONLY_SLEEP_FALLBACK_REASON) {
    return 'transcript_only';
  }
  const detail = typeof reason === 'string' && reason ? `: ${reason.slice(0, 80)}` : '';
  throw new Error(`Strict session restore failed (${String(status ?? 'unknown')}${detail})`);
}

export async function startSamAwareAgentSession(
  db: Db,
  env: Env,
  input: SamAwareAgentStartInput
): Promise<SamAwareAgentStartResult> {
  const savedRow = input.agentSessionId
    ? await db
        .select({ runtimeContractJson: schema.agentSessions.runtimeContractJson })
        .from(schema.agentSessions)
        .where(
          and(
            eq(schema.agentSessions.id, input.agentSessionId),
            eq(schema.agentSessions.userId, input.userId),
            eq(schema.agentSessions.workspaceId, input.workspaceId)
          )
        )
        .get()
    : null;
  const savedContract = input.restoreSnapshotChatSessionId
    ? await loadSnapshotRuntimeContract(
        db,
        input.projectId,
        input.userId,
        input.restoreSnapshotChatSessionId
      )
    : parseSessionRuntimeContract(savedRow?.runtimeContractJson);
  const contract =
    savedContract ??
    (await resolveSessionRuntimeContract(db, env, {
      ...input,
      // Historical sessions lack proof of their original permission mode. Never silently grant bypass.
      overrides: input.restoreSnapshotChatSessionId
        ? { ...input.overrides, permissionMode: 'default' }
        : input.overrides,
    }));
  if (contract.taskContext && contract.taskContext.projectId !== input.projectId)
    throw new Error('Session runtime contract project mismatch');
  if (
    contract.taskContext &&
    input.taskContext &&
    contract.taskContext.taskId !== input.taskContext.taskId
  ) {
    throw new Error('Session runtime contract task identity mismatch');
  }
  input = {
    ...input,
    agentType: contract.agentType,
    overrides: contract,
    promptKind: contract.promptKind,
    taskContext: contract.taskContext ? { ...input.taskContext, ...contract.taskContext } : null,
  };
  const agentSessionId = input.agentSessionId || ulid();
  const generatedMcpToken = !input.existingMcpToken;
  const mcpToken = input.existingMcpToken || generateMcpToken();
  let mcpTokenHandedOff = false;
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
    await runMaybePhased(input, 'persist_runtime_contract', () =>
      db
        .update(schema.agentSessions)
        .set({ runtimeContractJson: JSON.stringify(contract) })
        .where(eq(schema.agentSessions.id, agentSessionId))
    );
    await input.onAgentSessionId?.(agentSessionId);

    if (generatedMcpToken) {
      // The runtime this session starts on: an MCP token from another generation is refused.
      const workspaceGeneration = await db
        .select({ callbackGeneration: schema.workspaces.callbackGeneration })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, input.workspaceId))
        .get();
      const callbackGeneration = workspaceGeneration?.callbackGeneration ?? null;
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
            callbackGeneration,
            createdAt: new Date().toISOString(),
          },
          env
        )
      );
      if (input.onMcpToken) {
        await input.onMcpToken(mcpToken);
        mcpTokenHandedOff = true;
      }
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
            runtimeContract: contract,
          },
        ] as const;
        return guardedMutationOptions
          ? restoreAgentSessionOnNode(...args, guardedMutationOptions)
          : restoreAgentSessionOnNode(...args);
      });
      const restoreOutcome = snapshotRestoreOutcome(restored);
      shouldStartFreshSession = restoreOutcome !== 'restored';
      if (restoreOutcome !== 'restored') {
        log.warn('agent_session_bootstrap.snapshot_restore_degraded_starting_fresh', {
          projectId: input.projectId,
          chatSessionId: input.chatSessionId,
          restoreSnapshotChatSessionId,
          workspaceId: input.workspaceId,
          agentSessionId,
          restoreOutcome,
        });
        if (!acpSessionId) {
          acpSessionId = await createAcpSessionWithLogging(env, input, agentSessionId);
        }
        if (acpSessionId) {
          acpSessionId = await prepareAcpSessionForFreshStart(
            env,
            input,
            agentSessionId,
            restoreOutcome
          );
        }
      }
    }

    if (shouldStartFreshSession) {
      const injectedInstructions = [
        buildSamBootstrapInstructions({ contextType: input.promptKind }),
        input.historicalContext,
      ]
        .filter(Boolean)
        .join('\n\n');
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
          guardedMutationOptions,
          contract.acpInteractions,
        ] as const;
        return startAgentSessionOnNode(...args);
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
      initialPromptSent: shouldStartFreshSession,
      ...(restoreSnapshotChatSessionId
        ? { snapshotRestore: shouldStartFreshSession ? 'degraded' : 'restored' }
        : {}),
    };
  } catch (err) {
    // Once persisted by the caller, the token belongs to its retry lifecycle.
    if (generatedMcpToken && !mcpTokenHandedOff) {
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
