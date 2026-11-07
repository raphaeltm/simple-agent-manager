import type { AgentEffort, AgentProfile, AgentSkill } from '@simple-agent-manager/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  activeChatAgentOverrides,
  chatAgentDefaults,
  type ChatAgentOverrides,
  EMPTY_CHAT_AGENT_OVERRIDES,
} from '../../components/project-chat/profile-picker/agent-overrides';
import {
  EMPTY_RESOURCE_STATE,
  hasAnyResourceValue,
  hasValidationErrors,
  type ResourceRequirementsFormState,
  type ResourceValidationErrors,
  validateResourceState,
} from '../../components/resource-requirements';

/**
 * One-chat overrides set under Chat options: resources, model and effort. Blank values inherit
 * from the profile/project. Cleared on project switch, New chat and after a successful send.
 */
export function useComposerOverrides(projectId: string) {
  const [taskResourceReqs, setTaskResourceReqs] = useState<ResourceRequirementsFormState>({
    ...EMPTY_RESOURCE_STATE,
  });
  const [taskResourceErrors, setTaskResourceErrors] = useState<ResourceValidationErrors>({});
  const [agentOverrides, setAgentOverrides] = useState<ChatAgentOverrides>(
    EMPTY_CHAT_AGENT_OVERRIDES
  );

  const resetComposerOverrides = useCallback(() => {
    setTaskResourceReqs({ ...EMPTY_RESOURCE_STATE });
    setTaskResourceErrors({});
    setAgentOverrides(EMPTY_CHAT_AGENT_OVERRIDES);
  }, []);

  /** Surfaces per-field resource errors in the panel; false blocks the send. */
  const validateTaskResources = useCallback((): boolean => {
    const errors = hasAnyResourceValue(taskResourceReqs)
      ? validateResourceState(taskResourceReqs)
      : {};
    setTaskResourceErrors(errors);
    return !hasValidationErrors(errors);
  }, [taskResourceReqs]);

  /** Request fields for the model/effort still valid for the agent this chat will run. */
  const agentOverrideFields = useCallback(
    (
      profile: AgentProfile | null,
      skill: AgentSkill | null
    ): { model?: string; effort?: AgentEffort } => {
      const { model, effort } = activeChatAgentOverrides(
        agentOverrides,
        chatAgentDefaults(profile, skill).agentType
      );
      return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
    },
    [agentOverrides]
  );

  const prevProjectIdRef = useRef(projectId);
  useEffect(() => {
    if (prevProjectIdRef.current !== projectId) {
      prevProjectIdRef.current = projectId;
      resetComposerOverrides();
    }
  }, [projectId, resetComposerOverrides]);

  return {
    taskResourceReqs,
    setTaskResourceReqs,
    taskResourceErrors,
    setTaskResourceErrors,
    agentOverrides,
    setAgentOverrides,
    resetComposerOverrides,
    validateTaskResources,
    agentOverrideFields,
  };
}
