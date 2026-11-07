import type { AgentEffort, AgentProfile, AgentSkill } from '@simple-agent-manager/shared';
import { isAgentEffortSupported } from '@simple-agent-manager/shared';

/**
 * Model and effort chosen for one new chat. They are recorded with the agent they were picked
 * for: a Codex model means nothing to Claude, so switching to a profile or skill that runs a
 * different agent drops them instead of sending a value that agent cannot use.
 */
export interface ChatAgentOverrides {
  agentType: string | null;
  /** Blank means "use the default". */
  model: string;
  /** Null means "use the default". */
  effort: AgentEffort | null;
}

export const EMPTY_CHAT_AGENT_OVERRIDES: ChatAgentOverrides = {
  agentType: null,
  model: '',
  effort: null,
};

/** What this chat would run with if nothing were overridden. */
export interface ChatAgentDefaults {
  agentType: string | null;
  model: string | null;
  effort: AgentEffort | null;
}

/**
 * The agent, model and effort a chat inherits, in the server's order (`resolveSkillProfile`):
 * a skill's values win over the profile's, and a skill effort the agent can't run is dropped.
 */
export function chatAgentDefaults(
  profile: Pick<AgentProfile, 'agentType' | 'model' | 'effort'> | null,
  skill: Pick<AgentSkill, 'agentType' | 'model' | 'effort'> | null
): ChatAgentDefaults {
  const agentType = skill?.agentType || profile?.agentType || null;
  const skillEffort =
    agentType && skill?.effort && isAgentEffortSupported(agentType, skill.effort)
      ? skill.effort
      : null;
  return {
    agentType,
    model: skill?.model || profile?.model || null,
    effort: skillEffort ?? profile?.effort ?? null,
  };
}

/** The overrides that still apply to `agentType`; null means "send nothing, inherit". */
export function activeChatAgentOverrides(
  overrides: ChatAgentOverrides,
  agentType: string | null
): { model: string | null; effort: AgentEffort | null } {
  if (!agentType || overrides.agentType !== agentType) return { model: null, effort: null };
  return {
    model: overrides.model.trim() || null,
    effort:
      overrides.effort && isAgentEffortSupported(agentType, overrides.effort)
        ? overrides.effort
        : null,
  };
}
