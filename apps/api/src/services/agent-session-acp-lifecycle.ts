/**
 * ProjectData ACP-session bookkeeping for `startSamAwareAgentSession`
 * (`agent-session-bootstrap.ts`): create the chat's ACP session, reset it for a fresh start
 * after a snapshot restore that could not resume the saved agent, and mark it running.
 */
import type { Env } from '../env';
import { log } from '../lib/logger';
import type { SamAwareAgentStartInput } from './agent-session-bootstrap';
import * as projectDataService from './project-data';

export async function runMaybePhased<T>(
  input: SamAwareAgentStartInput,
  name: string,
  fn: () => Promise<T>
): Promise<T> {
  await input.beforeExternalMutation?.();
  return input.runPhase ? input.runPhase(name, fn) : fn();
}

export async function createAcpSessionWithLogging(
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

/** Why a snapshot wake starts the agent fresh instead of resuming its saved session. */
export type FreshStartReason = 'degraded_restore' | 'transcript_only';

/**
 * The chat notice for a fresh start. Neither claims an exact restore (policy 2adacc8f); the
 * transcript-only one also says that no files came back, because none did.
 */
const FRESH_START_NOTICES: Record<FreshStartReason, string> = {
  degraded_restore:
    'SAM restored this sleeping conversation from a degraded snapshot, so the agent is starting fresh and will read the persisted transcript before continuing.',
  transcript_only:
    "SAM could not restore this conversation's workspace: its last sleep saved no snapshot or Git recovery point. The agent is starting fresh in a new checkout and will read the persisted transcript before continuing. Files and uncommitted work from the previous workspace were not restored.",
};

export async function prepareAcpSessionForFreshStart(
  env: Env,
  input: SamAwareAgentStartInput,
  agentSessionId: string,
  reason: FreshStartReason = 'degraded_restore'
): Promise<string> {
  try {
    if (input.chatSessionId) {
      await projectDataService.persistMessage(
        env,
        input.projectId,
        input.chatSessionId,
        'system',
        FRESH_START_NOTICES[reason],
        null,
        `degraded-wake-${agentSessionId}`
      );
    }
    const session = await runMaybePhased(input, 'prepare_acp_session_fresh_start', () =>
      projectDataService.prepareAcpSessionForFreshStart(env, input.projectId, agentSessionId, {
        actorType: input.actor.type,
        actorId: input.actor.id,
        reason:
          reason === 'transcript_only'
            ? `${input.actor.reasonPrefix} prepared fresh start after transcript-only sleep fallback`
            : `${input.actor.reasonPrefix} prepared fresh start after degraded snapshot restore`,
        workspaceId: input.workspaceId,
        nodeId: input.nodeId,
        metadata: {
          chatSessionId: input.chatSessionId ?? null,
          restoreSnapshotChatSessionId: input.restoreSnapshotChatSessionId ?? null,
          freshStartReason: reason,
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

export async function transitionAcpSessionToRunning(
  env: Env,
  input: SamAwareAgentStartInput,
  acpSessionId: string,
  agentSessionId: string,
  /**
   * Set after a snapshot restore: a failed ACP session may then be reset and retried, and the
   * reset re-persists the fresh-start notice for this reason. It must be the reason the start
   * already used, because that notice's message id is reused and a different text is refused.
   */
  snapshotRestoreRepair: FreshStartReason | null
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
    if (!snapshotRestoreRepair) throw err;
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
    await prepareAcpSessionForFreshStart(env, input, agentSessionId, snapshotRestoreRepair);
    await runMaybePhased(input, 'mark_acp_session_running_after_restore_repair', transition);
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
