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
  state: Awaited<ReturnType<typeof projectDataService.getSessionState>> | null;
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

  let state: Awaited<ReturnType<typeof projectDataService.getSessionState>> | null = null;
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

  return { agentSessionId, agentType, state };
}

export { resolveChatAgentState };
