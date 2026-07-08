import type { SessionStateSnapshot } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { log } from '../lib/logger';
import * as projectDataService from '../services/project-data';

interface ResolveChatAgentStateInput {
  projectId: string;
  sessionId: string;
  lookupFailureEvent: string;
  stateFailureEvent?: string;
}

async function resolveChatAgentState(
  env: Env,
  input: ResolveChatAgentStateInput
): Promise<{
  agentSessionId: string | null;
  agentType: string | null;
  state: SessionStateSnapshot | null;
}> {
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

  let state: SessionStateSnapshot | null = null;
  if (agentSessionId) {
    try {
      state = await projectDataService.getSessionState(env, input.projectId, agentSessionId);
    } catch (err) {
      if (input.stateFailureEvent) {
        log.warn(input.stateFailureEvent, {
          projectId: input.projectId,
          sessionId: input.sessionId,
          agentSessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  let chatSessionState: SessionStateSnapshot | null = null;
  if (!state || agentSessionId !== input.sessionId) {
    try {
      chatSessionState = await projectDataService.getSessionState(env, input.projectId, input.sessionId);
      state = state ?? chatSessionState;
    } catch (err) {
      if (input.stateFailureEvent) {
        log.warn(input.stateFailureEvent, {
          projectId: input.projectId,
          sessionId: input.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  try {
    const persistedPlan = await projectDataService.getLatestPersistedPlan(
      env,
      input.projectId,
      input.sessionId,
    );
    const planSource = persistedPlan ?? (
      chatSessionState?.currentPlan
        ? { currentPlan: chatSessionState.currentPlan, planUpdatedAt: chatSessionState.planUpdatedAt }
        : null
    );

    if (planSource) {
      state = {
        activity: state?.activity ?? 'idle',
        activityAt: state?.activityAt ?? 0,
        statusError: state?.statusError ?? null,
        promptStartedAt: state?.promptStartedAt ?? null,
        agentType: state?.agentType ?? null,
        lastStopReason: state?.lastStopReason ?? null,
        currentPlan: planSource.currentPlan,
        planUpdatedAt: planSource.planUpdatedAt,
      };
    }
  } catch (err) {
    if (input.stateFailureEvent) {
      log.warn(input.stateFailureEvent, {
        projectId: input.projectId,
        sessionId: input.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { agentSessionId, agentType, state };
}

export { resolveChatAgentState };
