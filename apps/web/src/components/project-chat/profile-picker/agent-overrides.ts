import type { AgentEffort, AgentProfile, AgentSkill } from '@simple-agent-manager/shared';
import { isAgentEffortSupported } from '@simple-agent-manager/shared';

/**
 * Model, effort and account chosen for one new chat. They are recorded with the agent they
 * were picked for: a Codex model or a ChatGPT account means nothing to Claude, so switching to
 * a profile or skill that runs a different agent clears them (`ChatInput`) instead of sending
 * a value that agent cannot use.
 */
export interface ChatAgentOverrides {
  agentType: string | null;
  /** Blank means "use the default". */
  model: string;
  /** Null means "use the default". */
  effort: AgentEffort | null;
  /** The account (`cc_configurations.id`) this chat runs on; blank means the profile's. */
  accountId: string;
}

export const EMPTY_CHAT_AGENT_OVERRIDES: ChatAgentOverrides = {
  agentType: null,
  model: '',
  effort: null,
  accountId: '',
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
  // An inherited effort the chat's agent can't run is dropped, as the API does
  // (`resolveTaskAgentOverrides`): a skill can switch a Claude/max profile to Codex.
  const runnable = (effort: AgentEffort | null | undefined) =>
    agentType && effort && isAgentEffortSupported(agentType, effort) ? effort : null;
  return {
    agentType,
    model: skill?.model || profile?.model || null,
    effort: runnable(skill?.effort) ?? runnable(profile?.effort),
  };
}

/** The overrides that still apply to `agentType`; null means "send nothing, inherit". */
export function activeChatAgentOverrides(
  overrides: ChatAgentOverrides,
  agentType: string | null
): { model: string | null; effort: AgentEffort | null; accountId: string | null } {
  if (!agentType || overrides.agentType !== agentType) {
    return { model: null, effort: null, accountId: null };
  }
  return {
    model: overrides.model.trim() || null,
    effort:
      overrides.effort && isAgentEffortSupported(agentType, overrides.effort)
        ? overrides.effort
        : null,
    accountId: overrides.accountId || null,
  };
}

/** The same overrides with the account for `agentType` set (or cleared with null). */
export function withChatAccount(
  overrides: ChatAgentOverrides,
  agentType: string,
  accountId: string | null
): ChatAgentOverrides {
  const sameAgent = overrides.agentType === agentType;
  return {
    agentType,
    model: sameAgent ? overrides.model : '',
    effort: sameAgent ? overrides.effort : null,
    accountId: accountId ?? '',
  };
}

/** The agent, model and effort a chat will launch with: overrides over its defaults. */
export function effectiveChatAgent(
  defaults: ChatAgentDefaults,
  overrides: ChatAgentOverrides
): ChatAgentDefaults {
  const active = activeChatAgentOverrides(overrides, defaults.agentType);
  return {
    agentType: defaults.agentType,
    model: active.model ?? defaults.model,
    effort: active.effort ?? defaults.effort,
  };
}
