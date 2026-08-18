import type { SessionStateSnapshot } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { log } from '../lib/logger';
import * as projectDataService from '../services/project-data';

type PersistedPlan = Awaited<ReturnType<typeof projectDataService.getLatestPersistedPlan>>;

interface ResolveChatAgentStateInput {
  projectId: string;
  sessionId: string;
  lookupFailureEvent: string;
  stateFailureEvent?: string;
}

/**
 * Resolve the live agent state for a chat session.
 *
 * Costs two sequential Durable Object hops:
 *
 *   hop 1 — `listAcpSessions`, which everything else keys off.
 *   hop 2 — the ACP session state, the chat session state and the persisted plan,
 *           issued concurrently.
 *
 * The chat-session state lookup is issued exactly when the original sequential
 * implementation would have issued it. Its guard read
 * `if (!state || agentSessionId !== input.sessionId)`, which looks like it
 * depends on hop 2's own result, but does not:
 *
 *   - `agentSessionId !== input.sessionId` (including `agentSessionId === null`)
 *     makes the second disjunct true, so the lookup runs regardless of `state`.
 *   - `agentSessionId === input.sessionId` with a truthy `state` skips it, leaving
 *     `chatSessionState` null.
 *   - `agentSessionId === input.sessionId` with a falsy `state` runs it — but that
 *     is the *same* read-only call as the ACP state lookup, so it returns the same
 *     nullish value and `chatSessionState` still ends up null. (This branch is
 *     unreachable in practice: `agentSessionId` is an ACP session ULID while
 *     `input.sessionId` is a chat session ULID. Skipping the duplicate read gives
 *     up only the chance that a concurrent write lands between two back-to-back
 *     reads of the same row — the following poll picks that up regardless.)
 *
 * So its observable contribution is non-null only when
 * `agentSessionId !== input.sessionId`, which hop 1 alone decides.
 *
 * Keeping `chatSessionState` null in the other cases matters: the plan merge below
 * rebuilds the snapshot field-by-field and omits the optional `activitySource` /
 * `activityReason` members, so populating it where the original did not would
 * silently drop them.
 *
 * Concurrency (see .claude/rules/45): every call here is read-only and this
 * function performs no writes at all, so there is no check-then-act section to
 * race. Grouping the plan read with the state reads also tightens the snapshot
 * relative to the original, which read the plan strictly last.
 */
async function resolveChatAgentState(
  env: Env,
  input: ResolveChatAgentStateInput
): Promise<{
  agentSessionId: string | null;
  agentType: string | null;
  state: SessionStateSnapshot | null;
}> {
  const logStateFailure = (err: unknown, extra?: Record<string, unknown>) => {
    if (!input.stateFailureEvent) return;
    log.warn(input.stateFailureEvent, {
      projectId: input.projectId,
      sessionId: input.sessionId,
      ...extra,
      error: err instanceof Error ? err.message : String(err),
    });
  };

  /**
   * Invoke a DO read and degrade to `fallback` on failure. The invocation itself
   * sits inside the try because the sequential implementation wrapped the *call*,
   * not just its promise — a service function that throws synchronously must
   * degrade too, rather than rejecting the whole concurrent batch.
   */
  const safeRead = async <T>(
    call: () => Promise<T>,
    fallback: T,
    onError: (err: unknown) => void
  ): Promise<T> => {
    try {
      return await call();
    } catch (err) {
      onError(err);
      return fallback;
    }
  };

  // Hop 1 — the ACP session lookup decides which of the hop-2 reads are needed.
  let agentSessionId: string | null = null;
  let agentType: string | null = null;
  try {
    const acpSessions = await projectDataService.listAcpSessions(env, input.projectId, {
      chatSessionId: input.sessionId,
      limit: 1,
    });
    agentSessionId = acpSessions.sessions[0]?.id ?? null;
    agentType = acpSessions.sessions[0]?.agentType ?? null;
  } catch (err) {
    log.warn(input.lookupFailureEvent, {
      projectId: input.projectId,
      sessionId: input.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Hop 2 — independent reads issued concurrently. Each keeps its own failure
  // handling so one rejection cannot suppress the others, matching the separate
  // try/catch blocks of the sequential implementation.
  const needsChatSessionState = agentSessionId !== input.sessionId;

  const [agentSessionState, chatSessionState, persistedPlan] = await Promise.all([
    agentSessionId
      ? safeRead<SessionStateSnapshot | null>(
          () => projectDataService.getSessionState(env, input.projectId, agentSessionId),
          null,
          (err) => logStateFailure(err, { agentSessionId })
        )
      : Promise.resolve(null),
    needsChatSessionState
      ? safeRead<SessionStateSnapshot | null>(
          () => projectDataService.getSessionState(env, input.projectId, input.sessionId),
          null,
          (err) => logStateFailure(err)
        )
      : Promise.resolve(null),
    safeRead<{ ok: boolean; plan: PersistedPlan }>(
      async () => ({
        ok: true,
        plan: await projectDataService.getLatestPersistedPlan(
          env,
          input.projectId,
          input.sessionId
        ),
      }),
      { ok: false, plan: null },
      (err) => logStateFailure(err)
    ),
  ]);

  let state: SessionStateSnapshot | null = agentSessionState ?? chatSessionState;

  // A failed plan lookup skips the whole merge, including the chat-session-state
  // fallback — the sequential implementation wrapped the lookup, the fallback and
  // the rebuild in a single try block.
  const planSource = !persistedPlan.ok
    ? null
    : (persistedPlan.plan ??
      (chatSessionState?.currentPlan
        ? {
            currentPlan: chatSessionState.currentPlan,
            planUpdatedAt: chatSessionState.planUpdatedAt,
          }
        : null));

  if (planSource) {
    state = {
      activity: state?.activity ?? 'idle',
      activityAt: state?.activityAt ?? 0,
      statusError: state?.statusError ?? null,
      promptStartedAt: state?.promptStartedAt ?? null,
      agentType: state?.agentType ?? null,
      lastStopReason: state?.lastStopReason ?? null,
      runtimeWorkState: state?.runtimeWorkState ?? null,
      runtimeWorkCount: state?.runtimeWorkCount ?? null,
      runtimeWorkSource: state?.runtimeWorkSource ?? null,
      runtimeWorkUpdatedAt: state?.runtimeWorkUpdatedAt ?? null,
      runtimeWorkProgressAt: state?.runtimeWorkProgressAt ?? null,
      currentPlan: planSource.currentPlan,
      planUpdatedAt: planSource.planUpdatedAt,
    };
  }

  return { agentSessionId, agentType, state };
}

export { resolveChatAgentState };
